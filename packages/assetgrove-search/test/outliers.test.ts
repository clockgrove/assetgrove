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

describe("set outliers", () => {
  it("lists one planted off-style asset with z above 3", async () => {
    const set: Record<string, string> = {};
    const words = ["moss", "ivy", "fern", "bark", "reed", "sedge", "clover", "thistle"];
    words.forEach((w, i) => (set[`asset://g/tile-${i}`] = `flat green tile ${w}`));
    set["asset://g/planted"] = "photoreal chrome spaceship render";
    const found = findOutliers(await members(set));
    assert.deepEqual(found.map((o) => o.address), ["asset://g/planted"]);
    assert.ok(found[0]!.z > 3);
  });

  it("lists nothing on a uniform set, and on a set too small to measure", async () => {
    const set: Record<string, string> = {};
    for (let i = 0; i < 8; i++) set[`asset://g/u-${i}`] = "flat green tile";
    assert.deepEqual(findOutliers(await members(set)), []);
    assert.deepEqual(findOutliers(await members({ a: "x", b: "y" })), []);
  });
});
