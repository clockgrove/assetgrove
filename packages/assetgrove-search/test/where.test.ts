import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchError } from "../src/errors.ts";
import { assertSupportedPlatform } from "../src/platform.ts";
import { compileFilter, parseWhere, resolveOrdered } from "../src/where.ts";
import { MemoryStore } from "../src/memory-store.ts";

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

test("compileFilter emits IN for a list, and a term matching nothing for an empty one", () => {
  assert.equal(
    compileFilter([{ field: "source", op: "in", value: ["candidate", "folder"] }]),
    "source IN ('candidate', 'folder')",
  );
  assert.equal(
    compileFilter([{ field: "bible", op: "in", value: [] }]),
    "(bible IS NULL AND bible IS NOT NULL)",
  );
  assert.throws(() => compileFilter([{ field: "tags", op: "in", value: ["a"] }]), {
    code: "invalid_input",
  });
});

test("the memory store matches in, and resolveOrdered orders values as versions", async () => {
  const store = new MemoryStore();
  const row = (key: string, source: "pick" | "candidate" | "folder", bible: string) => ({
    key,
    tree: "t",
    id: key,
    address: key,
    source,
    bible,
    path: key,
    sha256: key,
  });
  await store.upsert([row("a", "pick", "1"), row("b", "candidate", "2"), row("c", "folder", "10")]);
  const keys = async (filter: Parameters<typeof store.query>[0]["filter"]) =>
    (await store.query({ filter, limit: 10 })).map((h) => h.row.key);
  assert.deepEqual(await keys([{ field: "source", op: "in", value: ["candidate", "folder"] }]), [
    "b",
    "c",
  ]);
  assert.deepEqual(await keys([{ field: "source", op: "in", value: [] }]), []);
  const resolved = await resolveOrdered(
    [
      { field: "kind", op: "=", value: "k" },
      { field: "bible", op: "<", value: "10" },
    ],
    async (field, others) => {
      assert.equal(field, "bible");
      assert.deepEqual(others, [{ field: "kind", op: "=", value: "k" }]);
      return ["10", "9", "1", "2", "11", "9"];
    },
  );
  assert.deepEqual(resolved, [
    { field: "kind", op: "=", value: "k" },
    { field: "bible", op: "in", value: ["1", "2", "9"] },
  ]);
  // Only bible compares as versions; `<` and `>` on other fields are left to the store.
  const plain: Parameters<typeof resolveOrdered>[0] = [{ field: "path", op: "<", value: "10" }];
  assert.deepEqual(
    await resolveOrdered(plain, async () => assert.fail("no values read for path")),
    plain,
  );
});
