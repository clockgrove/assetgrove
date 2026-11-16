import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { InputError } from "../src/errors.ts";
import { appendAnnotation, emptyReview, parseReview, writeReview } from "../src/library/review.ts";
import {
  BLOCK,
  GitRequiredError,
  LfsRequiredError,
  lfsSize,
  lfsVersion,
  requireLfsMedia,
  withBlock,
} from "../src/gitlfs.ts";

const temporary: string[] = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function dir(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-gitlfs-")));
  temporary.push(path);
  return path;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });

/** A repository whose library root is assets/source, with init's block there. */
function library(): string {
  const root = dir();
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, "assets/source"), { recursive: true });
  writeFileSync(join(root, "assets/source/.gitattributes"), BLOCK);
  return root;
}

test("withBlock appends once and is stable", () => {
  const once = withBlock("*.bin binary");
  assert.equal(withBlock(once), once);
  assert.ok(once.startsWith("*.bin binary\n\n# BEGIN assetgrove"));
  assert.equal(withBlock(""), BLOCK);
});

test("requireLfsMedia asks Git: inside the library passes, outside the rules refuses", () => {
  const root = library();
  requireLfsMedia([join(root, "assets/source/hero/hero.png"), join(root, "assets/source/a.ktx2")]);
  assert.throws(() => requireLfsMedia([join(root, "elsewhere/hero.png")]), LfsRequiredError);
  assert.throws(
    () => requireLfsMedia([join(root, "assets/source/hero.psd")]),
    (error) => {
      assert.ok(error instanceof InputError);
      assert.equal((error as LfsRequiredError).code, "lfs_required");
      return true;
    },
  );
});

test("requireLfsMedia outside a work tree is git_required", () => {
  const plain = dir();
  assert.throws(() => requireLfsMedia([join(plain, "new/dir/a.png")]), GitRequiredError);
});

test("with core.autocrlf true, written records come back byte-identical", () => {
  const root = library();
  git(root, "config", "core.autocrlf", "true");
  const lib = join(root, "assets/source");
  const files: Record<string, string> = {
    "hero.md": "---\nid: hero\n---\n# Hero\n",
    "index.md": "# Index\n\n- [hero](hero.md)\n",
    "log.md": "# Log\n\n- picked hero\n",
    "hero.review.json": '{\n  "versions": []\n}\n',
    "hero.png.provenance.json": '{\n  "model": "scripted"\n}\n',
  };
  files["hero.review.json"] = writeReview(emptyReview("hero.review.json"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(lib, name), text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "library");
  for (const name of Object.keys(files)) rmSync(join(lib, name));
  git(root, "checkout", "--", "assets/source");
  for (const [name, text] of Object.entries(files))
    assert.equal(readFileSync(join(lib, name), "utf8"), text, name);
});

test("two branches that each append a line merge without conflict and keep both lines", () => {
  const root = library();
  const lib = join(root, "assets/source");
  writeFileSync(join(lib, "log.md"), "# Log\n");
  const base = emptyReview("hero.review.json");
  writeFileSync(join(lib, "hero.review.json"), writeReview(base));
  const note = (value: string) => ({
    type: "Annotation" as const,
    motivation: "commenting" as const,
    created: "2026-01-01T00:00:00Z",
    target: "hero.png",
    body: { type: "TextualBody" as const, value },
  });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "left");
  writeFileSync(join(lib, "log.md"), "# Log\nleft\n");
  writeFileSync(join(lib, "hero.review.json"), writeReview(appendAnnotation(base, note("left"))));
  git(root, "commit", "-q", "-am", "left");
  git(root, "checkout", "-q", "main");
  git(root, "checkout", "-q", "-b", "right");
  writeFileSync(join(lib, "log.md"), "# Log\nright\n");
  writeFileSync(join(lib, "hero.review.json"), writeReview(appendAnnotation(base, note("right"))));
  git(root, "commit", "-q", "-am", "right");
  git(root, "merge", "-q", "--no-edit", "left");
  for (const name of ["log.md", "hero.review.json"]) {
    const text = readFileSync(join(lib, name), "utf8");
    if (name === "log.md") assert.ok(text.includes("left\n") && text.includes("right\n"), name);
  }
  const merged = parseReview(readFileSync(join(lib, "hero.review.json"), "utf8"), "merged");
  assert.deepEqual(merged.annotations.map((a) => JSON.stringify(a.body)).sort(), [
    '{"type":"TextualBody","value":"left"}',
    '{"type":"TextualBody","value":"right"}',
  ]);
});

test(
  "lfsSize reports the committed LFS bytes under the library root",
  { skip: lfsVersion(tmpdir()) === undefined },
  () => {
    const root = library();
    git(root, "lfs", "install", "--local");
    assert.equal(lfsSize(join(root, "assets/source")), 0);
    const png = Buffer.alloc(1234, 7);
    writeFileSync(join(root, "assets/source/a.png"), png);
    writeFileSync(join(root, "outside.png"), png);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "media");
    assert.equal(lfsSize(join(root, "assets/source")), 1234);
  },
);
