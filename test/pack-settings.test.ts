import "./fixtures/env.ts";
import { gitTarget } from "./fixtures/git.ts";
import { resetSettings, settingsPath, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRunContext } from "../src/commands/context.ts";
import { SettingsError } from "../src/env.ts";
import { createExtensionContext } from "../src/extension/context.ts";
import { createProviders } from "../src/providers/adapter.ts";
import { applySettingsChange } from "../src/settings-write.ts";
import { loadSettings } from "../src/settings.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/extension-settings-package", import.meta.url));
const PACKAGE = "assetgrove-fixture-tuned";
const DEFAULTS = { binary: "/opt/tuned/bin/tuned", size: 64, tier: "fast" };
after(() => resetSettings());

/** A project with the fixture pack installed (untracked) and the settings listing it. */
async function project(settings: Record<string, unknown> = {}): Promise<string> {
  const dir = gitTarget(await mkdtemp(join(realpathSync(tmpdir()), "assetgrove-packsettings-")));
  cpSync(fixture, join(dir, "node_modules", PACKAGE), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "a-game", private: true, dependencies: { [PACKAGE]: "1.0.0" } }),
  );
  writeSettings({ extensions: [PACKAGE], ...settings });
  return dir;
}

const context = (dir: string) => createRunContext({ log: () => {}, cwd: dir, env: process.env });

/** What the pack's provider `paint` was handed: its pack settings and its adapter settings. */
async function seen(dir: string): Promise<{ pack: unknown; adapter: unknown }> {
  const ctx = await context(dir);
  const paint = createProviders(ctx.settings, { adapters: ctx.extensions!.adapters }).find(
    (p) => p.id === "paint",
  );
  return (paint!.provider as unknown as { seen: { pack: unknown; adapter: unknown } }).seen;
}

const refused = (pattern: RegExp) => (e: unknown) =>
  e instanceof SettingsError && pattern.test(e.message);
const PAINT = { paint: { adapter: "tuned:paint" } };

test("a pack's defaults sit under the developer's values, and reach it through its context", async () => {
  const dir = await project({
    extensionSettings: { [PACKAGE]: { size: 128 } },
    providers: PAINT,
  });
  const ctx = await context(dir);
  const expected = { ...DEFAULTS, size: 128 };
  assert.deepEqual({ ...ctx.extensions!.packSettings.get(PACKAGE) }, expected);
  assert.deepEqual({ ...((await seen(dir)).pack as object) }, expected);
});

test("a listed pack with no block gets its defaults alone", async () => {
  const dir = await project({ providers: PAINT });
  assert.deepEqual({ ...((await seen(dir)).pack as object) }, DEFAULTS);
});

test("an invalid pack block is refused at load, naming the pack and the field", async () => {
  const dir = await project({ extensionSettings: { [PACKAGE]: { size: -1, tier: "slow" } } });
  await assert.rejects(
    context(dir),
    refused(
      new RegExp(
        `extensionSettings\\["${PACKAGE}"\\] is refused by pack "tuned" \\(${PACKAGE}\\): size: .*; tier: `,
      ),
    ),
  );
  const unknown = await project({ extensionSettings: { [PACKAGE]: { colour: "red" } } });
  await assert.rejects(context(unknown), refused(/pack "tuned".*colour/));
});

test("a block for a pack the extensions list does not name is refused", async () => {
  const dir = await project({ extensionSettings: { "assetgrove-other-pack": { tier: "best" } } });
  assert.throws(
    () => loadSettings({ cwd: dir }),
    refused(
      /extensionSettings\["assetgrove-other-pack"\] is for a pack the extensions list does not name/,
    ),
  );
});

test("a pack block never holds a key", async () => {
  const dir = await project({ extensionSettings: { [PACKAGE]: { token: "x" } } });
  assert.throws(() => loadSettings({ cwd: dir }), refused(/field named "token"/));
});

test("a reading of context.settings inside the entry's factory throws, naming why", () => {
  const ctx = createExtensionContext("assetgrove-fixture-tuned", () => {});
  assert.throws(() => ctx.settings, /after the entry returns/);
  assert.deepEqual(createExtensionContext("x", () => {}, { a: 1 }).settings, { a: 1 });
});

test("an adapter's provider settings are accepted, defaulted and refused, naming the field", async () => {
  const final = await project({
    providers: { paint: { adapter: "tuned:paint", quality: "final" } },
  });
  assert.deepEqual((await seen(final)).adapter, { quality: "final" });
  const bare = await project({ providers: PAINT });
  assert.deepEqual((await seen(bare)).adapter, { quality: "draft" });

  const bad = await project({ providers: { paint: { adapter: "tuned:paint", quality: "best" } } });
  await assert.rejects(seen(bad), refused(/providers\.paint\.quality: /));
  const unknown = await project({ providers: { paint: { adapter: "tuned:paint", speed: 3 } } });
  await assert.rejects(seen(unknown), refused(/tuned:paint adapter's settings: .*speed/));
  // A core adapter's entry stays as strict as it was.
  const core = await project({
    providers: { scripted: { adapter: "scripted", quality: "final" } },
  });
  assert.throws(
    () => loadSettings({ cwd: core }),
    refused(/providers\.scripted: Unrecognized key/),
  );
});

test("a route's providerOptions are checked against the adapter's schema, naming the route", async () => {
  const route = (steps: number) => ({
    provider: "paint",
    model: "paint-1",
    estimatedCostUsd: 0.01,
    providerOptions: { tuned: { steps } },
  });
  const ok = await project({ providers: PAINT, routes: { still: route(10) } });
  await context(ok);

  const bad = await project({ providers: PAINT, routes: { still: route(99) } });
  await assert.rejects(
    context(bad),
    refused(
      /routes\.still sends providerOptions the tuned:paint adapter refuses for operation "still": routes\.still\.providerOptions\.tuned\.steps: /,
    ),
  );
  const role = await project({ providers: PAINT, roles: { image: route(0) } });
  await assert.rejects(
    context(role),
    refused(/roles\.image sends providerOptions .*operation "still"/),
  );
  // A role's options never reach an operation a route overrides, so they are not checked for it.
  await context(
    await project({ providers: PAINT, routes: { still: route(10) }, roles: { image: route(99) } }),
  );
  // An operation the adapter declares no schema for is not checked.
  await context(await project({ providers: PAINT, routes: { edit: route(99) } }));
});

function cli(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(root, "src", "cli.ts"), ...args],
      { cwd, env: process.env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

test("init and settings show show each listed pack's settings", async () => {
  const dir = await project({ extensionSettings: { [PACKAGE]: { tier: "best" } } });
  const expected = { ...DEFAULTS, tier: "best" };
  const init = await cli(
    [
      "init",
      "--directory",
      dir,
      "--profile-preset",
      "sprite-32",
      "--style-preset",
      "cozy-storybook",
      "--world",
      "Testland",
      "--json",
    ],
    dir,
  );
  assert.equal(init.code, 0, init.stderr);
  assert.deepEqual(JSON.parse(init.stdout).packSettings, [
    { package: PACKAGE, extension: "tuned", settings: expected },
  ]);

  const show = await cli(["settings", "show", "--json"], dir);
  assert.equal(show.code, 0, show.stderr);
  assert.deepEqual(JSON.parse(show.stdout).settings.extensionSettings, { [PACKAGE]: expected });
});

test("the settings writer keeps each pack's block", async () => {
  const dir = await project({
    extensionSettings: { [PACKAGE]: { tier: "best", size: 32 } },
    providers: { ...PAINT, scripted: { limit: { kind: "prepaid", usd: 5 } } },
  });
  const before = JSON.parse(readFileSync(settingsPath, "utf8"));
  const settings = loadSettings({ cwd: dir });
  const result = await applySettingsChange(
    settings,
    { caps: { runUsd: 3 } },
    { method: "terminal" },
  );
  assert.deepEqual(result.written, ["caps.runUsd"]);
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(after.extensionSettings, before.extensionSettings);
  assert.equal(after.caps.runUsd, 3);
  assert.deepEqual(
    { ...(await context(dir)).extensions!.packSettings.get(PACKAGE) },
    {
      ...DEFAULTS,
      tier: "best",
      size: 32,
    },
  );
});
