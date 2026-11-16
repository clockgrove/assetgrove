import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBars, readBars } from "../../../bench/search/bars.ts";

// Design section 7.9, as confirmed by the owner.
const DESIGN: Record<string, [string, number]> = {
  "look-category": [">=", 0.85],
  "look-recall10": [">=", 0.65],
  "look-pixel16": [">=", 0.5],
  "words-image-p5": [">=", 0.45],
  "words-shipped-p5": [">=", 0.85],
  "filters-rebuild": ["=", 1],
  "text-query-p95": ["<=", 150],
  "image-query-p95": ["<=", 500],
  "search-10k": ["<", 1000],
  indexing: ["<=", 150],
  "freshness-2000": ["<=", 100],
};

describe("bars in docs/decisions.md", () => {
  it("list every bar of design section 7.9 with its value", async () => {
    const bars = await readBars();
    assert.deepEqual(Object.fromEntries([...bars].map(([id, b]) => [id, [b.op, b.value]])), DESIGN);
  });

  it("states the precision, the one re-run rule and the threshold rule", async () => {
    const text = await (
      await import("node:fs/promises")
    ).readFile(new URL("../../../docs/decisions.md", import.meta.url), "utf8");
    assert.match(text, /±0\.05/);
    assert.match(text, /re-run once/);
    assert.match(text, /Image-similarity threshold rule/);
    assert.match(text, /at least 0\.9/);
  });

  it("words look-pixel16 as recall@10 and names the library each measure runs on", async () => {
    const text = await (
      await import("node:fs/promises")
    ).readFile(new URL("../../../docs/decisions.md", import.meta.url), "utf8");
    assert.match(text, /\| look-pixel16 +\| By look: recall@10 on 16-px pixel art +\|/);
    assert.match(text, /inventory-full\.csv/);
    assert.match(text, /LanceStore/);
  });

  it("parses a table row", () => {
    const [b] = parseBars("| x-y | Measure | <= 150 ms | reference box |");
    assert.deepEqual(b, { id: "x-y", op: "<=", value: 150, unit: "ms", where: "reference box" });
  });
});
