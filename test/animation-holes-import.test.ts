import "./fixtures/env.ts";
import { approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importTargets, planAnimationQa, runAnimationQa } from "../src/animation/commands.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import type { DecisionRequest } from "../src/gateway/provider.ts";
import { holeView, viewReference } from "../src/animation/holes.ts";
import { decodePng, getPixel } from "../src/image/raster.ts";
import { defaultRoutes } from "../src/routes.ts";
import { importSheet, writeFamilies } from "../src/sheet/import.ts";
import type { Grouping } from "../src/sheet/types.ts";
import type { TargetProfile } from "../src/types.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";

function profile(): TargetProfile {
  return { ...syntheticProfile(), style: { alpha: { mode: "soft" }, color: { rule: "full" } } };
}

test("animation-qa on an import asks the holes decision on every frame, before and after background removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "assetgrove-holes-import-"));
  const targetDir = join(root, "target");
  await mkdir(targetDir);
  approveProfile(syntheticProfile(), { targetDir });
  const sheet = syntheticSheet();
  const { record, importDir } = await importSheet({
    digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
    sheet: sheet.png,
    sheetPath: "sheet.png",
    tool: "hand drawn",
    assetId: "fern",
    profile: profile(),
    importsDir: join(root, "imports"),
    importId: "imp1",
  });
  // The import keeps each frame's crop of the sheet before background removal.
  for (const f of record.frames) {
    assert.ok(f.source, `frame ${f.id} has a source crop`);
    const before = decodePng(new Uint8Array(await readFile(join(importDir, f.source))));
    assert.deepEqual([before.width, before.height], [f.box.width, f.box.height]);
    assert.ok(
      before.data.every((v, i) => i % 4 !== 3 || v === 255),
      "the crop is opaque",
    );
  }
  const grouping: Grouping = {
    status: "confirmed",
    families: [
      { name: "walk-right", frames: [5, 6, 7, 8, 9, 10], reason: "author's grouping" },
      { name: "walk-left", mirrorOf: "walk-right", reason: "mirror" },
    ],
    unassigned: [],
  };
  await writeFamilies({ importDir, grouping, targetDir });
  const targets = await importTargets(importDir);
  const right = targets.find((t) => t.family === "walk-right");
  assert.deepEqual(
    right?.holeSources?.map((s) => s?.before),
    [5, 6, 7, 8, 9, 10].map((id) =>
      join(importDir, `frames/f${String(id).padStart(3, "0")}.source.png`),
    ),
  );
  // One holes call per frame of each strip, whether or not an area is enclosed.
  const plan = await planAnimationQa(targets, defaultRoutes, 5, true);
  assert.deepEqual(
    plan.perFamily.map((f) => [f.family, f.holeCalls]),
    [
      ["walk-right", 6],
      ["walk-left", 6],
    ],
  );

  const asked: DecisionRequest[] = [];
  const provider = new ScriptedProvider({
    image: () => {
      throw new Error("no image calls expected");
    },
    vision: () => {
      throw new Error("no vision calls expected");
    },
    decide: (request) => {
      asked.push(request);
      // Frame 3 of walk-right lost part of the figure; nothing else did, and nothing flickers.
      const bitten =
        request.operation === "holes" && /frame 3 of a "walk-right"/.test(request.prompt);
      return { answer: { type: "boolean", probability: bitten ? 0.85 : 0.05 } };
    },
    // walk-right declares no template, so the run decides it (#364): it is a walk.
    motionTemplate: () => ({ answer: { type: "choice", choice: "walk" } }),
  });
  const { results } = await runAnimationQa({
    targets: targets.filter((t) => t.family === "walk-right"),
    outDir: join(root, "qa"),
    routes: defaultRoutes,
    capUsd: 5,
    provider: { provider, name: "scripted" },
  });
  const holes = asked.filter((r) => r.operation === "holes");
  assert.equal(holes.length, 6);
  const ids = [5, 6, 7, 8, 9, 10];
  for (const r of holes) {
    assert.equal(r.images.length, 2);
    assert.equal(
      r.question.instructions,
      "Is any part of the character missing after background removal?",
    );
    // Image 1 is the kept crop of the sheet before removal, image 2 the cleaned figure over
    // magenta: the frame's own files, in that order, as the model receives them.
    const n = Number(/frame (\d+) of a "walk-right"/.exec(r.prompt)?.[1]);
    const frame = record.frames.find((f) => f.id === ids[n - 1]);
    assert.ok(frame?.source, `frame ${n} is imported frame ${ids[n - 1]}`);
    const read = async (file: string) =>
      decodePng(new Uint8Array(await readFile(join(importDir, file))));
    const expected = [
      viewReference(holeView(await read(frame.source), new Uint8Array(0)), "", ""),
      viewReference(holeView(await read(frame.file), new Uint8Array(0), [255, 0, 255]), "", ""),
    ];
    assert.deepEqual(
      r.images.map((i) => i.bytes),
      expected.map((e) => e.bytes),
    );
    const [before, after] = r.images.map((i) => decodePng(i.bytes));
    // The crop's corner is the sheet's background (within its noise); the cleaned one is magenta.
    const corner = getPixel(before!, 0, 0);
    for (let k = 0; k < 3; k++)
      assert.ok(Math.abs((corner[k] ?? 0) - (sheet.background[k] ?? 0)) <= 3, `${corner}`);
    assert.deepEqual(getPixel(after!, 0, 0), [255, 0, 255, 255]);
  }
  const qa = results[0]!;
  assert.deepEqual(
    qa.holeDecisions.map((d) => [d.frame, d.view, d.flagged]),
    [1, 2, 3, 4, 5, 6].map((n) => [n, "before-after", n === 3]),
  );
  const failed = qa.report.reasons.filter((r) => r.check === "holes" && !r.passed);
  assert.deepEqual(
    failed.map((r) => r.frames),
    [[3]],
  );
  // Model-backed and unmeasured: advisory, so it is marked shadow rather than filtering.
  assert.equal(failed[0]?.shadow, true);
});
