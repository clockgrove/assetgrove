import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchError } from "../src/errors.ts";
import { assertSupportedPlatform } from "../src/platform.ts";
import { compileFilter, parseWhere } from "../src/where.ts";

test("parseWhere reads each operator", () => {
  assert.deepEqual(parseWhere(["kind=model", "state!=draft", "id<5", "id>2"]), [
    { field: "kind", op: "=", value: "model" },
    { field: "state", op: "!=", value: "draft" },
    { field: "id", op: "<", value: "5" },
    { field: "id", op: ">", value: "2" },
  ]);
  assert.deepEqual(parseWhere(" kind = a=b "), [{ field: "kind", op: "=", value: "a=b" }]);
});

test("parseWhere maps tag to tags has and keeps quotes literal", () => {
  assert.deepEqual(parseWhere("tag=red"), [{ field: "tags", op: "has", value: "red" }]);
  assert.deepEqual(parseWhere('title="x"'), [{ field: "title", op: "=", value: '"x"' }]);
  assert.throws(() => parseWhere("tag!=red"), { code: "invalid_input" });
});

test("parseWhere refuses unknown, empty and operatorless terms", () => {
  for (const bad of ["nope=1", "=1", "kind", "tags=x"]) {
    assert.throws(
      () => parseWhere(bad),
      (e) => e instanceof SearchError && e.code === "invalid_input" && e.details["filter"] === bad,
    );
  }
  assert.throws(() => parseWhere("nope=1"), /kind, subject/);
});

test("compileFilter emits SQL for each operator", () => {
  assert.equal(compileFilter([]), undefined);
  assert.equal(
    compileFilter([
      { field: "kind", op: "=", value: "a" },
      { field: "state", op: "!=", value: "b" },
      { field: "id", op: "<", value: 3 },
      { field: "tags", op: "has", value: "t" },
      { field: "tree", op: "=", value: true },
    ]),
    "kind = 'a' AND (state IS NULL OR state != 'b') AND id < 3 AND array_has(tags, 't') AND tree = true",
  );
});

test("compileFilter turns hostile values into one literal", () => {
  for (const v of ["'; DROP TABLE rows; --", "x' OR '1'='1", '"quoted"', "back\\slash'"]) {
    const sql = compileFilter([{ field: "title", op: "=", value: v }]);
    assert.equal(sql, `title = '${v.replaceAll("'", "''")}'`);
  }
});

test("compileFilter refuses unlisted fields, NUL and odd values", () => {
  assert.throws(() => compileFilter([{ field: "x; DROP", op: "=", value: "a" }]), {
    code: "invalid_input",
  });
  assert.throws(() => compileFilter([{ field: "kind", op: "=", value: "a\u0000" }]), {
    code: "invalid_input",
  });
  assert.throws(() => compileFilter([{ field: "id", op: "=", value: Number.NaN }]), {
    code: "invalid_input",
  });
  assert.throws(() => compileFilter([{ field: "kind", op: "has", value: "a" }]), {
    code: "invalid_input",
  });
});

test("assertSupportedPlatform refuses only Intel Mac", () => {
  assert.throws(
    () => assertSupportedPlatform({ platform: "darwin", arch: "x64" }),
    (e) =>
      e instanceof SearchError &&
      e.code === "extension_unavailable" &&
      e.details["reason"] === "platform",
  );
  assert.doesNotThrow(() => assertSupportedPlatform({ platform: "linux", arch: "x64" }));
  assert.doesNotThrow(() => assertSupportedPlatform({ platform: "darwin", arch: "arm64" }));
});
