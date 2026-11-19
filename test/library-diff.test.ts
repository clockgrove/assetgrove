import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { libraryDiff } from "../src/library/diff.ts";
import { sha256Hex } from "../src/library/canonical.ts";
import {
  emptyReview,
  appendVersion,
  appendAnnotation,
  writeReview,
} from "../src/library/review.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
test("library diff compares fixture commits, reports absent LFS, and leaves repository unchanged", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-diff-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  try {
    git("init");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("remote", "add", "origin", "https://github.com/example/fixture.git");
    git("commit", "--allow-empty", "-m", "empty");
    const empty = git("rev-parse", "HEAD").trim();
    const bytes = Buffer.from("synthetic media"),
      hash = sha256Hex(bytes);
    const card = (tags: string) =>
      `---\ntype: Game Asset\n"format": "assetgrove-card/1" # supported YAML\ntitle: Fixture\nresource: lamp.bin\ntags: [${tags}]\n---\n`;
    writeFileSync(join(root, "lamp.md"), card("prop"));
    writeFileSync(join(root, "lamp.bin"), bytes);
    let record = appendVersion(emptyReview("lamp.review.json"), {
      sha256: hash,
      at: "2026-01-01T00:00:00Z",
    });
    writeFileSync(join(root, "lamp.review.json"), writeReview(record));
    writeFileSync(join(root, "guide.md"), "\n```yaml\nformat: assetgrove-card/1\n```\n");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD").trim();
    writeFileSync(join(root, "lamp.md"), card("light"));
    const absent = "a".repeat(64);
    writeFileSync(
      join(root, "lamp.bin"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${absent}\nsize 4\n`,
    );
    writeFileSync(join(root, "lamp.small.bin"), bytes);
    record = appendVersion(record, { sha256: absent, at: "2026-01-02T00:00:00Z" });
    record = appendAnnotation(record, {
      type: "Annotation",
      motivation: "commenting",
      created: "2026-01-02T01:00:00Z",
      target: { source: "lamp.bin", "ag:version": absent },
      body: { type: "TextualBody", value: "Synthetic review" },
    });
    writeFileSync(join(root, "lamp.review.json"), writeReview(record));
    git("add", ".");
    git("commit", "-m", "head");
    const head = git("rev-parse", "HEAD").trim();
    const status = git("status", "--porcelain=v1");
    const run = () =>
      execFileSync(
        process.execPath,
        [cli, "library", "diff", "--target", root, "--base", base, "--head", head, "--json"],
        { encoding: "utf8", timeout: 30_000 },
      );
    const added = execFileSync(
      process.execPath,
      [cli, "library", "diff", "--target", root, "--base", empty, "--head", base, "--json"],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(JSON.parse(added).changes[0].change, "added");
    const output = run();
    assert.equal(run(), output);
    const result = JSON.parse(output);
    const change = result.changes?.[0] ?? result.result?.changes?.[0];
    assert.ok(change, output);
    assert.deepEqual(change.categories, ["version", "labels", "reviews", "renditions", "media"]);
    assert.deepEqual(change.before.labels, ["prop"]);
    assert.deepEqual(change.after.labels, ["light"]);
    assert.equal(change.after.media.status, "missing_lfs_object");
    assert.equal(change.after.media.preview, undefined);
    assert.equal(
      change.before.media.preview,
      `https://github.com/example/fixture/blob/${base}/lamp.bin`,
    );
    assert.equal(
      change.after.renditions[0].preview,
      `https://github.com/example/fixture/blob/${head}/lamp.small.bin`,
    );
    assert.equal(git("status", "--porcelain=v1"), status);
    assert.equal(git("rev-parse", "HEAD").trim(), head);
    const object = join(root, ".git", "lfs", "objects", absent.slice(0, 2), absent.slice(2, 4));
    mkdirSync(object, { recursive: true });
    writeFileSync(join(object, absent), "nope");
    assert.match(run(), /invalid_lfs_object/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("library diff refuses unavailable promised blobs without fetching", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-promised-")));
  const source = join(root, "source"),
    clone = join(root, "clone");
  mkdirSync(source);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  try {
    git(source, "init");
    git(source, "config", "user.name", "Fixture");
    git(source, "config", "user.email", "fixture@example.invalid");
    git(source, "config", "uploadpack.allowFilter", "true");
    writeFileSync(
      join(source, "card.md"),
      "---\ntype: Game Asset\nformat: assetgrove-card/1\ntitle: Fixture\nresource: card.bin\n---\n",
    );
    writeFileSync(join(source, "card.bin"), "synthetic");
    git(source, "add", ".");
    git(source, "commit", "-m", "fixture");
    git(root, "clone", "--filter=blob:none", "--no-checkout", pathToFileURL(source).href, clone);
    const pack = join(clone, ".git", "objects", "pack");
    const before = readdirSync(pack).sort();
    assert.throws(
      () => libraryDiff(clone, "HEAD", "HEAD"),
      /Cannot read local Git revision.*unavailable/,
    );
    assert.deepEqual(readdirSync(pack).sort(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
