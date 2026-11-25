/**
 * Changing one tile through core's real path: a staged and picked `tiles:terrain` asset, then
 * `request-change` with a pixel region on one cell. The edited candidate runs the kind's exact
 * checks: one that keeps the atlas passes both, one that breaks its size is filtered.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  bibleMarkdown,
  extensionContext,
  sampleBible,
  sampleProfile,
} from "@clockgrove/assetgrove/testing";
import type { TempProject } from "@clockgrove/assetgrove/testing";
import { tempProject } from "@clockgrove/assetgrove/testing";
import entry from "../src/extension.ts";
import { cellBox, templateAtlas } from "../src/corner16.ts";
import type { Pixels } from "../src/corner16.ts";

const route = {
  provider: "scripted",
  model: "scripted/tiles",
  estimatedCostUsd: 0.01,
  outputGrant: { license: "MIT", plan: "fixture", commercial: true, relabel: true },
};
const TILE = 8;
const LOWER = [0x5c, 0x8a, 0x4d, 255] as const;
const UPPER = [0xd9, 0xc2, 0x7a, 255] as const;
const MARK = [0x1d, 0x2b, 0x35, 255] as const;
const { raster } = extensionContext("tiles");

let project: TempProject;
beforeEach(() => {
  project = tempProject();
  writeFileSync(join(project.dir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
});
afterEach(() => project.close());

function texture(rgba: readonly number[]): Pixels {
  const data = new Uint8Array(TILE * TILE * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: TILE, height: TILE, data };
}

const atlas = templateAtlas(texture(LOWER), texture(UPPER));

/** The atlas as a raster, optionally with one pixel set. */
function encoded(width: number, height: number, mark?: [number, number]): Uint8Array {
  const r = raster.create(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = (Math.min(y, atlas.height - 1) * atlas.width + Math.min(x, atlas.width - 1)) * 4;
      raster.setPixel(r, x, y, [...atlas.data.subarray(from, from + 4)] as never);
    }
  if (mark !== undefined) raster.setPixel(r, mark[0], mark[1], [...MARK] as never);
  return raster.encodePng(r);
}

const b64 = (bytes: Uint8Array) => JSON.stringify(Buffer.from(bytes).toString("base64"));

/** A script answering the generation (no mask) with the atlas and the edit (the masked edit) with `edited`. */
function writeScript(name: string, edited: Uint8Array): string {
  const path = join(project.dir, `${name}.mjs`);
  writeFileSync(
    path,
    `const generated = Buffer.from(${b64(encoded(32, 32))}, "base64");
const edited = Buffer.from(${b64(edited)}, "base64");
export default {
  image: (request) => ({
    images: [{ mediaType: "image/png", bytes: request.mask ? edited : generated }],
  }),
  vision: () => ({ text: "{}" }),
  decide: () => ({ answer: { type: "boolean", probability: 0.9 } }),
};
`,
  );
  return path;
}

/** Stages and picks the asset, then asks for a change to cell 5; returns the change's outcome. */
async function change(name: string, edited: Uint8Array) {
  project.writeSettings(
    { roles: { image: route, decisions: route, edit: route } },
    { attended: true },
  );
  const write = (file: string, content: string) => {
    const path = join(project.dir, file);
    writeFileSync(path, content);
    return path;
  };
  const runs = join(project.dir, `runs-${name}`);
  mkdirSync(runs, { recursive: true });
  const script = writeScript(name, edited);
  const options = { extensions: [entry], confirm: () => true };
  const staged = await project.run(
    "stage",
    {
      spec: write(
        `${name}-spec.json`,
        JSON.stringify({
          kind: "tiles:terrain",
          assetId: "grass-dirt",
          fields: { terrains: { lower: "dirt", upper: "grass" } },
        }),
      ),
      bible: write(
        "BIBLE.md",
        bibleMarkdown(sampleBible({ palette: ["#1d2b35", "#5c8a4d", "#d9c27a", "#f4efe1"] })),
      ),
      profile: write(
        `${name}-profile.json`,
        JSON.stringify(
          sampleProfile({
            style: { color: { rule: "palette" } },
            kinds: { "tiles:terrain": { tileSize: TILE } },
          }),
        ),
      ),
      runs,
      providerScript: script,
      candidates: 1,
    },
    options,
  );
  assert.equal(staged.exitCode, 0, staged.human);
  const picked = await project.run(
    "pick",
    { run: staged.fields["runDir"] as string, candidate: "c1", target: project.dir },
    options,
  );
  assert.equal(picked.exitCode, 0, picked.human);
  const card = join(project.dir, "assets", "grass-dirt.md");
  assert.ok(existsSync(card), readdirSync(project.dir).join(", "));

  const { x, y, width, height } = cellBox(5, TILE);
  const before = process.cwd();
  process.chdir(project.dir);
  try {
    return await project.run(
      "request-change",
      {
        address: card,
        region: [`${x},${y},${width},${height} : make this tile rockier`],
        bible: join(project.dir, "BIBLE.md"),
        runs,
        providerScript: script,
        candidates: 1,
      },
      options,
    );
  } finally {
    process.chdir(before);
  }
}

test("an edited tile that keeps the atlas passes both exact checks", async () => {
  const outcome = await change("keeps", encoded(32, 32, [10, 10]));
  assert.equal(outcome.exitCode, 0, outcome.human);
  assert.equal(outcome.fields["rejections"], undefined);
  const [kept] = outcome.fields["candidates"] as Array<{
    reasons: Array<{ check: string; passed: boolean; reason: string }>;
  }>;
  const exact = kept?.reasons.filter(
    (r) => r.check.startsWith("tiles:") && r.check !== "tiles:seam-quality",
  );
  assert.deepEqual(
    exact?.map((r) => [r.check, r.passed, r.reason]),
    [
      ["tiles:grid", true, "the atlas is 4 × 4 tiles of 8px (32 × 32), no cell empty"],
      [
        "tiles:class-uniformity",
        true,
        "every tile's edge strip matches its (side, corner-label pair) class",
      ],
    ],
  );
});

test("an edited tile of the wrong atlas size is filtered by tiles:grid", async () => {
  const outcome = await change("wrong-size", encoded(30, 32));
  assert.equal(outcome.error?.code, "qa_found_nothing", outcome.human);
  const [rejection] = outcome.fields["rejections"] as Array<{
    candidate: number;
    reasons: Array<{ check: string; passed: boolean; reason: string }>;
  }>;
  assert.equal(rejection?.candidate, 1);
  assert.deepEqual(
    rejection?.reasons.find((r) => r.check === "tiles:grid"),
    {
      check: "tiles:grid",
      passed: false,
      reason: "the atlas is 30 × 32, not 32 × 32 (4 × 4 tiles of 8px)",
      source: "deterministic",
    },
  );
});
