import "./fixtures/env.ts";
import { resetSettings, writeSettings } from "./fixtures/env.ts";
import { gitTarget } from "./fixtures/git.ts";
import { shelterSpec, syntheticProfile } from "./fixtures/synthetic.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { SettingsError } from "../src/env.ts";
import { routeDataFlows } from "../src/dataflows.ts";
import {
  checkExtension,
  CORE_ENTRY,
  ExtensionRegistry,
  loadExtensions,
} from "../src/extensions/registry.ts";
import { coreVersion } from "../src/extensions/version.ts";
import { prepareTargetWrite } from "../src/handoff.ts";
import { initProject } from "../src/init.ts";
import { LicenseError, requireGrants } from "../src/license.ts";
import { loadSettings } from "../src/settings.ts";
import { providerSet, ProviderSet } from "../src/providers/index.ts";
import { OPERATION_ROLES, RouteUnavailableError } from "../src/routes.ts";
import type { Settings } from "../src/settings.ts";
import type { Extension } from "../src/extension/api.ts";

const LIMIT = { kind: "prepaid", usd: 100 } as const;

function pixel(operations: Record<string, string> | undefined = { "pixel:still": "image" }) {
  return {
    api: 3,
    name: "pixel",
    kinds: [
      {
        kind: "pixel:tile",
        ...(operations !== undefined && { operations }),
        planCandidate: () => [],
        generate: () => Promise.reject(new Error("not called")),
      },
    ],
  } as unknown as Extension;
}

function registryOf(extension?: Extension): ExtensionRegistry {
  return new ExtensionRegistry([
    CORE_ENTRY,
    ...(extension
      ? [{ extension, info: { package: "pixel-pack", version: "1.0.0", entry: "/x/index.js" } }]
      : []),
  ]);
}

function settingsOf(
  providers: Settings["providers"],
  extra: { roles?: Settings["roles"]; routes?: Settings["routes"] } = {},
): Pick<Settings, "providers" | "roles" | "routes" | "path"> {
  return { providers, roles: extra.roles ?? {}, routes: extra.routes ?? {}, path: "settings.json" };
}

const operations = registryOf(pixel()).operations;

test("a settings route for pixel:still sends it to its provider while still stays put", () => {
  const routes = ProviderSet.fromSettings(
    settingsOf(
      {
        main: { adapter: "scripted", limit: LIMIT },
        pixelart: { adapter: "scripted", limit: LIMIT },
      },
      {
        roles: { image: { provider: "main", model: "m", estimatedCostUsd: 0.1 } },
        routes: { "pixel:still": { provider: "pixelart", model: "p", estimatedCostUsd: 0.1 } },
      },
    ),
    { env: {}, operations },
  ).routes;
  assert.equal(routes["pixel:still"]?.provider, "pixelart");
  assert.equal(routes["pixel:still"]?.model, "p");
  assert.equal(routes.still.provider, "main");
});

test("roles.image applies to pixel:still when it has no route of its own", () => {
  const routes = ProviderSet.fromSettings(
    settingsOf(
      { main: { adapter: "scripted", limit: LIMIT }, other: { adapter: "scripted", limit: LIMIT } },
      { roles: { image: { provider: "other", model: "m", estimatedCostUsd: 0.1 } } },
    ),
    { env: {}, operations },
  ).routes;
  assert.equal(routes["pixel:still"]?.provider, "other");
});

test("an operation with no route resolves through its role's default", () => {
  const routes = ProviderSet.fromSettings(
    settingsOf({ gateway: { adapter: "vercel-ai-gateway" } }),
    { env: {}, operations },
  ).routes;
  assert.equal(routes["pixel:still"]?.provider, "gateway");
  assert.equal(routes["pixel:still"]?.model, "openai/gpt-image-2");
  assert.deepEqual(routes["pixel:still"]?.outputGrant, routes.still.outputGrant);
});

test("a route for pixel:still to a provider without the image capability is route_unavailable", () => {
  const routes = ProviderSet.fromSettings(
    settingsOf(
      { anthropic: { adapter: "anthropic" }, gateway: { adapter: "vercel-ai-gateway" } },
      { routes: { "pixel:still": { provider: "anthropic", model: "m", estimatedCostUsd: 0.1 } } },
    ),
    { env: {}, operations },
  ).routes;
  assert.throws(
    () => routes["pixel:still"],
    (error) =>
      error instanceof RouteUnavailableError &&
      /image capability/.test(error.message) &&
      /pixel:still/.test(error.message),
  );
  assert.equal(routes.still.provider, "gateway");
});

test("checkExtension refuses an operation not named for the pack, and an unknown role", () => {
  assert.equal(checkExtension(pixel(), "line").name, "pixel");
  assert.throws(
    () => checkExtension(pixel({ "other:still": "image" }), "line"),
    /must be named "pixel:<op>", got "other:still"/,
  );
  assert.throws(() => checkExtension(pixel({ still: "image" }), "line"), /got "still"/);
  assert.throws(
    () => checkExtension(pixel({ "pixel:still": "painting" }), "line"),
    /role "painting".*image, edit, vision/,
  );
});

test("checkRoutes refuses a route of a loaded pack for an operation no kind declares", () => {
  const registry = registryOf(pixel());
  const route = { provider: "main", model: "m" };
  assert.doesNotThrow(() =>
    registry.checkRoutes({ routes: { "pixel:still": route, "gone:op": route }, path: "s.json" }),
  );
  assert.throws(
    () => registry.checkRoutes({ routes: { "pixel:foo": route }, path: "s.json" }),
    (error) =>
      error instanceof SettingsError &&
      error.message ===
        'settings.routes["pixel:foo"] of s.json routes an operation extension "pixel" does not declare; its kinds declare: pixel:still',
  );
  assert.throws(
    () => registryOf(pixel({})).checkRoutes({ routes: { "pixel:foo": route }, path: "s.json" }),
    /declare: none/,
  );
});

test("core's registry holds the operations its kinds declare, and refuses a disagreeing one", () => {
  const core = registryOf();
  for (const kind of core.kinds) {
    for (const [op, role] of Object.entries(kind.operations ?? {})) {
      assert.equal(core.operations[op], role);
      assert.equal(OPERATION_ROLES[op], role);
    }
  }
  const kinds = new Map(core.kinds.map((k) => [k.kind, k]));
  assert.deepEqual(kinds.get("still")?.operations?.["still"], "image");
  assert.ok(kinds.get("character-3d")?.operations?.["rig3d"]);
  const wrong = {
    api: 3,
    name: "core",
    kinds: [{ ...kinds.get("still")!, operations: { still: "vision" } }],
  } as unknown as Extension;
  assert.throws(
    () => new ExtensionRegistry([{ ...CORE_ENTRY, extension: wrong }]),
    /extension_conflict|core's operations/,
  );
});

const PNG = { mediaType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) };

test("a fixture kind's pixel:still call is served by its own scripted provider, core's still by another", async () => {
  const set = ProviderSet.fromSettings(
    settingsOf(
      {
        main: { adapter: "scripted", limit: LIMIT },
        pixelart: { adapter: "scripted", limit: LIMIT },
      },
      {
        roles: { image: { provider: "main", model: "m", estimatedCostUsd: 0.1 } },
        routes: { "pixel:still": { provider: "pixelart", model: "p", estimatedCostUsd: 0.1 } },
      },
    ),
    {
      env: {},
      operations,
      script: { image: () => ({ images: [PNG] }), vision: () => ({ text: "" }) },
    },
  );
  const caller = new Caller({ provider: set, budget: new Budget(1), routes: set.routes });
  await caller.image("pixel:still", "a tile", []);
  await caller.image("still", "a fern", []);
  assert.deepEqual(
    caller.records.map((r) => r.route),
    ["pixelart:pixel:still:p", "main:still:m"],
  );
});

test("through a provider set, an adapter that maps no typed parameter refuses the call before spend", async () => {
  const set = ProviderSet.fromSettings(
    settingsOf({ gateway: { adapter: "vercel-ai-gateway", limit: LIMIT } }),
    { env: {}, operations },
  );
  const budget = new Budget(1);
  const caller = new Caller({ provider: set, budget, routes: set.routes });
  await assert.rejects(
    caller.image("pixel:still", "a tile", [], undefined, {
      parameters: { tiling: { x: true, y: false } },
    }),
    (error: unknown) =>
      error instanceof RouteUnavailableError &&
      /passes tiling, which provider "gateway" \(vercel-ai-gateway adapter\) does not map/.test(
        error.message,
      ),
  );
  assert.equal(budget.spentUsd + budget.reservedUsd, 0);
});

const root = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-kind-operations-")));
after(() => rmSync(root, { recursive: true, force: true }));

/** A project with the pixel pack installed on disk, its kind declaring pixel:still (role image). */
function pixelProject(): string {
  const dir = join(root, "project");
  const pkg = join(dir, "node_modules", "pixel-pack");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "pixel-pack",
      version: "1.0.0",
      type: "module",
      assetgrove: { api: 3, entry: "./index.js" },
      peerDependencies: { "@clockgrove/assetgrove": `^${coreVersion()}` },
    }),
  );
  writeFileSync(
    join(pkg, "index.js"),
    `export default ({ api }) => ({
  api,
  name: "pixel",
  kinds: [{
    kind: "pixel:tile",
    operations: { "pixel:still": "image" },
    planCandidate: () => [],
    generate: () => Promise.reject(new Error("not called")),
  }],
});
`,
  );
  return dir;
}

test("loadExtensions refuses a settings route for an operation the loaded pack does not declare", async () => {
  const dir = pixelProject();
  const route = { provider: "main", model: "m" };
  const settings = (routes: Settings["routes"]) => ({
    extensions: ["pixel-pack"],
    path: "settings.json",
    routes,
  });
  const registry = await loadExtensions(settings({ "pixel:still": route }), dir);
  assert.equal(registry.operations["pixel:still"], "image");
  await assert.rejects(
    loadExtensions(settings({ "pixel:render": route }), dir),
    (error: unknown) =>
      error instanceof SettingsError &&
      /routes\["pixel:render"\] of settings\.json routes an operation extension "pixel" does not declare; its kinds declare: pixel:still/.test(
        error.message,
      ),
  );
});

test("providerSet routes a loaded pack's operation through its role's default", async () => {
  const extensions = await loadExtensions(
    { extensions: ["pixel-pack"], path: "settings.json" },
    pixelProject(),
  );
  const settings = {
    ...settingsOf({ gateway: { adapter: "vercel-ai-gateway", limit: LIMIT } }),
    promptPolicy: { allow: [] },
  } as unknown as Settings;
  const set = await providerSet(undefined, { settings, env: {}, extensions });
  const route = set.routes["pixel:still"];
  assert.ok(route, "pixel:still is routed");
  assert.equal(route.provider, "gateway");
  assert.equal(route.model, set.routes["still"]?.model);
  const coreOnly = await providerSet(undefined, { settings, env: {} });
  assert.equal(coreOnly.routes["pixel:still"], undefined);
});

test("routeDataFlows lists a kind's operation by its role, with or without a route of its own", () => {
  const gateway = { gateway: { adapter: "vercel-ai-gateway", limit: LIMIT } } as const;
  const routed = settingsOf(gateway, {
    routes: { "pixel:still": { provider: "gateway", model: "openai/gpt-image-2" } },
  });
  const flows = routeDataFlows(routed, { operations });
  const pixelStill = flows.find((f) => f.operation === "pixel:still");
  assert.equal(pixelStill?.providerId, "gateway");
  assert.equal(pixelStill?.upstream, "openai");
  const unrouted = routeDataFlows(settingsOf(gateway), { operations });
  assert.ok(unrouted.some((f) => f.operation === "pixel:still"));
});

test("a hand-off refused for a kind's operation with no grant names its role's settings field", () => {
  const call = { operation: "pixel:still", route: "gateway:pixel:still:m" } as never;
  assert.throws(
    () => requireGrants([call], operations),
    /routes\.pixel:still\.outputGrant or roles\.image\.outputGrant/,
  );
});

test("init lists a loaded pack's operation in its data flows, routed by its role", async () => {
  writeSettings({
    extensions: ["pixel-pack"],
    providers: { gateway: { adapter: "vercel-ai-gateway", limit: LIMIT } },
  });
  try {
    const settings = loadSettings();
    const dir = pixelProject();
    const extensions = await loadExtensions(settings, dir);
    const result = await initProject(
      {
        directory: gitTarget(join(root, "init-target")),
        profilePreset: "sprite-32",
        stylePreset: "cozy-storybook",
        world: "Testland",
      },
      { settings, env: {}, extensions },
    );
    const flow = result.providers.find((f) => f.operation === "pixel:still");
    assert.ok(flow, "pixel:still is listed");
    assert.equal(flow.providerId, "gateway");
  } finally {
    resetSettings();
  }
});

test("the hand-off refuses a kind's operation with no grant, naming its role's settings field", async () => {
  await assert.rejects(
    prepareTargetWrite({
      profile: syntheticProfile(),
      spec: shelterSpec,
      bibleVersion: "v1",
      output: { bytes: new Uint8Array(), mediaType: "image/png", extension: "png", fields: {} },
      provenance: {
        calls: [{ operation: "pixel:still", route: "gateway:pixel:still:m" }],
      } as never,
      run: {},
      targetDir: join(root, "handoff-target"),
      registry: registryOf(pixel()),
    }),
    (error: unknown) =>
      error instanceof LicenseError &&
      /routes\.pixel:still\.outputGrant or roles\.image\.outputGrant/.test(error.message),
  );
});
