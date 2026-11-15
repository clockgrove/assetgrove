import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classify } from "../src/commands/result.ts";
import { InputError } from "../src/errors.ts";
import { insideLibrary, libraryPath } from "../src/library/paths.ts";

const root = join(tmpdir(), "assetgrove-library-root");
const base = join(root, "cards");

test("paths inside the library root resolve", () => {
  assert.equal(libraryPath(root, base, "a.png", "card.json: file"), join(base, "a.png"));
  assert.equal(libraryPath(root, base, "sub/b.png", "card.json: file"), join(base, "sub", "b.png"));
  assert.equal(libraryPath(root, base, "./x", "card.json: file"), join(base, "x"));
  assert.equal(
    libraryPath(root, base, "../shared/y.png", "card.json: file"),
    join(root, "shared", "y.png"),
  );
});

test("paths that leave the root are refused as invalid_input", () => {
  for (const rel of [
    "../../x",
    "../../../x",
    "sub/../../../x",
    "/etc/passwd",
    "C:/x",
    "a\\b",
    "file:x",
    "http://h/x",
    "",
    "a\0b",
    "//h/s/x",
  ]) {
    assert.equal(insideLibrary(root, base, rel), false, rel);
    assert.throws(() => libraryPath(root, base, rel, "card.json: file"), InputError, rel);
  }
  try {
    libraryPath(root, base, "../../x", "card.json: file");
    assert.fail("expected a refusal");
  } catch (error) {
    assert.equal(classify(error).code, "invalid_input");
    assert.match(
      (error as Error).message,
      /card\.json: file: path "\.\.\/\.\.\/x" leaves the library root/,
    );
  }
});

test("a symlink inside the root that points outside is refused", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-paths-"));
  const lib = join(dir, "lib");
  const outside = join(dir, "outside");
  await mkdir(lib, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.png"), "x");
  try {
    await symlink(outside, join(lib, "link"), "dir");
  } catch {
    t.skip("symlinks are not available");
    return;
  }
  assert.throws(() => libraryPath(lib, lib, "link/secret.png", "index row"), InputError);
  assert.throws(() => libraryPath(lib, lib, "link/missing.png", "index row"), InputError);
  assert.equal(insideLibrary(lib, lib, "plain.png"), true);
});
