import "./fixtures/env.ts";
import { approve, stateDir, writeSettings, SCRIPTED_LIMIT } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { InputError } from "../src/errors.ts";
import { loadProfile } from "../src/inputs.ts";
import { checkKindLayoutPaths, checkLayout, checkSpecValues, layoutFor } from "../src/paths.ts";
import { PROFILE_PATH, PROFILE_PRESETS } from "../src/init.ts";
import { listTree } from "../src/tree/list.ts";
import { openProject } from "../src/tree/project.ts";
import type { AssetSpec, TargetProfile } from "../src/types.ts";
import { gitTarget } from "./fixtures/git.ts";
import {
  shelterSpec,
  syntheticProfile,
  syntheticWorld,
  writeStyleBible,
} from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/extension-package", import.meta.url));
const PACKAGE = "assetgrove-fixture-extension";
approve(passingScript);

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
      { cwd, env: process.env, timeout: 60_000 },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = (result: Result): Record<string, any> => JSON.parse(result.stdout);

function profile(): TargetProfile {
  const p = syntheticProfile({
    format: "assetgrove-target-profile/2",
    library: { root: "assets", game: "kind-layout" },
    kinds: {
      "fixture:tile": {
        layout: {
          media: "assets/tiles/{{spec.assetId}}.{{output.extension}}",
          manifest: "assets/tiles/{{spec.assetId}}.json",
        },
      },
    },
    manifest: {
      assetId: "{{spec.assetId}}",
      animationFamily: "{{spec.animationFamily?}}",
      source: "{{output.path}}",
      provenance: "{{provenance}}",
      review: { status: "pending" },
    },
  });
  delete p.validator;
  return p;
}

async function setup() {
  const world = await syntheticWorld();
  const dir = realpathSync(world.dir);
  cpSync(fixture, join(dir, "node_modules", PACKAGE), {
    recursive: true,
    filter: (src) => !src.endsWith(".marker"),
  });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [PACKAGE]: "1.0.0" } }),
  );
  writeSettings({
    extensions: [PACKAGE],
    providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } },
  });
  const bible = join(world.bibleDir, "BIBLE.md");
  await writeStyleBible(bible, world.bible);
  const target = join(dir, "target");
  gitTarget(target);
  const profilePath = join(target, PROFILE_PATH);
  await mkdir(dirname(profilePath), { recursive: true });
  return { ...world, dir, target, bible, profilePath };
}
async function stage(
  world: Awaited<ReturnType<typeof setup>>,
  spec: AssetSpec,
  p = profile(),
  script = passingScript,
) {
  const specPath = join(world.dir, "spec.json");
  await writeFile(specPath, JSON.stringify(spec));
  await writeFile(world.profilePath, JSON.stringify(p));
  return cli(
    [
      "stage",
      "--spec",
      specPath,
      "--bible",
      world.bible,
      "--profile",
      world.profilePath,
      "--runs",
      world.runsDir,
      "--candidates",
      "1",
      "--provider-script",
      script,
      "--json",
    ],
    world.dir,
  );
}
const tile: AssetSpec = { kind: "fixture:tile", assetId: "meadow" };

test("a fixture kind hands off through its layout while sprite-strip retains layout; index and tree list both", async () => {
  const world = await setup();
  try {
    for (const [spec, media, manifest] of [
      [tile, "assets/tiles/meadow.png", "assets/tiles/meadow.json"],
      [shelterSpec, "assets/source/fern/shelter.png", "assets/manifests/fern/shelter.json"],
    ] as const) {
      const staged = await stage(world, spec);
      assert.equal(staged.code, 0, staged.stdout + staged.stderr);
      const picked = await cli(
        [
          "pick",
          "--run",
          doc(staged)["runDir"],
          "--candidate",
          "c1",
          "--target",
          world.target,
          "--json",
        ],
        world.dir,
      );
      assert.equal(picked.code, 0, picked.stdout + picked.stderr);
      assert.equal(
        relative(world.target, doc(picked)["mediaPath"]).split(/[/\\]/).join("/"),
        media,
      );
      assert.equal(
        relative(world.target, doc(picked)["manifestPath"]).split(/[/\\]/).join("/"),
        manifest,
      );
      const written = JSON.parse(await readFile(join(world.target, manifest), "utf8"));
      assert.equal(written.source, media);
      assert.equal(written.animationFamily, spec.animationFamily);
      assert.equal(written.review.status, "pending");
    }
    assert.match(
      await readFile(join(world.target, "assets", "tiles", "index.md"), "utf8"),
      /meadow/,
    );
    assert.match(await readFile(join(world.target, "assets", "index.md"), "utf8"), /tiles/);
    const listed = listTree(await openProject(world.target, stateDir));
    assert.ok(listed.some((entry) => entry.uri === "asset://kind-layout/meadow/card"));
    assert.ok(listed.some((entry) => entry.uri === "asset://kind-layout/fern-shelter/card"));
  } finally {
    await rm(world.dir, { recursive: true, force: true });
  }
});

test("profile loading refuses escaping media and manifest overrides, naming kind and field", async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-kind-layout-")));
  try {
    const path = join(dir, "profile.json");
    for (const field of ["media", "manifest"] as const) {
      for (const bad of [
        "../outside.json",
        "assets/../outside.json",
        "/outside.json",
        "C:/outside.json",
        "assets\\..\\outside.json",
      ]) {
        const p = profile();
        p.kinds!["fixture:tile"]!.layout![field] = bad;
        await writeFile(path, JSON.stringify(p));
        await assert.rejects(
          loadProfile(path),
          (e: unknown) =>
            e instanceof Error &&
            e.message.includes(`kinds.fixture:tile.layout.${field}`) &&
            e.message.includes("library root"),
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("profile loading resolves profile values in an override before checking the library root", async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-kind-values-")));
  try {
    const path = join(dir, "profile.json");
    const p = profile();
    p.values = { ...p.values, dir: "../../outside" };
    p.kinds!["fixture:tile"]!.layout!.media = "assets/{{profile.dir}}/{{spec.assetId}}.png";
    await writeFile(path, JSON.stringify(p));
    await assert.rejects(
      loadProfile(path),
      (e: unknown) =>
        e instanceof InputError &&
        e.message.includes("kinds.fixture:tile.layout.media") &&
        e.message.includes("library root"),
    );
    p.values = { ...p.values, dir: "inside" };
    await writeFile(path, JSON.stringify(p));
    await loadProfile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("profile loading checks an override without a profile name and refuses one without a root", async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-kind-root-")));
  try {
    const path = join(dir, "profile.json");
    const unnamed: Record<string, unknown> = { ...profile(), library: { root: "assets" } };
    delete unnamed["name"];
    await writeFile(path, JSON.stringify(unnamed));
    await loadProfile(path);
    const rootless: Record<string, unknown> = { ...profile() };
    delete rootless["layout"];
    delete rootless["library"];
    await writeFile(path, JSON.stringify(rootless));
    await assert.rejects(
      loadProfile(path),
      (e: unknown) =>
        e instanceof InputError &&
        e.message.includes("kinds.fixture:tile.layout.media") &&
        e.message.includes("library root"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing override spec value exits 2 invalid_input before a provider call or run", async () => {
  const world = await setup();
  try {
    const calls = join(world.dir, "calls.log");
    const script = join(world.dir, "record.mjs");
    await writeFile(
      script,
      'import { appendFileSync } from "node:fs"; const call = () => { appendFileSync(new URL("./calls.log", import.meta.url), "called"); throw new Error("unexpected paid call"); }; export default { paid: true, image: call, vision: call, decide: call };',
    );
    approve(script);
    for (const field of ["media", "manifest"] as const) {
      const p = profile();
      p.kinds!["fixture:tile"]!.layout![field] = "assets/tiles/{{spec.fields.slot}}.json";
      const result = await stage(world, tile, p, script);
      assert.equal(result.code, 2, result.stdout + result.stderr);
      assert.equal(doc(result)["error"].code, "invalid_input");
      assert.match(
        doc(result)["error"].message,
        new RegExp(`kinds\\.fixture:tile\\.layout\\.${field} needs spec\\.fields\\.slot`),
      );
      assert.equal(existsSync(calls), false);
      assert.equal(existsSync(world.runsDir), false);
    }
  } finally {
    await rm(world.dir, { recursive: true, force: true });
  }
});

test("override shapes are checked on profile load even for an unused kind", async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-kind-shape-")));
  try {
    const path = join(dir, "profile.json");
    for (const layout of [
      { manifest: "assets/tile.json" },
      { media: 3 },
      { media: "assets/tile.png", manifest: 3 },
      { media: "assets/tile.png", provenance: "assets/p.json" },
    ]) {
      const p = { ...profile(), kinds: { "unused:tile": { layout } } };
      await writeFile(path, JSON.stringify(p));
      await assert.rejects(loadProfile(path), /kinds.unused:tile.layout/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("media-only overrides inherit manifest and leave global provenance in effect", () => {
  const p = profile();
  p.layout.manifest = "assets/manifests/{{spec.assetId}}.json";
  p.layout.provenance = "assets/provenance/{{spec.fields.source}}.json";
  delete p.kinds!["fixture:tile"]!.layout!.manifest;
  assert.deepEqual(layoutFor(p, tile.kind), {
    media: "assets/tiles/{{spec.assetId}}.{{output.extension}}",
    manifest: p.layout.manifest,
    provenance: p.layout.provenance,
  });
  assert.deepEqual(layoutFor(p, "sprite-strip"), p.layout);
  assert.throws(() => checkSpecValues(p, tile), /layout.provenance needs spec.fields.source/);
  checkLayout(p, { ...tile, fields: { source: "tiles" } });
  p.layout.manifest = "assets/manifests/{{spec.animationFamily}}.json";
  assert.throws(() => checkSpecValues(p, tile), /layout.manifest needs spec.animationFamily/);
});

test("rendered override values cannot escape the library at preflight", () => {
  assert.throws(
    () => checkLayout(profile(), { ...tile, assetId: "../../outside" }),
    /kinds.fixture:tile.layout.media.*library root/,
  );
});

test("missing override values name both fields in pre-spend validation", () => {
  for (const field of ["media", "manifest"] as const) {
    const p = profile();
    p.kinds!["fixture:tile"]!.layout![field] = "assets/{{spec.fields.slot}}.json";
    assert.throws(() => checkSpecValues(p, tile), {
      message: `kinds.fixture:tile.layout.${field} needs spec.fields.slot, which the spec does not set`,
    });
  }
});

test("actual override paths cannot follow a symlink outside the library", async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-kind-link-")));
  try {
    await mkdir(join(dir, "assets"));
    await mkdir(join(dir, "outside"));
    await symlink(join(dir, "outside"), join(dir, "assets", "linked"), "junction");
    for (const field of ["media", "manifest"] as const) {
      const p = profile();
      p.kinds!["fixture:tile"]!.layout![field] = "assets/linked/tile.json";
      assert.throws(
        () =>
          checkKindLayoutPaths(
            p,
            tile.kind,
            (template) => template.replace(/\{\{[^{}]*\}\}/g, "tile"),
            dir,
          ),
        (e: unknown) =>
          e instanceof Error &&
          e.message.includes(`kinds.fixture:tile.layout.${field}`) &&
          e.message.includes("library root"),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init profile presets write no kind layout override", () => {
  for (const preset of Object.values(PROFILE_PRESETS)) {
    assert.equal(preset().kinds, undefined);
  }
});
