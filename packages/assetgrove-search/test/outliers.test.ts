/**
 * The set's ranking (#366): every member's mean distance to the rest, most distant first, uncut.
 * The distance is a free ranking, not a verdict: which of the most distant are drawn in another
 * style is core's `style-outlier` decision (test/style-outliers.test.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findOutliers, type Member } from "../src/outliers.ts";
import { ScriptedEmbedder } from "../src/scripted.ts";

const embedder = new ScriptedEmbedder();
async function members(captions: Record<string, string>): Promise<Member[]> {
  const entries = Object.entries(captions);
  const vectors = await embedder.embedImages(entries.map(([, c]) => Buffer.from(c)));
  return entries.map(([address], i) => ({ address, vector: vectors[i] as Float32Array }));
}

const SUBJECTS = [
  "moss", "ivy", "fern", "bark", "reed", "sedge", "clover", "thistle", "acorn", "pebble",
  "mushroom", "lily", "daisy", "nettle", "heather", "willow", "birch", "cedar", "maple", "holly",
];

describe("set ranking", () => {
  it("ranks six painterly assets among twenty pixel-art ones above every pixel-art one", async () => {
    // Each painterly asset has five painterly neighbours, so a five-nearest-neighbour score hid
    // all six; the mean distance to the whole set does not.
    const set: Record<string, string> = {};
    SUBJECTS.forEach((s, i) => (set[`asset://g/pixel-${i}`] = `pixel art crisp sprite ${s}`));
    for (let i = 0; i < 6; i++)
      set[`asset://g/painterly-${i}`] = `painterly brushwork oil canvas ${SUBJECTS[i]}`;
    const ranking = findOutliers(await members(set));
    assert.equal(ranking.length, 26, "every member is returned, uncut");
    assert.deepEqual(
      ranking.slice(0, 6).map((r) => r.address).sort(),
      [0, 1, 2, 3, 4, 5].map((i) => `asset://g/painterly-${i}`),
    );
    for (let i = 1; i < ranking.length; i++)
      assert.ok(ranking[i - 1]!.distance >= ranking[i]!.distance, "most distant first");
  });

  it("returns one alternate pose among near-identical frames as a ranking, not a flag", async () => {
    const set: Record<string, string> = {};
    for (let i = 0; i < 12; i++) set[`asset://g/walk-${i}`] = "pixel knight walk frame";
    set["asset://g/crouch"] = "pixel knight crouch frame";
    const ranking = findOutliers(await members(set));
    assert.equal(ranking.length, 13);
    assert.equal(ranking[0]!.address, "asset://g/crouch");
    assert.equal(Object.hasOwn(ranking[0]!, "z"), false, "no z-score and no cut");
  });

  it("ranks an in-style tree among lanterns and barrels first: the distance tracks subject", async () => {
    const set: Record<string, string> = {};
    for (let i = 0; i < 5; i++) set[`asset://g/lantern-${i}`] = "pixel lantern prop";
    for (let i = 0; i < 5; i++) set[`asset://g/barrel-${i}`] = "pixel barrel prop";
    set["asset://g/tree"] = "pixel tree prop";
    const ranking = findOutliers(await members(set));
    assert.equal(ranking.length, 11);
    assert.equal(ranking[0]!.address, "asset://g/tree");
  });

  it("ranks a uniform set at distance 0, and nothing in a set too small to measure", async () => {
    const set: Record<string, string> = {};
    for (let i = 0; i < 8; i++) set[`asset://g/u-${i}`] = "flat green tile";
    const ranking = findOutliers(await members(set));
    assert.equal(ranking.length, 8);
    assert.ok(ranking.every((r) => r.distance < 1e-6));
    assert.deepEqual(findOutliers(await members({ a: "x", b: "y" })), []);
  });
});
