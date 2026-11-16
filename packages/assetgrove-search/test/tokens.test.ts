import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitTokens } from "../src/tokens.ts";

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 10);

describe("fitTokens", () => {
  it("leaves a short text unchanged", () => {
    const plain = range(3);
    assert.deepEqual(fitTokens([1, ...plain, 2], plain, 8), [1, ...plain, 2]);
  });

  it("keeps the start and end tokens on a long text", () => {
    const plain = range(20);
    const out = fitTokens([1, ...plain, 2], plain, 8);
    assert.equal(out.length, 8);
    assert.equal(out[0], 1);
    assert.equal(out[7], 2);
    assert.deepEqual(out.slice(1, 7), plain.slice(0, 6));
  });

  it("equals plain truncation when there is no trailing special", () => {
    const plain = range(20);
    const full = [1, ...plain];
    assert.deepEqual(fitTokens(full, plain, 8), full.slice(0, 8));
  });

  it("falls back to plain truncation when the text cannot be located", () => {
    const full = range(20);
    assert.deepEqual(fitTokens(full, [999, 998], 8), full.slice(0, 8));
  });
});
