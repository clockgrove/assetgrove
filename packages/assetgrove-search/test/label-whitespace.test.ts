import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWhere } from "../src/where.ts";
import { parseVocabulary, labelFilters } from "../../../src/library/labels.ts";
const vocabulary = { format: "assetgrove-labels/1", labels: [{name: "object", aliases: ["props"]}] };
test("label filter whitespace resolves through the search parser", () => {
  const parsed = parseVocabulary(JSON.stringify(vocabulary), "labels");
  for (const filter of ["tag=props", "tag = props", "label = props", "  label\t= props  "]) {
    assert.deepEqual(parseWhere(labelFilters([filter], parsed)), [
      { field: "tags", op: "has", value: "object" },
    ]);
  }
});
