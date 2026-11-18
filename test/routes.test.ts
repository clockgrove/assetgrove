import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ProviderSet, suggestRoles } from "../src/providers/index.ts";
import {
  defaultRoutes,
  GATEWAY_DEFAULT_ROUTES,
  LOOKDEV_MARKINGS_OPERATION,
  resolveRoute,
  RouteUnavailableError,
} from "../src/routes.ts";
import { SettingsError } from "../src/env.ts";
import { loadSettings } from "../src/settings.ts";
import type { Settings } from "../src/settings.ts";
import type { Provenance } from "../src/types.ts";
import { approve, approveProfile, writeSettings } from "./fixtures/env.ts";
import {
  shelterSpec,
  syntheticWorld as plainWorld,
  writeStyleBible,
} from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";

async function syntheticWorld(): Promise<World> {
  const world = await plainWorld();
  approveProfile(world.profile, { targetDir: world.targetDir });
  return world;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(passingScript);

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env: { ...process.env, ...env } },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

async function stageArgs(): Promise<string[]> {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "BIBLE.md");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeStyleBible(bible, world.bible);
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
    { routes: { edit: { provider: "gateway", model, estimatedCostUsd: 0.2 } } },
    { roles: { edit: { provider: "gateway", model, estimatedCostUsd: 0.2 } } },
  ]) {
    const route = ProviderSet.fromSettings(settingsOf(providers, extra), { env: {} }).routes.edit;
    assert.equal(route.provider, "gateway");
    assert.equal(route.model, model);
    assert.equal(route.outputGrant, undefined);
    assert.equal(route.providerTerms, undefined);
  }

  const grant = { license: "LicenseRef-bfl-api", plan: "api", commercial: true, relabel: true };
  const own = ProviderSet.fromSettings(
    settingsOf(providers, {
      routes: {
        edit: {
          provider: "gateway",
          model,
          estimatedCostUsd: 0.2,
          outputGrant: grant,
          providerTerms: "BFL API terms",
        },
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
  assert.equal(same.providerTermsAsOf, defaultRoutes.edit.providerTermsAsOf);
});

test("an override of the default's pair with new terms text and no date does not take the default's date", () => {
  const gateway = [
    {
      id: "gateway",
      adapter: {
        id: "vercel-ai-gateway",
        capabilities: ["edit"],
        defaultRoutes: GATEWAY_DEFAULT_ROUTES,
      },
    },
  ];
  const providers = { gateway: { adapter: "vercel-ai-gateway" } };
  const pair = { provider: "gateway", model: defaultRoutes.edit.model };
  const resolve = (extra: object) =>
    resolveRoute(
      settingsOf(providers, { roles: { edit: { ...pair, ...extra } } }),
      "edit",
      gateway,
    );
  const undated = resolve({ providerTerms: "BFL terms as the studio read them" });
  assert.equal(undated.providerTerms, "BFL terms as the studio read them");
  assert.equal(undated.providerTermsAsOf, undefined);
  const dated = resolve({ providerTerms: "BFL terms", providerTermsAsOf: "2026-11-15" });
  assert.equal(dated.providerTermsAsOf, "2026-11-15");
  // Leaving the terms alone keeps the default's text and its date together.
  const kept = resolve({ estimatedCostUsd: 0.06 });
  assert.equal(kept.providerTerms, defaultRoutes.edit.providerTerms);
  assert.equal(kept.providerTermsAsOf, defaultRoutes.edit.providerTermsAsOf);
});

test("a route to a provider whose adapter lacks the capability is route_unavailable", () => {
  const routes = ProviderSet.fromSettings(
    settingsOf(
      { gateway: { adapter: "vercel-ai-gateway" }, tripo: {} },
      { routes: { vision: { provider: "tripo", model: "m", estimatedCostUsd: 0.1 } } },
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
    `mine:cutout:${defaultRoutes.cutout!.model}`,
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

test("an override that changes the (provider, model) pair takes nothing else from the default and must set its estimate", () => {
  const providers = {
    gateway: { adapter: "vercel-ai-gateway" },
    local: { adapter: "openai-compatible", baseURL: "http://127.0.0.1:8080/v1", free: true },
    remote: { adapter: "openai-compatible", baseURL: "https://models.example/v1" },
  };
  const routesOf = (extra: Parameters<typeof settingsOf>[1]) =>
    ProviderSet.fromSettings(settingsOf(providers, extra), { env: {} }).routes;

  // Another provider: none of the gateway model's options, size or estimate.
  const markings = routesOf({
    roles: { vision: { provider: "remote", model: "m", estimatedCostUsd: 0.03 } },
  })[LOOKDEV_MARKINGS_OPERATION];
  assert.deepEqual(markings, { provider: "remote", model: "m", estimatedCostUsd: 0.03 });
  assert.notEqual(
    defaultRoutes[LOOKDEV_MARKINGS_OPERATION]!.providerOptions,
    undefined,
    "the default has options",
  );

  // The same provider with another model takes nothing from the default model either.
  const edit = routesOf({
    routes: { edit: { provider: "gateway", model: "bfl/flux-kontext-max", estimatedCostUsd: 0.2 } },
  }).edit;
  assert.deepEqual(edit, {
    provider: "gateway",
    model: "bfl/flux-kontext-max",
    estimatedCostUsd: 0.2,
  });

  // A paid provider with no estimate is refused, naming the field; an operation with no default too.
  for (const extra of [
    { roles: { vision: { provider: "remote", model: "m" } } } as Parameters<typeof settingsOf>[1],
    { routes: { edit: { provider: "gateway", model: "bfl/flux-kontext-max" } } },
    { routes: { fix: { provider: "remote", model: "m" } } },
  ]) {
    assert.throws(
      () => routesOf(extra),
      (error: unknown) =>
        error instanceof SettingsError &&
        error.code === "settings_invalid" &&
        /estimatedCostUsd/.test(error.message),
    );
  }
  // A free provider needs no estimate: it reserves nothing.
  assert.equal(
    routesOf({ roles: { vision: { provider: "local", model: "m" } } }).vision.estimatedCostUsd,
    0,
  );
});

test("the scripted stand-in serves an operation only when no other configured provider has a default for it", () => {
  const routes = ProviderSet.fromSettings(
    settingsOf({ scripted: {}, gateway: { adapter: "vercel-ai-gateway" }, tripo: {} }),
    { env: {} },
  ).routes;
  assert.equal(routes.still.provider, "gateway");
  assert.equal(routes.vision.provider, "gateway");
  assert.equal(routes.model3d.provider, "tripo");
  const alone = ProviderSet.fromSettings(settingsOf({ scripted: {}, tripo: {} }), {
    env: {},
  }).routes;
  assert.equal(alone.still.provider, "scripted");
  assert.equal(alone.model3d.provider, "tripo");
});

test("--provider-script with no route naming a scripted provider exits 2 invalid_input before any spend", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "assetgrove-routes-"));
  writeSettings({
    stateDir,
    providers: { gateway: { adapter: "vercel-ai-gateway", limit: LIMIT } },
  });
  const r = await cli(await stageArgs(), {
    AI_GATEWAY_API_KEY: `synthetic-${process.pid}-${Date.now()}`,
  });
  assert.equal(r.code, 2, r.stderr);
  const document = JSON.parse(r.stdout) as { error: { code: string; message: string } };
  assert.equal(document.error.code, "invalid_input");
  assert.match(
    document.error.message,
    /no route of the developer settings names a scripted provider/,
  );
  assert.equal(existsSync(join(stateDir, "spend.jsonl")), false, "no ledger entry");
});

test("a 2D stage checks the limits of the providers it calls, not of every configured one", async () => {
  // Tripo declares no limit but serves only the 3D roles, which a sprite strip never calls.
  writeSettings({ providers: { scripted: { limit: LIMIT }, tripo: {} } });
  const r = await cli(await stageArgs());
  assert.equal(r.code, 0, r.stderr);
});

test("with more than one provider that could serve an operation and no route or role, reading it exits 2 settings_invalid naming the role field", () => {
  for (const other of ["anthropic", "zz-anthropic"]) {
    const providers = {
      gateway: { adapter: "vercel-ai-gateway" },
      [other]: { adapter: "anthropic" },
    };
    const routes = ProviderSet.fromSettings(settingsOf(providers), { env: {} }).routes;
    assert.throws(
      () => routes.vision,
      (error: unknown) =>
        error instanceof SettingsError &&
        error.code === "settings_invalid" &&
        /settings\.roles\.vision/.test(error.message) &&
        error.message.includes("gateway") &&
        error.message.includes(other),
    );
    // Read, not loaded: an operation that is not ambiguous still resolves.
    assert.equal(routes.edit.provider === undefined, false);

    const picked = ProviderSet.fromSettings(
      settingsOf(providers, {
        roles: {
          vision: {
            provider: "gateway",
            model: defaultRoutes.vision.model,
            estimatedCostUsd: 0.01,
          },
        },
      }),
      { env: {} },
    ).routes;
    assert.equal(picked.vision.provider, "gateway");
    assert.equal(picked.vision.model, defaultRoutes.vision.model);
  }
});

test("a lone provider serves its defaults, and providers with disjoint operations are not ambiguous", () => {
  const alone = ProviderSet.fromSettings(
    settingsOf({ gateway: { adapter: "vercel-ai-gateway" } }),
    {
      env: {},
    },
  ).routes;
  assert.equal(alone.vision.provider, "gateway");
  const split = ProviderSet.fromSettings(
    settingsOf({ gateway: { adapter: "vercel-ai-gateway" }, tripo: {} }),
    { env: {} },
  ).routes;
  assert.equal(split.vision.provider, "gateway");
  assert.equal(split.model3d.provider, "tripo");
});

test("route providerOptions: settings validate them as plain objects, a same-pair override replaces the default's whole, and only options off the default are keyed", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "assetgrove-routes-opts-"));
  const load = (routes: unknown) => {
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        format: "assetgrove-settings/1",
        providers: { tripo: {} },
        routes,
      }),
    );
    return loadSettings({ env: { ASSETGROVE_CONFIG: path, HOME: dir }, cwd: dir });
  };
  const loaded = load({
    model3d: { provider: "tripo", model: "m", providerOptions: { tripo: { texture: false } } },
  });
  assert.deepEqual(loaded.routes["model3d"]!.providerOptions, { tripo: { texture: false } });
  assert.throws(
    () => load({ model3d: { provider: "tripo", model: "m", providerOptions: { tripo: "x" } } }),
    (error: unknown) => error instanceof SettingsError && error.code === "settings_invalid",
  );

  const providers = { tripo: {} };
  const def = defaultRoutes.model3d;
  const defaultOptions = def.providerOptions!;
  const model3d = (route?: Settings["routes"][string]) =>
    ProviderSet.fromSettings(settingsOf(providers, route && { routes: { model3d: route } }), {
      env: {},
    }).routes.model3d;
  const same = { provider: "tripo", model: def.model };

  const plain = model3d();
  assert.deepEqual(plain.providerOptions, defaultOptions);
  assert.equal(plain.keyedProviderOptions, undefined);

  const kept = model3d(same);
  assert.deepEqual(kept.providerOptions, defaultOptions);
  assert.equal(kept.keyedProviderOptions, undefined);

  const own = { tripo: { texture: false } };
  const replaced = model3d({ ...same, providerOptions: own });
  assert.deepEqual(replaced.providerOptions, own);
  assert.deepEqual(replaced.keyedProviderOptions, own);

  const identical = model3d({
    ...same,
    providerOptions: structuredClone(defaultOptions),
  });
  assert.deepEqual(identical.providerOptions, defaultOptions);
  assert.equal(identical.keyedProviderOptions, undefined);

  const changed = model3d({ provider: "tripo", model: "other", estimatedCostUsd: 0.1 });
  assert.equal(changed.providerOptions, undefined);
  assert.equal(changed.keyedProviderOptions, undefined);
  const changedOwn = model3d({
    provider: "tripo",
    model: "other",
    estimatedCostUsd: 0.1,
    providerOptions: own,
  });
  assert.deepEqual(changedOwn.providerOptions, own);
  assert.deepEqual(changedOwn.keyedProviderOptions, own);
});
