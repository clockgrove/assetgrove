import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ProviderSet, suggestRoles } from "../src/providers/index.ts";
import {
  defaultRoutes,
  GATEWAY_DEFAULT_ROUTES,
  resolveRoute,
  RouteUnavailableError,
} from "../src/routes.ts";
import type { Settings } from "../src/settings.ts";
import type { Provenance } from "../src/types.ts";
import { writeSettings } from "./fixtures/env.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["src/cli.ts", ...args], { cwd: root }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

async function stageArgs(): Promise<string[]> {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  return [
    "stage",
    ...["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir],
    ...["--candidates", "1", "--provider-script", passingScript, "--json"],
  ];
}

const LIMIT = { kind: "prepaid", usd: 100 };

/** Settings of the given providers, roles and routes, as ProviderSet reads them. */
function settingsOf(
  providers: Settings["providers"],
  extra: { roles?: Settings["roles"]; routes?: Settings["routes"] } = {},
): Pick<Settings, "providers" | "roles" | "routes" | "path"> {
  return { providers, roles: extra.roles ?? {}, routes: extra.routes ?? {}, path: "settings.json" };
}

test("a role no configured provider serves exits 2 route_unavailable with no ledger entry", async () => {
  // Tripo serves only the 3D roles; a sprite strip needs the edit and vision roles.
  for (const settings of [
    { providers: { tripo: { limit: LIMIT } } },
    {
      providers: { scripted: { limit: LIMIT }, tripo: { limit: LIMIT } },
      roles: { edit: { provider: "tripo", model: "tripo/v2.5-20250123" } },
    },
  ]) {
    const stateDir = await mkdtemp(join(tmpdir(), "assetgrove-routes-"));
    writeSettings({ stateDir, ...settings });
    const r = await cli(await stageArgs());
    assert.equal(r.code, 2, r.stderr);
    const document = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    assert.equal(document.error.code, "route_unavailable");
    assert.match(document.error.message, /edit operation \(role edit\)/);
    assert.match(document.error.message, /settings\.routes\.edit or settings\.roles\.edit/);
    assert.equal(existsSync(join(stateDir, "spend.jsonl")), false, "no ledger entry");
  }
});

test("overriding only the model of a gateway route resolves with no outputGrant and no providerTerms; an override with its own keeps them", () => {
  const providers = { gateway: { adapter: "vercel-ai-gateway" } };
  const plain = ProviderSet.fromSettings(settingsOf(providers), { env: {} }).routes;
  assert.equal(plain.edit.provider, "gateway");
  assert.equal(plain.edit.model, defaultRoutes.edit.model);
  assert.deepEqual(plain.edit.outputGrant, defaultRoutes.edit.outputGrant);
  assert.equal(plain.edit.providerTerms, defaultRoutes.edit.providerTerms);

  const model = "bfl/flux-kontext-max";
  for (const extra of [
    { routes: { edit: { provider: "gateway", model } } },
    { roles: { edit: { provider: "gateway", model } } },
  ]) {
    const route = ProviderSet.fromSettings(settingsOf(providers, extra), { env: {} }).routes.edit;
    assert.equal(route.provider, "gateway");
    assert.equal(route.model, model);
    assert.equal(route.outputGrant, undefined);
    assert.equal(route.providerTerms, undefined);
    // The rest of the default (the estimate, the seed support) still applies.
    assert.equal(route.estimatedCostUsd, defaultRoutes.edit.estimatedCostUsd);
  }

  const grant = { license: "LicenseRef-bfl-api", plan: "api", commercial: true, relabel: true };
  const own = ProviderSet.fromSettings(
    settingsOf(providers, {
      routes: {
        edit: { provider: "gateway", model, outputGrant: grant, providerTerms: "BFL API terms" },
      },
    }),
    { env: {} },
  ).routes.edit;
  assert.deepEqual(own.outputGrant, grant);
  assert.equal(own.providerTerms, "BFL API terms");

  // Naming the default's own provider and model keeps its grant and terms.
  const same = resolveRoute(
    settingsOf(providers, { roles: { edit: { provider: "gateway", model: plain.edit.model } } }),
    "edit",
    [
      {
        id: "gateway",
        adapter: {
          id: "vercel-ai-gateway",
          capabilities: ["edit"],
          defaultRoutes: GATEWAY_DEFAULT_ROUTES,
        },
      },
    ],
  );
  assert.deepEqual(same.outputGrant, defaultRoutes.edit.outputGrant);
});

test("a route to a provider whose adapter lacks the capability is route_unavailable", () => {
  const routes = ProviderSet.fromSettings(
    settingsOf(
      { gateway: { adapter: "vercel-ai-gateway" }, tripo: {} },
      { routes: { vision: { provider: "tripo", model: "m" } } },
    ),
    { env: {} },
  ).routes;
  assert.throws(
    () => routes.vision,
    (error: unknown) =>
      error instanceof RouteUnavailableError &&
      error.code === "route_unavailable" &&
      /no vision capability/.test(error.message),
  );
  // Other operations still resolve.
  assert.equal(routes.still.provider, "gateway");
});

test("`node src/cli.ts stage --routes x.json` exits 2 invalid_input", async () => {
  const r = await cli([...(await stageArgs()), "--routes", "x.json"]);
  assert.equal(r.code, 2, r.stderr);
  assert.equal((JSON.parse(r.stdout) as { error: { code: string } }).error.code, "invalid_input");
});

test("a stage call record shows <providerId>:<operation>:<model>", async () => {
  writeSettings({ providers: { mine: { adapter: "scripted", limit: LIMIT } } });
  const r = await cli(await stageArgs());
  assert.equal(r.code, 0, r.stderr);
  const run = JSON.parse(r.stdout) as { candidates: Array<{ provenance: Provenance }> };
  const routes = new Set(run.candidates[0]!.provenance.calls.map((c) => c.route));
  assert.deepEqual([...routes].sort(), [
    `mine:edit:${defaultRoutes.edit.model}`,
    `mine:vision:${defaultRoutes.vision.model}`,
  ]);
});

test("suggestRoles gives each role of the adapters' defaults, first adapter first", () => {
  const roles = suggestRoles(["vercel-ai-gateway", "tripo"]);
  assert.deepEqual(roles["image"], {
    provider: "vercel-ai-gateway",
    model: defaultRoutes.still.model,
  });
  assert.deepEqual(roles["edit"], {
    provider: "vercel-ai-gateway",
    model: defaultRoutes.edit.model,
  });
  assert.equal(roles["vision"]?.provider, "vercel-ai-gateway");
  assert.equal(roles["decisions"]?.model, defaultRoutes.identity.model);
  assert.equal(roles["planning"]?.provider, "vercel-ai-gateway");
  assert.deepEqual(roles["model3d"], { provider: "tripo", model: defaultRoutes.model3d.model });
  assert.equal(roles["rig3d"]?.provider, "tripo");
  assert.equal(roles["clips3d"]?.provider, "tripo");
  assert.deepEqual(suggestRoles(["openai-compatible"]), {});
});
