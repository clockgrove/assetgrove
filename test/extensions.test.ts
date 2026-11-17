import "./fixtures/env.ts";
import { gitTarget } from "./fixtures/git.ts";
import { SCRIPTED_LIMIT, settingsPath, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CORE_REGISTRY } from "../src/extensions/registry.ts";
import { syntheticProfile, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/extension-package", import.meta.url));
const PACKAGE = "assetgrove-fixture-extension";

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], cwd: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [join(root, "src", "cli.ts"), ...args],
      { cwd, env: process.env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function doc(result: Result): Record<string, any> {
  return JSON.parse(result.stdout);
}

/**
 * A project with the fixture package installed under node_modules and named in its package.json,
 * as `npm install` would leave it. Returns the project, the package directory and the marker the
 * entry writes when it is imported.
 */
async function project(name = PACKAGE): Promise<{ dir: string; pkg: string; marker: string }> {
  const dir = await mkdtemp(join(realpathSync(tmpdir()), "assetgrove-ext-"));
  const pkg = join(dir, "node_modules", name);
  cpSync(fixture, pkg, { recursive: true, filter: (src) => !src.endsWith(".marker") });
  if (name !== PACKAGE) {
    const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
    await writeFile(join(pkg, "package.json"), JSON.stringify({ ...manifest, name }));
  }
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "a-game", private: true, dependencies: { [name]: "1.0.0" } }),
  );
  return { dir, pkg, marker: join(pkg, "imported.marker") };
}

function settings(extensions: string[], withEcho = false): void {
  writeSettings({
    extensions,
    providers: {
      scripted: { limit: { ...SCRIPTED_LIMIT } },
      ...(withEcho && {
        echo: { adapter: "fixture:echo", baseURL: "http://127.0.0.1:9/", free: true },
      }),
    },
  });
}

/** A spec of the fixture's kind, a bible and a profile whose hand-off uses the fixture's preset. */
async function inputs(dir: string): Promise<string[]> {
  const world = await syntheticWorld();
  const spec = join(dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(dir, "profile.json");
  await writeFile(
    spec,
    JSON.stringify({ kind: "fixture:tile", assetId: "tile-1", animationFamily: "idle" }),
  );
  await writeFile(bible, JSON.stringify(world.bible));
  const p = syntheticProfile({
    manifest: { assetId: "{{spec.assetId}}", review: { status: "pending" } },
    handoff: [{ preset: "manifest" }, { preset: "fixture:list", options: { file: "tiles.txt" } }],
  });
  delete p.validator;
  await writeFile(profile, JSON.stringify(p));
  return ["--spec", spec, "--bible", bible, "--profile", profile, "--runs", join(dir, "runs")];
}

test("core registers its kinds, presets and adapters through the extension contract", () => {
  const [core] = CORE_REGISTRY.loaded;
  assert.equal(core?.name, "core");
  assert.deepEqual(core?.kinds, ["still", "sprite-strip", "character-3d"]);
  assert.deepEqual(core?.presets, ["manifest", "atlas-json", "aseprite-json"]);
  assert.deepEqual(
    [...(core?.adapters ?? [])].sort(),
    ["anthropic", "openai", "openai-compatible", "scripted", "tripo", "vercel-ai-gateway"].sort(),
  );
});

test("a listed package's kind, preset and adapter stage and pick offline", async () => {
  const { dir, marker } = await project();
  settings([PACKAGE], true);
  const listed = await cli(["extensions", "--json"], dir);
  assert.equal(listed.code, 0, listed.stderr);
  const fixtureExt = doc(listed)["extensions"].find((e: { name: string }) => e.name === "fixture");
  assert.equal(fixtureExt.package, PACKAGE);
  assert.deepEqual(fixtureExt.kinds, ["fixture:tile"]);
  assert.deepEqual(fixtureExt.presets, ["fixture:list"]);
  assert.deepEqual(fixtureExt.adapters, ["fixture:echo"]);
  assert.ok(existsSync(marker));

  const base = await inputs(dir);
  const staged = await cli(["stage", ...base, "--candidates", "1", "--json"], dir);
  assert.equal(staged.code, 0, staged.stderr);
  const run = doc(staged);
  assert.equal(run["candidates"].length, 1);
  assert.deepEqual(run["candidates"][0].provenance.models, ["echo-1"]);
  assert.match(run["candidates"][0].provenance.calls[0].route, /^echo:still:echo-1$/);

  const target = join(dir, "target");
  gitTarget(target);
  const picked = await cli(
    ["pick", "--run", run["runDir"], "--candidate", "c1", "--target", target, "--json"],
    dir,
  );
  assert.equal(picked.code, 0, picked.stderr);
  assert.equal(await readFile(join(target, "tiles.txt"), "utf8"), "tile-1\n");
  assert.deepEqual(
    doc(picked)["handoff"].map((h: { preset: string }) => h.preset),
    ["manifest", "fixture:list"],
  );
});

test("a package installed and in package.json but not listed in settings loads nothing", async () => {
  const { dir, marker } = await project();
  settings([]);
  const listed = await cli(["extensions", "--json"], dir);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(
    doc(listed)["extensions"].map((e: { name: string }) => e.name),
    ["core"],
  );
  // A spec naming the package's kind is refused, naming the settings file; nothing is imported.
  const staged = await cli(["stage", ...(await inputs(dir)), "--json"], dir);
  assert.equal(staged.code, 2, staged.stderr);
  assert.equal(doc(staged)["error"].code, "extension_unavailable");
  assert.ok(doc(staged)["error"].message.includes(settingsPath));
  assert.equal(existsSync(marker), false);
});

test("a listed package whose entry the project's Git tracks is refused before import", async () => {
  const { dir, marker } = await project();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-f", join("node_modules", PACKAGE, "index.js")], { cwd: dir });
  settings([PACKAGE]);
  const r = await cli(["extensions", "--json"], dir);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "extension_refused");
  assert.match(doc(r)["error"].message, /tracks its entry/);
  assert.equal(existsSync(marker), false);
});

test("an entry an outer project's Git tracks is refused from a nested repository too", async () => {
  const { dir, marker } = await project();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-f", join("node_modules", PACKAGE, "index.js")], { cwd: dir });
  // A nested repository (a submodule's or a vendored game's checkout) resolves the outer package.
  const nested = join(dir, "game");
  await mkdir(nested);
  execFileSync("git", ["init", "-q"], { cwd: nested });
  settings([PACKAGE]);
  const r = await cli(["extensions", "--json"], nested);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "extension_refused");
  assert.match(doc(r)["error"].message, /tracks its entry/);
  assert.equal(existsSync(marker), false);
});

test("an api mismatch is refused before import", async () => {
  const { dir, pkg, marker } = await project();
  const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
  manifest.assetgrove.api = 3;
  await writeFile(join(pkg, "package.json"), JSON.stringify(manifest));
  settings([PACKAGE]);
  const r = await cli(["extensions", "--json"], dir);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "extension_refused");
  assert.match(doc(r)["error"].message, /api 3.*speaks api 2/);
  assert.equal(existsSync(marker), false);
});

test("two packages registering one extension's ids exit 2 extension_conflict", async () => {
  const { dir } = await project();
  const twin = "assetgrove-fixture-twin";
  cpSync(join(fixture), join(dir, "node_modules", twin), {
    recursive: true,
    filter: (src) => !src.endsWith(".marker"),
  });
  const manifest = JSON.parse(
    await readFile(join(dir, "node_modules", twin, "package.json"), "utf8"),
  );
  await writeFile(
    join(dir, "node_modules", twin, "package.json"),
    JSON.stringify({ ...manifest, name: twin }),
  );
  settings([PACKAGE, twin]);
  const r = await cli(["extensions", "--json"], dir);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "extension_conflict");

  settings([PACKAGE, PACKAGE]);
  const twice = await cli(["extensions", "--json"], dir);
  assert.equal(twice.code, 2, twice.stderr);
  assert.equal(doc(twice)["error"].code, "extension_conflict");
});

test("an extension registering one id twice exits 2 extension_conflict", async () => {
  const { dir, pkg } = await project();
  // The entry's own kind list names `fixture:tile` twice; names and packages are unique, so only
  // the registry's id check can refuse it.
  const entry = join(pkg, "index.js");
  const source = await readFile(entry, "utf8");
  await writeFile(
    entry,
    source.replace("export default function extension(", "function base(") +
      `
export default function extension(context) {
  const e = base(context);
  return { ...e, kinds: [...e.kinds, ...e.kinds] };
}
`,
  );
  settings([PACKAGE]);
  const r = await cli(["extensions", "--json"], dir);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "extension_conflict");
  assert.match(doc(r)["error"].message, /asset kind "fixture:tile" of extension "fixture"/);
});

test("an unknown id exits 2 extension_unavailable naming the settings line", async () => {
  const { dir } = await project();
  settings(["assetgrove-no-such-extension"]);
  const r = await cli(["extensions", "--json"], dir);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(doc(r)["error"].code, "extension_unavailable");
  assert.ok(doc(r)["error"].message.includes(`extensions[0] "assetgrove-no-such-extension"`));
  assert.ok(doc(r)["error"].message.includes(settingsPath));

  // An adapter of an extension the settings do not list.
  settings([], true);
  const adapter = await cli(["extensions", "--json"], dir);
  assert.equal(adapter.code, 2, adapter.stderr);
  assert.equal(doc(adapter)["error"].code, "extension_unavailable");
  assert.match(doc(adapter)["error"].message, /fixture:echo/);
});

test("an extension kind's artifacts stage in a directory whose name holds no ':'", async () => {
  const { dir } = await project();
  settings([PACKAGE], true);
  const staged = await cli(["stage", ...(await inputs(dir)), "--candidates", "1", "--json"], dir);
  assert.equal(staged.code, 0, staged.stderr);
  const run = doc(staged);
  assert.equal(run["candidates"].length, 1);
  assert.deepEqual(run["candidates"][0].artifacts, ["c1-fixture-tile/tile.txt"]);
  assert.equal(
    await readFile(join(run["runDir"], "c1-fixture-tile", "tile.txt"), "utf8"),
    "a tile named tile-1\n",
  );
  assert.ok(existsSync(join(run["runDir"], run["candidates"][0].file)));
});

test("a spec without a kind exits 2 invalid_input from stage, --dry-run and estimate", async () => {
  const { dir } = await project();
  settings([PACKAGE], true);
  const base = await inputs(dir);
  const spec = base[1] as string;
  await writeFile(spec, JSON.stringify({ assetId: "tile-1" }));
  for (const args of [
    ["stage", ...base, "--json"],
    ["stage", ...base, "--dry-run", "--json"],
    [
      "estimate",
      "stage",
      "--args",
      JSON.stringify({ spec, bible: base[3], profile: base[5], runs: base[7] }),
      "--json",
    ],
  ]) {
    const r = await cli(args, dir);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(doc(r)["error"].code, "invalid_input", args.join(" "));
    assert.match(doc(r)["error"].message, /"kind"/);
  }
});

test("a package whose import, factory or package.json fails is refused naming its settings line", async () => {
  const line = `extensions[0] "${PACKAGE}" of ${settingsPath}`;
  const cases: Array<[string, (pkg: string) => Promise<void>, RegExp]> = [
    [
      "an entry whose import throws",
      (pkg) => writeFile(join(pkg, "index.js"), `import "assetgrove-no-such-dependency";\n`),
      /importing its entry .* failed: .*assetgrove-no-such-dependency/,
    ],
    [
      "a factory that throws",
      (pkg) =>
        writeFile(
          join(pkg, "index.js"),
          `export default function extension() { throw new Error("fixture factory failed"); }\n`,
        ),
      /its entry's default export threw: fixture factory failed/,
    ],
    [
      "a package.json that parses to null",
      (pkg) => writeFile(join(pkg, "package.json"), "null\n"),
      /its package\.json is not a JSON object/,
    ],
  ];
  for (const [what, breakIt, message] of cases) {
    const { dir, pkg } = await project();
    await breakIt(pkg);
    settings([PACKAGE]);
    const r = await cli(["extensions", "--json"], dir);
    assert.equal(r.code, 2, `${what}: ${r.stderr}`);
    assert.equal(doc(r)["error"].code, "extension_refused", what);
    assert.ok(doc(r)["error"].message.includes(line), `${what}: ${doc(r)["error"].message}`);
    assert.match(doc(r)["error"].message, message, what);
  }
});
