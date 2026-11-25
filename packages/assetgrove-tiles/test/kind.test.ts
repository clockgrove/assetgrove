/**
 * The kind's two exact checks on template-built sets, and the kind through core's real path: a
 * temporary project, the pack's entry registered, `stage` answered by a provider script.
 * `tiles:seam-quality` answering no stays advisory, as no stability entry qualifies it.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bibleMarkdown, tempProject } from "@clockgrove/assetgrove/testing";
import type { TempProject } from "@clockgrove/assetgrove/testing";
import entry from "../src/extension.ts";
import { cellBox } from "../src/corner16.ts";
import {
  PALETTE_STYLE,
  atlasOutput,
  checkReasons,
  profileOf,
  spec,
  templateSet,
  withPixel,
} from "./helpers/tiles.ts";

const route = { provider: "scripted", model: "scripted/tiles", estimatedCostUsd: 0.01 };
let project: TempProject;

before(() => {
  project = tempProject();
});
after(() => project.close());

const TILE = 8;
const palette = profileOf(TILE, PALETTE_STYLE);
const GRID = "tiles:grid";
const CLASSES = "tiles:class-uniformity";

/** The template set with a middle pixel of tile 5's north edge changed: exactly one strip. */
const oneWrongStrip = () => {
  const { x, y } = cellBox(5, TILE);
  return withPixel(templateSet(TILE), x + 3, y, [1, 2, 3, 255]);
};

test("a template-built set passes the grid and the class-uniformity checks", async () => {
  const output = atlasOutput(templateSet(TILE), TILE);
  const grid = await checkReasons(GRID, output, palette);
  assert.deepEqual(
    grid.map((r) => [r.check, r.passed]),
    [[GRID, true]],
  );
  const classes = await checkReasons(CLASSES, output, palette);
  assert.deepEqual(
    classes.map((r) => [r.check, r.passed]),
    [[CLASSES, true]],
  );
});

test("one wrong strip fails class-uniformity, naming the tile and the side", async () => {
  const reasons = await checkReasons(CLASSES, atlasOutput(oneWrongStrip(), TILE), palette);
  assert.deepEqual(
    reasons.map((r) => [r.passed, r.reason]),
    [
      [
        false,
        "tile 5 (column 1, row 1): its north strip differs from its class (north, UL) in 1 px",
      ],
    ],
  );
});

test("a wrong size fails the grid check naming both sizes", async () => {
  const reasons = await checkReasons(GRID, atlasOutput(templateSet(4), 4), palette);
  assert.deepEqual(
    reasons.map((r) => [r.passed, r.reason]),
    [[false, "the atlas is 16 × 16, not 32 × 32 (4 × 4 tiles of 8px)"]],
  );
  const skipped = await checkReasons(CLASSES, atlasOutput(templateSet(4), 4), palette);
  assert.equal(skipped[0]?.passed, true);
  assert.match(skipped[0]?.reason ?? "", /^skipped: /);
});

test("an empty cell fails the grid check naming the cell", async () => {
  const atlas = templateSet(TILE);
  const { x, y } = cellBox(9, TILE);
  for (let py = y; py < y + TILE; py++)
    for (let px = x; px < x + TILE; px++) atlas.data[(py * atlas.width + px) * 4 + 3] = 0;
  const reasons = await checkReasons(GRID, atlasOutput(atlas, TILE), palette);
  assert.deepEqual(
    reasons.map((r) => [r.passed, r.reason]),
    [[false, "tile 9 (column 1, row 2) is empty: no pixel at alpha 128 or above"]],
  );
});

test("a painted profile skips class-uniformity with its reason, even on a wrong strip", async () => {
  const reasons = await checkReasons(CLASSES, atlasOutput(oneWrongStrip(), TILE), profileOf(TILE));
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0]?.passed, true);
  assert.match(reasons[0]?.reason ?? "", /^skipped: /);
});

test("a staged set keeps its candidate; seam-quality answering no stays advisory", async () => {
  const tile = 16;
  const bytes = atlasOutput(templateSet(tile), tile).bytes;
  const write = (name: string, content: string) => {
    const path = join(project.dir, name);
    writeFileSync(path, content);
    return path;
  };
  const providerScript = write(
    "script.mjs",
    `const bytes = Buffer.from(${JSON.stringify(Buffer.from(bytes).toString("base64"))}, "base64");
export default {
  image: () => ({ images: [{ mediaType: "image/png", bytes }] }),
  vision: () => ({ text: "{}" }),
  decide: () => ({ answer: { type: "boolean", probability: 0.1 } }),
};
`,
  );
  project.writeSettings({ roles: { image: route, decisions: route } }, { attended: true });
  const outcome = await project.run(
    "stage",
    {
      spec: write("spec.json", JSON.stringify(spec)),
      bible: write("BIBLE.md", bibleMarkdown()),
      profile: write("profile.json", JSON.stringify(profileOf(tile, PALETTE_STYLE))),
      runs: join(project.dir, "runs"),
      providerScript,
      candidates: 1,
    },
    { extensions: [entry], confirm: () => true },
  );
  assert.equal(outcome.exitCode, 0, outcome.human);
  assert.equal(outcome.fields["filtered"], 0);
  assert.deepEqual(outcome.fields["filtering"], [
    { check: "tiles:seam-quality", state: "advisory", cause: "no-entry" },
  ]);
  const [kept] = outcome.fields["candidates"] as Array<{
    fields: { layout: string };
    reasons: Array<{ check: string; passed: boolean; shadow?: true }>;
  }>;
  const seams = kept?.reasons.find((r) => r.check === "tiles:seam-quality");
  assert.equal(seams?.passed, false);
  assert.equal(seams?.shadow, true);
  assert.ok(kept?.reasons.some((r) => r.check === GRID && r.passed));
  assert.ok(kept?.reasons.some((r) => r.check === CLASSES && r.passed));
  assert.equal(kept?.fields.layout, "corner-16");
});

test("a profile without the kind's block and a spec without terrains are refused at plan", async () => {
  project.writeSettings({ roles: { image: route, decisions: route } }, { attended: true });
  const path = (name: string, content: string) => {
    writeFileSync(join(project.dir, name), content);
    return join(project.dir, name);
  };
  const dry = (specJson: unknown, profile: unknown, name: string) =>
    project.run(
      "stage",
      {
        spec: path(`spec-${name}.json`, JSON.stringify(specJson)),
        bible: path("BIBLE.md", bibleMarkdown()),
        profile: path(`profile-${name}.json`, JSON.stringify(profile)),
        runs: join(project.dir, "runs"),
        dryRun: true,
      },
      { extensions: [entry], confirm: () => true },
    );
  const bare = await dry(spec, { ...profileOf(TILE), kinds: undefined }, "bare");
  assert.notEqual(bare.exitCode, 0);
  assert.equal(bare.error?.code, "invalid_input");
  assert.match(bare.error?.message ?? "", /kinds\["tiles:terrain"\]/);

  const noTerrains = await dry(
    { kind: "tiles:terrain", assetId: "grass-dirt" },
    profileOf(TILE),
    "none",
  );
  assert.notEqual(noTerrains.exitCode, 0);
  assert.equal(noTerrains.error?.code, "invalid_input");
  assert.match(noTerrains.error?.message ?? "", /fields/);
});
