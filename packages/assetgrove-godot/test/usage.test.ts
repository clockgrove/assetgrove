/**
 * The Godot pack's usage scan on a synthetic project: the references it finds by path and UID,
 * what it marks unresolved or unreadable, the cache it invalidates on an edit or a new revision,
 * and that the scan leaves the target as it was.
 */
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type {
  ExtensionContext,
  TargetEntry,
  TargetRead,
  UsageContext,
} from "@clockgrove/assetgrove/extension";
import { extensionContext, sampleProfile } from "@clockgrove/assetgrove/testing";
import { gltfPreset } from "../src/gltf.ts";
import { spriteFramesPreset } from "../src/sprite-frames.ts";
import { tileSetPreset } from "../src/tile-set.ts";
import { scanUsage } from "../src/usage.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "usage");
const MEDIA = "game/characters/fern.png";

let target = "";
before(async () => {
  target = realpathSync(await mkdtemp(join(tmpdir(), "godot-usage-")));
  await cp(FIXTURE, join(target, "game"), { recursive: true });
  // Binary files the repository keeps out of the fixture: .png is routed to Git LFS.
  await writeFile(join(target, MEDIA), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(target, "game/characters/rock.png"), new Uint8Array([0x89, 0x50]));
  await writeFile(join(target, "game/scenes/old.scn"), new Uint8Array([0x52, 0x53, 0x43, 0x4e]));
  await mkdir(join(target, "game/.godot/imported"), { recursive: true });
  await writeFile(
    join(target, "game/.godot/imported/cache.tscn"),
    `[node]\nx = "res://characters/fern.png"\n`,
  );
});
after(async () => {
  await rm(target, { recursive: true, force: true });
});

async function walk(dir: string, rel = ""): Promise<TargetEntry[]> {
  const found: TargetEntry[] = [];
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await walk(dir, path)));
    else if (entry.isFile()) {
      const s = await stat(join(dir, path));
      found.push({ path, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
    }
  }
  return found;
}

const read: TargetRead = async (path) => {
  try {
    return await readFile(join(target, path));
  } catch {
    return undefined;
  }
};

function context(revision: string, store: Map<string, unknown>): UsageContext {
  return {
    profile: sampleProfile(),
    assetId: "fern",
    media: MEDIA,
    revision,
    async list(dir) {
      const all = await walk(target);
      return dir === "" ? all : all.filter((e) => e.path.startsWith(`${dir}/`));
    },
    cache: {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, structuredClone(value));
      },
    },
  };
}

const ALL = [
  "game/characters/fern.png.import",
  "game/characters/rock.png.import",
  "game/resources/fern_frames.tres",
  "game/resources/theme.tres",
  "game/scenes/enemy.tscn",
  "game/scenes/level.tscn",
  "game/scenes/menu.tscn",
  "game/ui/hud.tscn",
];

async function snapshot() {
  const out: Record<string, string> = {};
  for (const e of await walk(target))
    out[e.path] = `${e.mtimeMs}:${(await readFile(join(target, e.path))).toString("base64")}`;
  return out;
}

test("finds the references by path and UID, and marks the unresolved and unreadable ones", async () => {
  const before = await snapshot();
  const { report } = await scanUsage(context("r1", new Map()), "game", read);
  assert.deepEqual(report, {
    asset: { path: "res://characters/fern.png", uid: "uid://b1fern" },
    references: [
      {
        file: "game/resources/fern_frames.tres",
        line: 3,
        path: "res://characters/fern.png",
        status: "resolved",
        locations: [`sub_resource "AtlasTexture_a" atlas`],
      },
      {
        file: "game/resources/theme.tres",
        line: 3,
        path: "res://missing/gone.png",
        uid: "uid://b1gone",
        status: "unresolved",
        locations: ["resource icon"],
        reason: "its UID and path resolve to nothing in the project",
      },
      {
        file: "game/scenes/level.tscn",
        line: 3,
        path: "res://characters/fern.png",
        uid: "uid://b1fern",
        status: "resolved",
        locations: [`node "Level/Player/Sprite" texture`],
      },
      {
        file: "game/scenes/menu.tscn",
        line: 3,
        path: "res://old/fern.png",
        uid: "uid://b1fern",
        status: "resolved",
        locations: [`node "Menu/Icon" texture`],
      },
      {
        file: "game/scenes/old.scn",
        status: "unreadable",
        locations: [],
        reason: "a binary resource, which the scan does not read",
      },
      {
        file: "game/ui/hud.tscn",
        line: 4,
        path: "res://characters/fern.png",
        status: "resolved",
        locations: [`node "Hud" metadata/portrait`],
      },
    ],
  });
  assert.deepEqual(await snapshot(), before);
});

test("a media file outside the project has no references; an unreadable text file is marked", async () => {
  const outside = { ...context("r1", new Map()), media: "elsewhere/fern.png" };
  assert.deepEqual((await scanUsage(outside, "game", read)).report, {
    asset: { path: "elsewhere/fern.png" },
    references: [],
  });
  const refusing: TargetRead = async (path) =>
    path === "game/ui/hud.tscn" ? undefined : read(path);
  const { report } = await scanUsage(context("r1", new Map()), "game", refusing);
  assert.deepEqual(
    report.references.find((r) => r.file === "game/ui/hud.tscn"),
    {
      file: "game/ui/hud.tscn",
      status: "unreadable",
      locations: [],
      reason: "could not be read",
    },
  );
});

test("the cache is reused until a file changes, the revision changes, or there is no revision", async () => {
  const store = new Map<string, unknown>();
  const first = await scanUsage(context("r1", store), "game", read);
  assert.deepEqual(first.read, ALL);

  const again = await scanUsage(context("r1", store), "game", read);
  assert.deepEqual(again.read, []);
  assert.deepEqual(again.reused, ALL);
  assert.deepEqual(again.report, first.report);

  const menu = join(target, "game/scenes/menu.tscn");
  const before = await readFile(menu, "utf8");
  await writeFile(
    menu,
    `${before}\n[node name="Badge" type="TextureRect" parent="Icon"]\nicon = ExtResource("1_old")\n`,
  );
  const future = new Date(Date.now() + 5000);
  await utimes(menu, future, future);
  const edited = await scanUsage(context("r1", store), "game", read);
  assert.deepEqual(edited.read, ["game/scenes/menu.tscn"]);
  const entry = edited.report.references.find((r) => r.file === "game/scenes/menu.tscn");
  assert.deepEqual(entry?.locations, [`node "Menu/Icon" texture`, `node "Menu/Icon/Badge" icon`]);

  const revised = await scanUsage(context("r2", store), "game", read);
  assert.deepEqual(revised.read, ALL);
  assert.deepEqual(revised.reused, []);

  const none = context("", store);
  assert.deepEqual((await scanUsage(none, "game", read)).read, ALL);
  assert.deepEqual((await scanUsage(none, "game", read)).read, ALL);
});

test("all three presets carry the usage hook", async () => {
  const ctx: ExtensionContext = extensionContext("godot");
  for (const preset of [spriteFramesPreset(ctx), tileSetPreset(ctx), gltfPreset(ctx)]) {
    const options = preset.optionsSchema.parse({ project: "game" });
    const report = await preset.usage?.(context("r9", new Map()), options, read);
    assert.equal(report?.asset.uid, "uid://b1fern", preset.name);
    assert.ok((report?.references.length ?? 0) > 0, preset.name);
  }
});
