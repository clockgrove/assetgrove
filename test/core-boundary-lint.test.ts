import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ESLint } from "eslint";

describe("core never imports the search stack", () => {
  const cases: Array<[string, string]> = [
    ["static import", 'import "@lancedb/lancedb";'],
    ["re-export", 'export * from "@huggingface/transformers";'],
    ["dynamic import", 'await import("@huggingface/transformers");'],
    ["dynamic import of the package", 'await import("@clockgrove/assetgrove-search");'],
    ["type-only import type", 'export type S = import("@clockgrove/assetgrove-search").Store;'],
  ];
  for (const [name, code] of cases) {
    it(`fails lint on a ${name}`, async () => {
      const eslint = new ESLint();
      for (const filePath of ["src/probe.ts", "test/probe.ts"]) {
        const [result] = await eslint.lintText(code, { filePath });
        assert.ok(
          result?.messages.some((m) => /Core never imports/.test(m.message)),
          `${filePath}: ${JSON.stringify(result?.messages)}`,
        );
      }
    });
  }
});
