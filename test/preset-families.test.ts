import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { failureOutcome } from "../src/commands/result.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { PRESETS } from "../src/handoff/presets/index.ts";
import type {
  FamiliesPreset,
  HandoffPreset,
  PresetRegistry,
} from "../src/handoff/presets/index.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { defaultRoutes } from "../src/routes.ts";
import { importSheet, writeFamilies } from "../src/sheet/import.ts";
import type { Grouping } from "../src/sheet/types.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

const OUT = "assets/source/fern/fern.families.json";

/**
 * A fixture families-scope preset, shaped like an engine's animation resource: one file listing
 * every family of the asset, each with its strip and the UID the engine's `.import` file beside the
 * strip holds, read from the target.
 */
const familiesPreset: FamiliesPreset = {
  name: "ext:families",
  scope: "families",
  optionsSchema: z.strictObject({}),
  async write(ctx, _options, read) {
    const families = [];
    for (const family of ctx.families) {
      const imported = await read(`${family.media}.import`);
      families.push({
        name: family.name,
        media: family.media,
        sha256: family.sha256,
        uid: imported === undefined ? null : new TextDecoder().decode(imported).trim(),
      });
    }
    const doc = { asset: ctx.assetId, families };
    return [{ path: OUT, content: `${JSON.stringify(doc, null, 2)}\n` }];
  },
  async check(_ctx, _options, files, read) {
    const problems: string[] = [];
    for (const file of files) {
      const bytes = await read(file.path);
      if (bytes === undefined || new TextDecoder().decode(bytes) !== file.content)
        problems.push(`${file.path} does not read back as written`);
    }
    return problems;
  },
};

function registry(...extra: HandoffPreset[]): PresetRegistry {
  return { presets: new Map([...PRESETS, ...extra.map((p) => [p.name, p] as const)]) };
}

/** A target and an imported sheet of `fern`, its families written by `write(families)`. */
async function imported(presets: HandoffPreset[]) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-families-")));
  const targetDir = join(dir, "target");
  const profile = syntheticProfile({
    handoff: [{ preset: "manifest" }, ...presets.map((p) => ({ preset: p.name }))],
  });
  delete profile.validator;
  const call = new Caller({
    provider: new ScriptedProvider({
      image: () => ({ images: [], costUsd: 0 }),
      vision: () => ({
        text: JSON.stringify({
          families: [{ name: "idle", frames: [1, 2, 3, 4], reason: "standing still" }],
          unassigned: [],
        }),
        costUsd: 0,
      }),
    }),
    providerName: "scripted",
    budget: new Budget(5),
    routes: defaultRoutes,
  });
  const { importDir, grouping } = await importSheet({
    digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
    sheet: syntheticSheet().png,
    sheetPath: "sheets/synthetic.png",
    tool: "synthetic",
    assetId: "fern",
    profile,
    importsDir: join(dir, "imports"),
    importId: "imp1",
    propose: { call },
  });
  const write = (families: Grouping["families"]) =>
    writeFamilies({
      importDir,
      grouping: { ...grouping, status: "confirmed", families },
      targetDir,
      registry: registry(...presets),
    });
  return { dir, targetDir, write };
}

const IDLE = { name: "idle", frames: [1, 2, 3, 4], reason: "standing still" };
const WALK = { name: "walk", frames: [5, 6, 7, 8, 9, 10], reason: "walking right" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readOut = async (targetDir: string): Promise<any> =>
  JSON.parse(await readFile(join(targetDir, OUT), "utf8"));

test("a families-scope preset after two hand-offs of different families writes one file with both", async () => {
  const { targetDir, write } = await imported([familiesPreset]);
  const first = await write([IDLE]);
  assert.deepEqual(first.families[0]!.result.handoff.at(-1), {
    preset: "ext:families",
    files: [OUT],
  });
  assert.deepEqual(
    (await readOut(targetDir)).families.map((f: { name: string }) => f.name),
    ["idle"],
  );
  // The engine imported the idle strip: the preset reads its UID from the target.
  await writeFile(join(targetDir, "assets/source/fern/idle.png.import"), "uid://idle1\n");
  const second = await write([WALK]);
  assert.ok(second.families[0]!.result.files.includes(OUT));
  const doc = await readOut(targetDir);
  assert.equal(doc.asset, "fern");
  assert.deepEqual(
    doc.families.map((f: { name: string; media: string; uid: string | null }) => [
      f.name,
      f.media,
      f.uid,
    ]),
    [
      ["idle", "assets/source/fern/idle.png", "uid://idle1"],
      ["walk", "assets/source/fern/walk.png", null],
    ],
  );
  assert.equal(doc.families[0].sha256, first.families[0]!.result.library!.sha256);
  assert.equal(doc.families[1].sha256, second.families[0]!.result.library!.sha256);
});

test("rewriting one family keeps the other in the families preset's output", async () => {
  const { targetDir, write } = await imported([familiesPreset]);
  await write([IDLE]);
  const walk = await write([WALK]);
  const before = await readOut(targetDir);
  // The walk again, its frames in another order: a new version of walk alone.
  const again = await write([{ ...WALK, frames: [6, 7, 8, 9, 10, 5] }]);
  const after = await readOut(targetDir);
  assert.deepEqual(
    after.families.map((f: { name: string }) => f.name),
    ["idle", "walk"],
  );
  assert.deepEqual(after.families[0], before.families[0], "idle is kept as it was");
  assert.notEqual(
    again.families[0]!.result.library!.sha256,
    walk.families[0]!.result.library!.sha256,
  );
  assert.equal(after.families[1].sha256, again.families[0]!.result.library!.sha256);
});

test("one write-families run of two families runs the families preset once, with both", async () => {
  const { targetDir, write } = await imported([familiesPreset]);
  const written = await write([IDLE, WALK]);
  assert.deepEqual(
    written.families.map((f) => f.result.handoff.at(-1)),
    [
      { preset: "ext:families", files: [] },
      { preset: "ext:families", files: [OUT] },
    ],
  );
  assert.deepEqual(
    (await readOut(targetDir)).families.map((f: { name: string }) => f.name),
    ["idle", "walk"],
  );
});

test("a preset's read outside the target is refused before anything is written", async () => {
  for (const path of ["../outside.txt", ".git/config"]) {
    const reading: FamiliesPreset = {
      ...familiesPreset,
      name: "ext:reading",
      async write(_ctx, _options, read) {
        await read(path);
        return [];
      },
    };
    const { dir, targetDir, write } = await imported([reading]);
    await writeFile(join(dir, "outside.txt"), "secret\n");
    const outcome = failureOutcome(
      await write([IDLE]).then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
    assert.equal(outcome.error?.code, "invalid_input", path);
    assert.match(String(outcome.error?.message), /may not read/, path);
    assert.equal(existsSync(join(targetDir, "assets/source/fern/idle.png")), false, path);
  }
});

test("a path a preset returns outside the target is refused before anything is written", async () => {
  for (const scope of ["asset", "families"] as const) {
    const escaping: HandoffPreset =
      scope === "families"
        ? {
            ...familiesPreset,
            name: "ext:escaping",
            write: async () => [{ path: "../escape.json", content: "{}\n" }],
          }
        : {
            name: "ext:escaping",
            optionsSchema: z.strictObject({}),
            write: async () => [{ path: "../escape.json", content: "{}\n" }],
            check: async () => [],
          };
    const { dir, targetDir, write } = await imported([escaping]);
    const outcome = failureOutcome(
      await write([IDLE]).then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
    assert.equal(outcome.error?.code, "invalid_input", scope);
    assert.equal(existsSync(join(dir, "escape.json")), false, scope);
    assert.equal(existsSync(join(targetDir, "assets/source/fern/idle.png")), false, scope);
  }
});
