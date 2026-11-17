import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { InputError } from "../src/errors.ts";
import { MIN_DECISION_EDGE } from "../src/identity.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { createRaster, decodePng, encodePng } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { defaultRoutes, OPERATION_ROLES, SHEET_BLOB_OPERATION } from "../src/routes.ts";
import { judgeBlobs, outlinedCrop, SHEET_BLOB_LIMIT } from "../src/sheet/blobs.ts";
import { importSheet, REFUSED_SHEET_RECORD } from "../src/sheet/import.ts";
import { ambiguousBlobs, SliceError, sliceSheet } from "../src/sheet/slice.ts";
import type { BlobKind } from "../src/sheet/types.ts";
import type { Box } from "../src/types.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

/** A white sheet of 64 px cells in one row, with dark rectangles drawn in it. */
function sheetOf(cells: number, rects: Box[]): Raster {
  const raster = createRaster(64 * cells, 64);
  for (let i = 0; i < raster.data.length; i += 4) raster.data.set([255, 255, 255, 255], i);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) {
        raster.data.set([40, 50, 60, 255], (y * raster.width + x) * 4);
      }
    }
  }
  return raster;
}

/** Four standing figures on a ground line at y = 56; the fourth crouches (areas 1000, 950, 900, 250). */
function crouchSheet(): Raster {
  return sheetOf(4, [
    { x: 20, y: 16, width: 25, height: 40 },
    { x: 84, y: 18, width: 25, height: 38 },
    { x: 148, y: 20, width: 25, height: 36 },
    { x: 207, y: 46, width: 25, height: 10 },
  ]);
}

/** Four figures of 1000 px; the second has a detached tail segment (24 px) right of its box. */
function tailSheet(): Raster {
  return sheetOf(4, [
    { x: 20, y: 16, width: 25, height: 40 },
    { x: 84, y: 16, width: 25, height: 40 },
    { x: 112, y: 30, width: 6, height: 4 },
    { x: 148, y: 16, width: 25, height: 40 },
    { x: 212, y: 16, width: 25, height: 40 },
  ]);
}

function caller(answer: (prompt: string) => BlobKind, costUsd = 0.001) {
  const asked: Array<{ prompt: string; images: number; options: string[]; edge: number }> = [];
  const provider = new ScriptedProvider({
    image: () => {
      throw new Error("no image call is expected");
    },
    vision: () => {
      throw new Error("no vision call is expected");
    },
    sheetBlob: (request) => {
      asked.push({
        prompt: request.prompt,
        images: request.images.length,
        edge: Math.min(
          ...request.images.map((i) => {
            const r = decodePng(i.bytes);
            return Math.min(r.width, r.height);
          }),
        ),
        options: request.question.type === "choice" ? Object.keys(request.question.options) : [],
      });
      return { answer: { type: "choice", choice: answer(request.prompt) }, costUsd };
    },
  });
  const budget = new Budget(1);
  const call = new Caller({ provider, providerName: "scripted", budget, routes: defaultRoutes });
  return { call, asked, budget };
}

function opaqueArea(r: Raster): number {
  let n = 0;
  for (let i = 3; i < r.data.length; i += 4) if ((r.data[i] as number) >= 128) n++;
  return n;
}

test("sheet-blob: a crouched frame among [1000, 950, 900, 250] is no longer dropped as a label; the decision makes it a figure", async () => {
  const sheet = crouchSheet();
  // The area rule alone drops it: the frame-count guard refuses a 4-frame sheet as 3.
  assert.throws(
    () => sliceSheet(sheet, { count: 4 }),
    (e: unknown) => e instanceof SliceError && e.found === 3,
  );
  const blobs = ambiguousBlobs(sheet, { count: 4 });
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0]!.area, 250);

  const { call, asked } = caller(() => "figure");
  const judged = await judgeBlobs(call, sheet, { count: 4 }, "fern");
  assert.equal(asked.length, 1);
  // Given the cell crop with the blob outlined, and the expected frame count.
  assert.equal(asked[0]!.images, 1);
  assert.match(asked[0]!.prompt, /should hold 4 frames/);
  assert.deepEqual(asked[0]!.options, ["figure", "part", "label", "speck"]);
  const sliced = sliceSheet(sheet, { count: 4, blobs: judged.verdicts });
  assert.equal(sliced.figures.length, 4);
  assert.equal(
    sliced.figures[3]!.mask.reduce((s, v) => s + v, 0),
    250,
  );

  // Answered label, it is dropped, and the exact frame-count check still refuses the sheet.
  const asLabel = await judgeBlobs(caller(() => "label").call, sheet, { count: 4 }, "fern");
  assert.throws(
    () => sliceSheet(sheet, { count: 4, blobs: asLabel.verdicts }),
    (e: unknown) => e instanceof SliceError && e.found === 3 && e.expected === 4,
  );
});

test("sheet-blob: a detached tail segment outside the body's box is asked about, and kept with its figure as a part", async () => {
  const sheet = tailSheet();
  // The area rule erases it with no error.
  const plain = sliceSheet(sheet, { count: 4 });
  assert.equal(opaqueAreaOfMask(plain.figures[1]!.mask), 1000);

  const blobs = ambiguousBlobs(sheet, { count: 4 });
  assert.equal(blobs.length, 1);
  assert.deepEqual(blobs[0]!.box, { x: 112, y: 30, width: 6, height: 4 });
  // Shown in its own cell, outlined.
  assert.deepEqual(blobs[0]!.crop, { x: 64, y: 0, width: 64, height: 64 });
  const outlined = outlinedCrop(sheet, blobs[0]!.crop, blobs[0]!.box);
  const at = (x: number, y: number) =>
    Array.from(outlined.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3));
  assert.notDeepEqual(at(112 - 64 - 2, 30 - 2), [255, 255, 255]);
  assert.deepEqual(at(2, 2), [255, 255, 255]);

  const { call } = caller(() => "part");
  const judged = await judgeBlobs(call, sheet, { count: 4 }, "fern");
  const sliced = sliceSheet(sheet, { count: 4, blobs: judged.verdicts });
  const second = sliced.figures[1]!;
  assert.equal(opaqueAreaOfMask(second.mask), 1024);
  assert.ok(second.box.x + second.box.width >= 118, JSON.stringify(second.box));
});

function opaqueAreaOfMask(mask: Uint8Array): number {
  return mask.reduce((s, v) => s + v, 0);
}

test("sheet-blob: a clean sheet makes no call", async () => {
  const sheet = sheetOf(
    4,
    [0, 1, 2, 3].map((i) => ({ x: 20 + 64 * i, y: 16, width: 25, height: 40 })),
  );
  assert.deepEqual(ambiguousBlobs(sheet, { count: 4 }), []);
  const { call, asked } = caller(() => "figure");
  const judged = await judgeBlobs(call, sheet, { count: 4 }, "fern");
  assert.equal(asked.length, 0);
  assert.deepEqual(judged, { verdicts: [], judged: [], unjudged: 0 });
});

test("sheet-blob: the import judges through core's decision interface, counts each call against the run's spend and records the answers", async () => {
  const sheet = tailSheet();
  const { call, budget } = caller(() => "part", 0.001);
  const importsDir = join(await mkdtemp(join(tmpdir(), "assetgrove-blob-")), "imports");
  const { record } = await importSheet({
    sheet: encodePng(sheet),
    sheetPath: "tail.png",
    tool: "hand drawn",
    assetId: "fern",
    profile: { ...syntheticProfile(), style: { alpha: { mode: "soft" }, color: { rule: "full" } } },
    importsDir,
    importId: "tail",
    slice: { count: 4 },
    blobs: call,
  });
  assert.equal(record.frames.length, 4);
  assert.deepEqual(record.slice.blobs, [
    { box: { x: 112, y: 30, width: 6, height: 4 }, kind: "part" },
  ]);
  const blobCalls = record.calls.filter((c) => c.operation === SHEET_BLOB_OPERATION);
  assert.equal(blobCalls.length, 1);
  assert.equal(blobCalls[0]!.model, defaultRoutes[SHEET_BLOB_OPERATION]!.model);
  assert.ok(Math.abs(budget.spentUsd - 0.001) < 1e-9, String(budget.spentUsd));
  // The verdicts are the slice step's params, so the step replays from its record.
  const step = record.steps?.[0] as { op: string; params: { blobs?: unknown[] } };
  assert.equal(step.op, "slice");
  assert.equal(step.params.blobs?.length, 1);
  // The tail is in the second frame's cleaned crop.
  const frame = decodePng(
    new Uint8Array(await readFile(join(importsDir, "tail", record.frames[1]!.file))),
  );
  assert.ok(opaqueArea(frame) >= 1024, String(opaqueArea(frame)));
});

test("sheet-blob: a route on the decisions role at $0.001, at most SHEET_BLOB_LIMIT per sheet", async () => {
  assert.equal(OPERATION_ROLES[SHEET_BLOB_OPERATION], "decisions");
  assert.equal(defaultRoutes[SHEET_BLOB_OPERATION]!.estimatedCostUsd, 0.001);
  // A sheet of 30 specks outside the figures' boxes: the largest SHEET_BLOB_LIMIT are asked.
  const specks: Box[] = Array.from({ length: 30 }, (_, i) => ({
    x: 2 + (i % 15) * 6,
    y: i < 15 ? 2 : 60,
    width: 1 + (i % 2),
    height: 1,
  }));
  const sheet = sheetOf(4, [
    ...[0, 1, 2, 3].map((i) => ({ x: 20 + 64 * i, y: 12, width: 25, height: 40 })),
    ...specks,
  ]);
  const { call, asked } = caller(() => "speck");
  const judged = await judgeBlobs(call, sheet, { count: 4 }, "fern");
  assert.equal(asked.length, SHEET_BLOB_LIMIT);
  assert.equal(judged.unjudged, 30 - SHEET_BLOB_LIMIT);
  assert.equal(sliceSheet(sheet, { count: 4, blobs: judged.verdicts }).figures.length, 4);
});

test("sheet-blob: import's plan forecasts one call per ambiguous blob on the sheet, and none for a clean sheet", async () => {
  const { execFile } = await import("node:child_process");
  const { writeFile } = await import("node:fs/promises");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const exec = promisify(execFile);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "assetgrove-blob-cli-"));
  await writeFile(join(root, "profile.json"), JSON.stringify(syntheticProfile()));
  const dryRun = async (sheet: Raster) => {
    await writeFile(join(root, "sheet.png"), encodePng(sheet));
    const { stdout } = await exec(
      process.execPath,
      [
        cli,
        "import",
        ...["--sheet", join(root, "sheet.png"), "--profile", join(root, "profile.json")],
        ...["--asset", "fern", "--tool", "hand drawn", "--no-propose", "--frames", "4"],
        ...["--imports", join(root, "imports"), "--runs", join(root, "runs"), "--dry-run"],
      ],
      { env: { ...process.env, AI_GATEWAY_API_KEY: "" } },
    );
    return stdout;
  };
  assert.match(
    await dryRun(tailSheet()),
    /sheet-blob\s+perplexity\/pplx-decider-v1\.2\s+1 x ~\$0\.0010/,
  );
  const clean = sheetOf(
    4,
    [0, 1, 2, 3].map((i) => ({ x: 20 + 64 * i, y: 16, width: 25, height: 40 })),
  );
  assert.doesNotMatch(await dryRun(clean), /sheet-blob/);
});

test("sheet-blob: the outlined crop is enlarged to MIN_DECISION_EDGE before it is sent", async () => {
  const { call, asked } = caller(() => "figure");
  await judgeBlobs(call, crouchSheet(), { count: 4 }, "fern");
  // The cell is 64 px; some decision models reject images under about 300 px a side (#27).
  assert.equal(asked.length, 1);
  assert.ok(asked[0]!.edge >= MIN_DECISION_EDGE, String(asked[0]!.edge));
});

test("sheet-blob: a crouched frame drawn in two pieces, answered figure, is one figure of both pieces", async () => {
  // Areas 1000, 950, 900, and the crouch as 200 px and 50 px, 2 px apart.
  const sheet = sheetOf(4, [
    { x: 20, y: 16, width: 25, height: 40 },
    { x: 84, y: 18, width: 25, height: 38 },
    { x: 148, y: 20, width: 25, height: 36 },
    { x: 207, y: 46, width: 20, height: 10 },
    { x: 229, y: 46, width: 5, height: 10 },
  ]);
  const blobs = ambiguousBlobs(sheet, { count: 4 });
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0]!.ids.length, 2);
  const { call, asked } = caller(() => "figure");
  const judged = await judgeBlobs(call, sheet, { count: 4 }, "fern");
  assert.equal(asked.length, 1);
  const sliced = sliceSheet(sheet, { count: 4, blobs: judged.verdicts });
  assert.deepEqual(
    sliced.figures.map((f) => opaqueAreaOfMask(f.mask)),
    [1000, 950, 900, 250],
  );
  // With no count, the import does not silently return five frames either.
  assert.equal(sliceSheet(sheet, { blobs: judged.verdicts }).figures.length, 4);
});

test("sheet-blob: on a given grid, a part alone in a cell with no figure is refused, naming the blob", async () => {
  const sheet = sheetOf(4, [
    { x: 20, y: 16, width: 25, height: 40 },
    { x: 84, y: 16, width: 25, height: 40 },
    { x: 148, y: 16, width: 25, height: 40 },
    { x: 220, y: 30, width: 6, height: 4 },
  ]);
  const grid = { columns: 4, rows: 1 };
  const blobs = ambiguousBlobs(sheet, { grid });
  assert.equal(blobs.length, 1);
  const judged = await judgeBlobs(caller(() => "part").call, sheet, { grid }, "fern");
  assert.throws(
    () => sliceSheet(sheet, { grid, blobs: judged.verdicts }),
    (e: unknown) =>
      e instanceof InputError && /blob at 220,30,6x4 was judged part of a figure/.test(e.message),
  );
});

test("sheet-blob: a refused generated sheet keeps the sheet-blob decisions made before the refusal, and their cost", async () => {
  const { call } = caller(() => "part", 0.001);
  const importsDir = join(await mkdtemp(join(tmpdir(), "assetgrove-blob-refused-")), "imports");
  await assert.rejects(
    importSheet({
      sheet: encodePng(tailSheet()),
      sheetPath: "tail.png",
      tool: "assetgrove generate-sheet",
      assetId: "fern",
      profile: {
        ...syntheticProfile(),
        style: { alpha: { mode: "soft" }, color: { rule: "full" } },
      },
      importsDir,
      importId: "refused",
      slice: { count: 5 },
      blobs: call,
      generation: { prompt: "a fern sheet", parameters: {}, calls: [] },
    }),
    (e: unknown) => e instanceof SliceError,
  );
  const kept = JSON.parse(
    await readFile(join(importsDir, "refused", REFUSED_SHEET_RECORD), "utf8"),
  ) as {
    calls: Array<{ operation: string; costUsd: number }>;
    costUsd: number;
    slice: { params: { blobs?: unknown[] } };
  };
  assert.deepEqual(
    kept.calls.map((c) => c.operation),
    [SHEET_BLOB_OPERATION],
  );
  assert.ok(Math.abs(kept.costUsd - 0.001) < 1e-9, String(kept.costUsd));
  assert.equal(kept.slice.params.blobs?.length, 1);
});
