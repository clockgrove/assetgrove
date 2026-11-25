/**
 * The `godot:gltf` preset with a real Godot (issue #460): a synthetic skinned `.glb` handed off to
 * a Godot project. The preset's `write` and `check` run as core runs them, with a tool runner that
 * does what core's does (a fresh scratch directory, the files written in, Godot run there, every
 * new or changed file back), and a headless Godot then loads what was written in the project.
 * These tests need Godot 4.7.2 on PATH (CI's setup-godot puts it there), and without it each test
 * skips with the reason.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { after, test } from "node:test";
import type {
  PresetContext,
  PresetFile,
  ToolResult,
  ToolRunOptions,
} from "@clockgrove/assetgrove/extension";
import { extensionContext, sampleProfile } from "@clockgrove/assetgrove/testing";
import {
  GLB_MEDIA_TYPE,
  GLTF_PRESET,
  gltfAsset,
  gltfPreset,
  type GltfOptions,
} from "../src/gltf.ts";
import { GodotInputError, GodotRunError, runGodot } from "../src/run.ts";
import { INPUT_PATH, projectFiles, type GltfInput } from "../src/scratch.ts";
import { GODOT_RELEASE } from "../src/setup.ts";
import { characterGlb } from "./helpers/glb.ts";
import { findGodot } from "./helpers/godot.ts";

const { godot: GODOT, skip: SKIP } = findGodot();
const usable = GODOT !== undefined;

const GLB = "game/characters/fern.glb";
const IMPORT = `${GLB}.import`;
const OPTIONS = {
  project: "game",
  import: { "nodes/root_type": "CharacterBody3D", "animation/import": true },
};

const stage = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-godot-gltf-")));
after(() => rmSync(stage, { recursive: true, force: true }));

const entry = gltfPreset(extensionContext("@clockgrove/assetgrove-godot"));
if (entry.scope === "families") throw new Error(`${GLTF_PRESET} hands off one asset`);
const preset = entry;
const options = (raw: object = OPTIONS): GltfOptions => preset.optionsSchema.parse(raw);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

/** Runs the tool as core's runner does: in a new scratch directory, returning what changed. */
async function runner(tool: string, run: ToolRunOptions): Promise<ToolResult> {
  const scratch = realpathSync(mkdtempSync(join(stage, "scratch-")));
  const inputs = new Map<string, string>();
  for (const [path, content] of Object.entries(run.files ?? {})) {
    const bytes = typeof content === "string" ? Buffer.from(content) : content;
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), bytes);
    inputs.set(path, sha(bytes));
  }
  const ran = spawnSync(GODOT!, run.args, {
    cwd: scratch,
    encoding: "utf8",
    timeout: run.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = listFiles(scratch)
    .map((path) => ({ path, content: new Uint8Array(readFileSync(join(scratch, path))) }))
    .filter((file) => inputs.get(file.path) !== sha(file.content));
  rmSync(scratch, { recursive: true, force: true });
  return {
    exitCode: ran.status ?? 1,
    stdout: ran.stdout ?? "",
    stderr: ran.stderr ?? "",
    files,
    step: { kind: "tool", tool, hash: "0".repeat(64), method: "settings" },
  };
}

/** A fresh target: a Godot project under `game/`. */
function target(): string {
  const dir = realpathSync(mkdtempSync(join(stage, "target-")));
  mkdirSync(join(dir, "game"));
  writeFileSync(
    join(dir, "game", "project.godot"),
    'config_version=5\n\n[application]\n\nconfig/name="fixture"\n',
  );
  return dir;
}

const reader = (dir: string) => async (path: string) => {
  try {
    return new Uint8Array(readFileSync(join(dir, path)));
  } catch {
    return undefined;
  }
};

/** A `character-3d` hand-off's context, as core gives the preset one. */
function context(glb: Uint8Array, output: Record<string, unknown> = {}): PresetContext {
  return {
    profile: sampleProfile(),
    context: {
      spec: { kind: "character-3d", assetId: "fern" },
      output: {
        path: GLB,
        mediaType: GLB_MEDIA_TYPE,
        extension: "glb",
        bones: 2,
        clips: [
          { name: "idle", durationMs: 1000, loop: true },
          { name: "walk", durationMs: 1000, loop: true },
        ],
        ...output,
      },
      provenance: {},
    },
    manifestRel: "game/characters/fern.json",
    mediaBytes: glb,
    run: runner,
  };
}

/** Hands `glb` off as core does: the preset writes, core writes the media and files, the check reads. */
async function handOff(
  dir: string,
  ctx: PresetContext,
  raw: object = OPTIONS,
): Promise<PresetFile[]> {
  const opts = options(raw);
  const files = await preset.write(ctx, opts, reader(dir));
  for (const file of [{ path: GLB, content: ctx.mediaBytes! }, ...files]) {
    mkdirSync(dirname(join(dir, file.path)), { recursive: true });
    writeFileSync(join(dir, file.path), file.content);
  }
  assert.deepEqual(await preset.check(ctx, opts, files, reader(dir)), []);
  return files;
}

/** What Godot reads in the target's project: the scene's root class, animations and UID. */
function describe(dir: string): Record<string, string> {
  const project = join(dir, "game");
  const godot = (...args: string[]) =>
    spawnSync(GODOT!, ["--headless", "--path", project, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const imports = godot("--import");
  assert.doesNotMatch(imports.stdout + imports.stderr, /ERROR/);
  const script = join(stage, `describe-${Date.now()}.gd`);
  writeFileSync(
    script,
    `extends SceneTree
func _initialize():
\tvar scene = load("res://characters/fern.glb").instantiate()
\tprint("ROOT ", scene.get_class())
\tvar player = scene.find_children("*", "AnimationPlayer", true, false)[0]
\tvar names = Array(player.get_animation_list())
\tnames.sort()
\tprint("ANIMATIONS ", ",".join(names))
\tprint("BONES ", scene.find_children("*", "Skeleton3D", true, false)[0].get_bone_count())
\tprint("UID ", ResourceUID.id_to_text(ResourceLoader.get_resource_uid("res://characters/fern.glb")))
\tscene.free()
\tquit()
`,
  );
  const run = godot("--script", script);
  const out = run.stdout + run.stderr;
  assert.doesNotMatch(out, /ERROR/, out);
  return Object.fromEntries([...out.matchAll(/^([A-Z]+) (.*)$/gm)].map((m) => [m[1]!, m[2]!]));
}

const importUid = (text: string) => /^uid="(uid:\/\/[^"]+)"/m.exec(text)?.[1];

test("a fixture GLB with two animations imports with both, its .import carrying the options", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const dir = target();
  const files = await handOff(dir, context(await characterGlb({ animations: ["idle", "walk"] })));
  assert.deepEqual(
    files.map((f) => f.path),
    [IMPORT],
  );
  const imported = readFileSync(join(dir, IMPORT), "utf8");
  assert.match(imported, /^importer="scene"$/m);
  assert.match(imported, /^nodes\/root_type="CharacterBody3D"$/m);
  assert.match(imported, /^animation\/import=true$/m);
  assert.ok(importUid(imported), imported);
  const seen = describe(dir);
  assert.equal(seen["ROOT"], "CharacterBody3D");
  assert.equal(seen["ANIMATIONS"], "idle,walk");
  assert.equal(seen["BONES"], "2");
  assert.equal(seen["UID"], importUid(imported));
});

test("a GLB missing a declared animation fails the hand-off, naming it", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const dir = target();
  const ctx = context(await characterGlb({ animations: ["idle"] }));
  await assert.rejects(preset.write(ctx, options(), reader(dir)), (error: unknown) => {
    assert.ok(error instanceof GodotRunError, String(error));
    assert.match(error.message, /without the animation walk/);
    return true;
  });
});

test("a re-hand-off keeps the UID and the existing .import byte for byte", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const dir = target();
  await handOff(dir, context(await characterGlb({ animations: ["idle", "walk"] })));
  const before = readFileSync(join(dir, IMPORT));
  const uid = importUid(before.toString("utf8"));
  // A replaced model with a third animation, and import options the existing .import overrides.
  const replaced = await characterGlb({ animations: ["idle", "walk", "sniff"] });
  const files = await handOff(dir, context(replaced), {
    ...OPTIONS,
    import: { "nodes/root_type": "Node3D" },
  });
  assert.deepEqual(files, []);
  assert.deepEqual(readFileSync(join(dir, IMPORT)), before);
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, GLB))), replaced);
  const seen = describe(dir);
  assert.equal(seen["UID"], uid);
  assert.equal(seen["ROOT"], "CharacterBody3D");
  assert.equal(seen["ANIMATIONS"], "idle,sniff,walk");
});

test("any GLB: what the context leaves out is read from the file", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const dir = target();
  const glb = await characterGlb({ animations: ["wave"], meshes: 2 });
  const ctx = context(glb, { clips: undefined, bones: undefined, mediaType: undefined });
  assert.deepEqual(
    (await handOff(dir, ctx, { project: "game" })).map((f) => f.path),
    [IMPORT],
  );
  assert.equal(describe(dir)["ANIMATIONS"], "wave");
  // The file's joints are what the asset declares: a count the context gives that Godot does not
  // import fails.
  await assert.rejects(
    preset.write(
      context(glb, { clips: [{ name: "wave" }], bones: 3 }),
      options(),
      reader(target()),
    ),
    /without a Skeleton3D of 3 joints/,
  );
});

test("clips a profile's clipFields shape without a name declare no animations", async (t) => {
  // `model3d.handoff.clipFields` may leave `name` out or rename it (`"id": "name"`).
  const shaped = context(new Uint8Array([1]), {
    clips: [
      { id: "idle", durationMs: 1000 },
      { id: "walk", durationMs: 1000 },
    ],
  });
  assert.deepEqual(gltfAsset(shaped).declared, { joints: 2 });
  if (!usable) return t.skip(SKIP!);
  const dir = target();
  const glb = await characterGlb({ animations: ["idle", "walk"] });
  const ctx = context(glb, { clips: [{ id: "idle" }, { id: "walk" }] });
  assert.deepEqual(
    (await handOff(dir, ctx)).map((f) => f.path),
    [IMPORT],
  );
  assert.equal(describe(dir)["ANIMATIONS"], "idle,walk");
});

test("an unskinned GLB hands off without a Skeleton3D", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const dir = target();
  const glb = await characterGlb({ animations: ["spin"], skin: false });
  const ctx = context(glb, { clips: undefined, bones: undefined });
  assert.deepEqual(
    (await handOff(dir, ctx, { project: "game" })).map((f) => f.path),
    [IMPORT],
  );
});

test("a scene with more meshes than the asset declares fails", async (t) => {
  if (!usable) return t.skip(SKIP!);
  const input: GltfInput = {
    build: "gltf",
    godot: GODOT_RELEASE.release,
    scene: "res://fern.glb",
    fresh: true,
    options: {},
    declared: { meshes: 1 },
  };
  const files = {
    ...projectFiles(),
    "fern.glb": await characterGlb({ animations: ["idle"], meshes: 2 }),
    [INPUT_PATH]: JSON.stringify(input),
  };
  await assert.rejects(
    runGodot(GLTF_PRESET, runner, files),
    /imported with 2 meshes, more than the 1 it declares/,
  );
});

test("media that is not a binary glTF is refused before Godot runs", async () => {
  const ctx = context(new Uint8Array([1]), { path: "game/fern.png", mediaType: "image/png" });
  await assert.rejects(preset.write(ctx, options(), reader(stage)), GodotInputError);
  await assert.rejects(
    preset.write(context(new Uint8Array([1])), options({ project: "elsewhere" }), reader(stage)),
    /outside the Godot project elsewhere\//,
  );
});
