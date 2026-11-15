import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SWEPT = ["src/", "test/", "skills/", "docs/", "bench/", "packages/"];
const EXEMPT = ["policy/", "test/fixtures/prompt-policy/", "test/fixtures/names.json"];
const MAX_BYTES = 4 * 1024 * 1024;

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

function words(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function hashes(text: string): string[] {
  const w = words(text);
  const out = w.map(sha);
  for (let i = 0; i + 1 < w.length; i++) out.push(sha(`${w[i]} ${w[i + 1]}`));
  return out;
}

const fixture = JSON.parse(readFileSync(join(root, "test/fixtures/names.json"), "utf8")) as {
  format: string;
  sha256: string[];
};

test("names.json is well formed", () => {
  assert.equal(fixture.format, "assetgrove-names/1");
  assert.ok(fixture.sha256.length > 0);
  for (const h of fixture.sha256) assert.match(h, /^[0-9a-f]{64}$/);
  assert.deepEqual(fixture.sha256, [...new Set(fixture.sha256)].sort());
});

test("the normaliser splits words and hashes adjacent pairs", () => {
  assert.deepEqual(words("FOO_BAR-baz"), ["foo", "bar", "baz"]);
  assert.deepEqual(words("Café.ÉCOLE"), ["cafe", "ecole"]);
  assert.deepEqual(hashes("FOO_BAR-baz"), [
    sha("foo"),
    sha("bar"),
    sha("baz"),
    sha("foo bar"),
    sha("bar baz"),
  ]);
});

test("no listed name appears in the swept files", () => {
  const listed = new Set(fixture.sha256);
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(
      (f) =>
        f &&
        (f === "README.md" || SWEPT.some((p) => f.startsWith(p))) &&
        !EXEMPT.some((p) => f.startsWith(p)),
    );
  const hits: string[] = [];
  for (const file of files) {
    let size: number;
    try {
      size = statSync(join(root, file)).size;
    } catch {
      continue;
    }
    if (size > MAX_BYTES) continue;
    const buf = readFileSync(join(root, file));
    if (buf.subarray(0, 8192).includes(0)) continue;
    buf
      .toString("utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const h of hashes(line)) {
          if (listed.has(h)) hits.push(`${file}:${i + 1} ${h.slice(0, 12)}`);
        }
      });
  }
  assert.deepEqual(hits, [], `listed names found:\n${hits.join("\n")}`);
});
