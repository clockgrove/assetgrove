import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";
import { flattenPng } from "../src/flatten.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { ScriptedEmbedder } from "../src/scripted.ts";
import type { Row } from "../src/store.ts";

const emb = new ScriptedEmbedder();
const captions: Record<string, { kind: string; state: string; tags: string[] }> = {
  "red lantern on a porch": { kind: "sprite", state: "approved", tags: ["light"] },
  "blue crystal in a cave": { kind: "sprite", state: "pending", tags: ["gem"] },
  "stone bridge at dawn": { kind: "tile", state: "approved", tags: [] },
};

async function filled() {
  const store = new MemoryStore();
  const rows: Row[] = [];
  for (const [caption, f] of Object.entries(captions)) {
    const [imageVec] = await emb.embedImages([Buffer.from(caption)]);
    const [textVec] = await emb.embedTexts([caption]);
    rows.push({
      key: caption,
      tree: "t",
      id: caption,
      address: `asset://g/${caption}`,
      source: "pick",
      path: `${caption}.png`,
      sha256: "x",
      text: caption,
      imageVec,
      textVec,
      ...f,
    });
  }
  await store.upsert(rows);
  return store;
}

describe("scripted embedder", () => {
  it("is deterministic, 768-dimensional and unit length", async () => {
    const [a] = await emb.embedTexts(["lantern"]);
    const [b] = await new ScriptedEmbedder().embedTexts(["lantern"]);
    assert.deepEqual(a, b);
    assert.equal(a?.length, 768);
    assert.ok(Math.abs(Math.hypot(...(a as Float32Array)) - 1) < 1e-5);
  });
});

describe("memory store", () => {
  it("answers vector queries exactly", async () => {
    const store = await filled();
    const [q] = await emb.embedTexts(["red lantern"]);
    for (const column of ["imageVec", "textVec"] as const) {
      const hits = await store.query({ vector: { column, value: q as Float32Array }, limit: 2 });
      assert.equal(hits[0]?.row.id, "red lantern on a porch");
      assert.equal(hits.length, 2);
    }
  });

  it("answers full-text queries", async () => {
    const hits = await (await filled()).query({ text: "bridge dawn", limit: 5 });
    assert.deepEqual(
      hits.map((h) => h.row.id),
      ["stone bridge at dawn"],
    );
  });

  it("answers filtered queries and only returns matching rows", async () => {
    const store = await filled();
    const a = await store.query({
      filter: [{ field: "state", op: "=", value: "approved" }],
      limit: 10,
    });
    assert.equal(a.length, 2);
    const b = await store.query({
      filter: [
        { field: "kind", op: "=", value: "sprite" },
        { field: "tags", op: "has", value: "gem" },
      ],
      limit: 10,
    });
    assert.deepEqual(
      b.map((h) => h.row.id),
      ["blue crystal in a cave"],
    );
    const [q] = await emb.embedTexts(["lantern"]);
    const c = await store.query({
      vector: { column: "textVec", value: q as Float32Array },
      filter: [{ field: "state", op: "!=", value: "approved" }],
      limit: 10,
    });
    assert.deepEqual(
      c.map((h) => h.row.state),
      ["pending"],
    );
  });

  it("removes rows and records what was built from what", async () => {
    const store = await filled();
    await store.remove(["stone bridge at dawn"]);
    assert.equal((await store.query({ limit: 10 })).length, 2);
    await store.recordBuiltFrom("t", { head: "abc", at: "now" });
    assert.equal((await store.builtFrom("t"))?.head, "abc");
  });
});

describe("flattening", () => {
  it("composites transparent pixels onto the fixed white background", () => {
    const png = new PNG({ width: 2, height: 1 });
    png.data.set([255, 0, 0, 0, 0, 0, 0, 255]);
    const flat = flattenPng(PNG.sync.write(png));
    assert.deepEqual([...flat.data], [255, 255, 255, 0, 0, 0]);
  });
});
