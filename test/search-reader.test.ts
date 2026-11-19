/** The library reader core supplies to search, and find's numbered sheet (issue #237, design 7.1). */
import "./fixtures/env.ts";
import { stateDir } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { encodePng, decodePng } from "../src/image/raster.ts";
import { createLibraryReader } from "../src/search/reader.ts";
import { appendVersion, parseReview, writeReview } from "../src/library/review.ts";
import { writeFindSheet } from "../src/search/sheet.ts";
import { GAME, RUN_ID, fixtureLibrary } from "./fixtures/library.ts";
import { drawSubject } from "./fixtures/synthetic.ts";

const git = (dir: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, encoding: "utf8" },
  ).trim();

test("search evidence follows the picked review version when the card lock is stale", async () => {
  const lib = fixtureLibrary();
  const cardPath = join(lib.root, "lantern.md");
  const bytes = readFileSync(join(lib.root, "lantern.png"));
  const oldHash = createHash("sha256").update(bytes).digest("hex");
  const card = readFileSync(cardPath, "utf8").replace(
    /sha256: [0-9a-f]{64}/g,
    `sha256: ${oldHash}`,
  );
  writeFileSync(cardPath, card);
  const reviewPath = join(lib.root, "lantern.review.json");
  const nextHash = "f".repeat(64);
  const review = appendVersion(parseReview(readFileSync(reviewPath, "utf8"), reviewPath), {
    sha256: nextHash,
    at: "2099-01-01T00:00:00Z",
  });
  writeFileSync(reviewPath, writeReview(review));
  const reader = await createLibraryReader({
    dir: lib.dir,
    stateDir,
    settings: { folders: [], candidates: false },
  });
  const item = (await reader.list()).find((item) => item.id === "lantern")!;
  assert.equal(item.mediaSha256, nextHash);
  assert.equal(item.mediaStatus, "unavailable");
  assert.equal(item.mediaReason, "hash_mismatch");
  assert.equal(item.width, undefined);
});

test("the reader lists picks, runs and folders, loads on demand, and reports Git state", async () => {
  const lib = fixtureLibrary();
  const folder = mkdtempSync(join(tmpdir(), "assetgrove-search-folder-"));
  mkdirSync(join(folder, "sub"));
  writeFileSync(join(folder, "sub", "a.png"), encodePng(drawSubject(16)));
  writeFileSync(join(folder, "notes.txt"), "not an image");
  const reader = await createLibraryReader({
    dir: lib.dir,
    stateDir: stateDir,
    settings: { folders: [folder], candidates: true },
  });
  assert.equal(reader.game, GAME);

  const items = await reader.list();
  const picks = items.filter((i) => i.source === "pick");
  const lantern = picks.find((i) => i.id === "lantern");
  assert.ok(lantern);
  assert.equal(lantern.address, `asset://${GAME}/lantern`);
  assert.equal(lantern.game, GAME);
  assert.ok(lantern.path.startsWith("assets/") && !lantern.path.includes("\\"));
  assert.ok(lantern.size > 0 && lantern.mtimeMs > 0);
  assert.deepEqual(lantern.tags, ["prop", "light"]);
  assert.match(lantern.text ?? "", /prop/);
  assert.ok(picks.find((i) => i.id === "fern"));

  assert.ok(!items.some((i) => i.path.includes("outside")), "no path outside the library root");
  assert.ok(!picks.some((i) => i.id === "escape"));
  assert.ok(items.every((i) => i.source === "folder" || !i.path.startsWith("..")));

  const candidates = items.filter((i) => i.source === "candidate");
  assert.ok(candidates.some((c) => c.id === `${RUN_ID}/c1`));
  assert.equal(
    candidates.find((c) => c.id === `${RUN_ID}/c1`)?.address,
    `asset://${GAME}/runs/${RUN_ID}/c1`,
  );

  const folderItems = items.filter((i) => i.source === "folder");
  assert.equal(folderItems.length, 1);
  assert.equal(folderItems[0]?.path, join(folder, "sub", "a.png"));
  assert.equal(folderItems[0]?.address, pathToFileURL(join(folder, "sub", "a.png")).href);

  const loaded = await reader.load(lantern);
  assert.equal(loaded.views.length, 1);
  assert.ok(loaded.bytes.length > 0);
  await assert.rejects(reader.load({ ...lantern, path: "../outside.png" }), /not a file/);

  const without = await createLibraryReader({
    dir: lib.dir,
    stateDir: stateDir,
    settings: { folders: [], candidates: false },
  });
  assert.deepEqual(
    (await without.list(["candidate", "folder"])).map((i) => i.source),
    [],
  );

  assert.equal(await reader.clean(), false, "untracked files are not clean");
  git(lib.dir, "add", "-A");
  git(lib.dir, "commit", "-q", "-m", "fixture");
  assert.equal(await reader.head(), git(lib.dir, "rev-parse", "HEAD"));
  assert.equal(await reader.origin(), git(lib.dir, "rev-list", "--max-parents=0", "HEAD").trim());
  assert.equal(await reader.clean(), true);
  writeFileSync(
    join(lib.root, "lantern.md"),
    `${readFileSync(join(lib.root, "lantern.md"), "utf8")}\nedit\n`,
  );
  assert.equal(await reader.clean(), false);

  const sheetDir = join(folder, "sheets");
  const path = await writeFindSheet(
    [{ rank: 1 }, { rank: 2 }],
    [loaded.bytes, undefined],
    sheetDir,
  );
  assert.ok(path.startsWith(sheetDir) && path.endsWith(".png"));
  assert.ok(decodePng(new Uint8Array(readFileSync(path))).width > 0);
});

test("changedSince answers whether a shared index's files changed, not whether HEAD moved", async () => {
  const lib = fixtureLibrary();
  const reader = await createLibraryReader({
    dir: lib.dir,
    stateDir: stateDir,
    settings: { folders: [], candidates: true },
  });
  git(lib.dir, "add", "-A");
  git(lib.dir, "commit", "-q", "-m", "fixture");
  const built = git(lib.dir, "rev-parse", "HEAD");
  assert.equal(await reader.changedSince(built), false, "HEAD itself");

  // A code commit outside the library root and the bible: nothing indexed changed.
  mkdirSync(join(lib.dir, "src"), { recursive: true });
  writeFileSync(join(lib.dir, "src", "main.gd"), "extends Node\n");
  git(lib.dir, "add", "-A");
  git(lib.dir, "commit", "-q", "-m", "code");
  assert.notEqual(git(lib.dir, "rev-parse", "HEAD"), built);
  assert.equal(await reader.changedSince(built), false, "a code-only commit");

  // A commit under the library root changes it.
  writeFileSync(
    join(lib.root, "lantern.md"),
    `${readFileSync(join(lib.root, "lantern.md"), "utf8")}\nedit\n`,
  );
  git(lib.dir, "commit", "-q", "-am", "card");
  assert.equal(await reader.changedSince(built), true, "a card commit");

  // So does a bible commit, and a commit this clone does not have cannot be told apart.
  const afterCard = git(lib.dir, "rev-parse", "HEAD");
  writeFileSync(
    join(lib.dir, ".assetgrove", "art-direction", "BIBLE.md"),
    "---\nversion: 4\n---\n",
  );
  git(lib.dir, "commit", "-q", "-am", "bible");
  assert.equal(await reader.changedSince(afterCard), true, "a bible commit");
  assert.equal(await reader.changedSince("0".repeat(40)), true, "an unknown commit");
});
