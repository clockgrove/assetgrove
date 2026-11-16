/**
 * Staleness is judged, not read from a version sort (#366): "made under another bible version" is
 * an exact count by equality, so a rollback or a renamed version counts; which of those should be
 * redone is one `bible-staleness` decision per asset and version pair, made only by `library
 * judge-stale` (a paid command: plan step, confirmation, spend ledger), given the bible's diff from
 * its Git history, the asset's kind, subject and tags, and its thumbnail, and cached by the
 * asset's sha256 and the pair. `library drift` and `asset://<game>/stale/` list the cached yes
 * answers and never call a model.
 */
import "./fixtures/env.ts";
import { approve, ledgerPath, stateDir, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bibleChange, madeUnderOtherVersion } from "../src/library/stale.ts";
import { openProject } from "../src/tree/project.ts";
import { readTree } from "../src/tree/read.ts";
import { GAME, fixtureLibrary } from "./fixtures/library.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./fixtures/staleness-script.ts", import.meta.url));
approve(script);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

const doc = (r: Result): Doc => JSON.parse(r.stdout) as Doc;
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    encoding: "utf8",
  });

const lib = fixtureLibrary();
after(() => rm(lib.dir, { recursive: true, force: true }));
const bible = join(lib.dir, ".assetgrove", "art-direction", "BIBLE.md");
const writeBible = (version: string, glow: string) =>
  writeFileSync(
    bible,
    `---\nversion: ${version}\n---\n# Bible\n\nLanterns glow ${glow}.\nPlants are drawn with soft edges.\n`,
  );
// The bible's history: version 2, then 3, committed; the fixture's cards were made under them.
writeBible("2", "amber");
git(lib.dir, "add", ".assetgrove/art-direction/BIBLE.md");
git(lib.dir, "commit", "-q", "-m", "bible 2");
writeBible("3", "amber");
git(lib.dir, "commit", "-q", "-am", "bible 3");

const target = ["--target", lib.dir];
const runs = ["--runs", join(lib.dir, ".assetgrove", "runs")];
const judgeCalls = () =>
  existsSync(ledgerPath)
    ? readFileSync(ledgerPath, "utf8")
        .split("\n")
        .filter((l) => l.includes("bible-staleness")).length
    : 0;
const staleNames = async () =>
  (
    JSON.parse(
      (
        (await readTree(await openProject(lib.dir, stateDir), `asset://${GAME}/stale/`))
          .contents[0] as { text: string }
      ).text,
    ) as Doc
  ).children.map((c: Doc) => c.name);

test("versions are compared for equality: a rename and a rollback count, the current version does not", () => {
  assert.equal(madeUnderOtherVersion("spring", "autumn"), true, "a rename");
  assert.equal(madeUnderOtherVersion("3", "1"), true, "a rollback");
  assert.equal(madeUnderOtherVersion("3", "3"), false);
  assert.equal(madeUnderOtherVersion(undefined, "3"), false);
});

test("the bible's change between two versions comes from its Git history", () => {
  writeBible("4", "blue");
  try {
    const change = bibleChange(bible, "3");
    assert.match(change?.commit ?? "", /^[0-9a-f]{40}/);
    assert.match(change?.diff ?? "", /^-Lanterns glow amber\.$/m);
    assert.match(change?.diff ?? "", /^\+Lanterns glow blue\.$/m);
    // No text of the version in the history: no change to show, so nothing is judged.
    assert.equal(bibleChange(bible, "never"), undefined);
  } finally {
    writeBible("3", "amber");
  }
});

test("a bump marks nothing stale by itself; judge-stale asks per asset and drift and stale/ list the yes answers", async () => {
  // At the current version only fern (made under 2) was made under another version.
  const current = doc(await cli(["library", "drift", ...target, "--json"]));
  assert.deepEqual(
    current["otherVersion"].map((o: Doc) => o.asset),
    ["fern"],
  );

  // A bump: every card is made under another version now, an exact count, and none is stale yet.
  writeBible("4", "blue");
  const before = judgeCalls();
  const drift = doc(await cli(["library", "drift", ...target, "--json"]));
  const other = drift["otherVersion"] as Doc[];
  assert.equal(other.length, 6, JSON.stringify(other));
  assert.ok(other.every((o) => o.judgement === "unjudged"));
  assert.deepEqual(drift["stale"], []);
  assert.deepEqual(await staleNames(), []);
  assert.equal(judgeCalls(), before, "a read makes no call");

  // The forecast: one $0.001 call per asset not judged yet.
  const dry = doc(
    await cli([
      "library",
      "judge-stale",
      ...target,
      ...runs,
      "--provider-script",
      script,
      "--dry-run",
      "--json",
    ]),
  );
  assert.deepEqual(
    dry["jobs"].map((j: Doc) => [j.operation, j.count]),
    [["bible-staleness", 6]],
  );

  // A person must confirm the spend: attended settings with no TTY exit 8 and make no call.
  useAttended();
  const refused = await cli([
    "library",
    "judge-stale",
    ...target,
    ...runs,
    "--provider-script",
    script,
    "--json",
  ]);
  assert.equal(refused.code, 8, refused.stdout + refused.stderr);
  assert.equal(judgeCalls(), before);
});

test("judge-stale judges each asset once, given the diff, its subject and thumbnail, and caches the answer", async () => {
  writeBible("4", "blue");
  const before = judgeCalls();
  const judged = await cli([
    "library",
    "judge-stale",
    ...target,
    ...runs,
    "--provider-script",
    script,
    "--json",
  ]);
  assert.equal(judged.code, 0, judged.stdout + judged.stderr);
  const result = doc(judged);
  assert.equal(result["otherVersion"], 6);
  // Only the lantern's look changed: the script answers yes only for a lantern shown its
  // thumbnail and the amber-to-blue diff.
  assert.deepEqual(result["stale"], ["lantern"]);
  assert.equal(judgeCalls() - before, 6, "each call reached the spend ledger");
  assert.equal(
    readdirSync(join(stateDir, "staleness")).filter((f) => f.endsWith(".json")).length >= 6,
    true,
  );

  const drift = doc(await cli(["library", "drift", ...target, "--json"]));
  assert.deepEqual(
    drift["stale"].map((s: Doc) => s.asset),
    ["lantern"],
  );
  assert.equal(drift["otherVersion"].filter((o: Doc) => o.judgement === "keep").length, 5);
  assert.deepEqual(await staleNames(), ["lantern"]);

  // Cached: a second run makes no call and forecasts none.
  const again = doc(
    await cli([
      "library",
      "judge-stale",
      ...target,
      ...runs,
      "--provider-script",
      script,
      "--round",
      "2",
      "--json",
    ]),
  );
  assert.deepEqual(again["stale"], ["lantern"]);
  assert.ok(again["judged"].every((j: Doc) => j.cached === true));
  assert.equal(judgeCalls() - before, 6, "no new call");

  // A rollback to 3 makes the version-3 cards current again: only fern (2) is made under another.
  writeBible("3", "amber");
  const rolled = doc(await cli(["library", "drift", ...target, "--json"]));
  assert.deepEqual(
    rolled["otherVersion"].map((o: Doc) => [o.asset, o.judgement]),
    [["fern", "unjudged"]],
  );
  assert.deepEqual(rolled["stale"], []);
});

const judge = (...more: string[]) =>
  cli([
    "library",
    "judge-stale",
    ...target,
    ...runs,
    "--provider-script",
    script,
    ...more,
    "--json",
  ]);

test("a lost cache is refilled by running judge-stale again, from its journal and with no new call", async () => {
  // A version nothing was judged against, so the first run judges all six.
  writeBible("5", "blue");
  const first = await judge("--round", "5");
  assert.equal(first.code, 0, first.stdout + first.stderr);
  await rm(join(stateDir, "staleness"), { recursive: true, force: true });
  const lost = doc(await cli(["library", "drift", ...target, "--json"]));
  assert.ok(lost["otherVersion"].every((o: Doc) => o.judgement === "unjudged"));
  const before = judgeCalls();
  const again = await judge("--round", "5");
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.deepEqual(doc(again)["stale"], ["lantern"]);
  assert.equal(judgeCalls(), before, "the journal answers; nothing is paid twice");
  const drift = doc(await cli(["library", "drift", ...target, "--json"]));
  assert.deepEqual(
    drift["stale"].map((s: Doc) => s.asset),
    ["lantern"],
  );
  assert.equal(drift["otherVersion"].filter((o: Doc) => o.judgement === "unjudged").length, 0);
  writeBible("3", "amber");
});

test("--asset narrows what is judged, not the count of assets made under another version", async () => {
  writeBible("4", "blue");
  const one = doc(await judge("--asset", "lantern", "--round", "6"));
  assert.equal(one["otherVersion"], 6);
  assert.deepEqual(
    one["judged"].map((j: Doc) => j.asset),
    ["lantern"],
  );
  writeBible("3", "amber");
});

test("an asset with no thumbnail on this machine is left unjudged: no call, nothing cached", async () => {
  // A version no answer is cached for, and rock's media replaced by bytes that do not decode.
  writeBible("7", "blue");
  const find = (dir: string): string | undefined => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === ".assetgrove") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const hit = find(p);
        if (hit) return hit;
      } else if (e.name === "rock.png") return p;
    }
    return undefined;
  };
  const rock = find(lib.dir)!;
  const bytes = readFileSync(rock);
  writeFileSync(rock, "not an image");
  try {
    const before = judgeCalls();
    const dry = doc(await judge("--asset", "rock", "--dry-run"));
    assert.equal(
      (dry["jobs"] as Doc[]).reduce((n, j) => n + (j.count as number), 0),
      0,
    );
    const result = doc(await judge("--asset", "rock", "--round", "7"));
    assert.deepEqual(result["noThumbnail"], ["rock"]);
    assert.deepEqual(result["judged"], []);
    assert.equal(judgeCalls(), before);
    const drift = doc(await cli(["library", "drift", ...target, "--json"]));
    assert.equal(drift["otherVersion"].find((o: Doc) => o.asset === "rock").judgement, "unjudged");
  } finally {
    writeFileSync(rock, bytes);
    writeBible("3", "amber");
  }
});

test("an asset whose version the bible's history does not hold is left unjudged: no call, nothing cached", async () => {
  // A bible outside Git: its history holds no text of the cards' versions, so no change can be shown.
  const outside = join(lib.dir, "..", `bible-outside-${process.pid}.md`);
  writeFileSync(outside, "---\nversion: 9\n---\n# Bible\n\n- Lanterns glow blue.\n");
  try {
    const before = judgeCalls();
    const result = doc(await judge("--bible", outside, "--round", "9"));
    assert.equal(result["otherVersion"], 6);
    assert.equal((result["noHistory"] as string[]).length, 6);
    assert.deepEqual(result["judged"], []);
    assert.deepEqual(result["stale"], []);
    assert.equal(judgeCalls(), before, "no call is made without the bible's change");
    const drift = doc(await cli(["library", "drift", ...target, "--bible", outside, "--json"]));
    assert.ok(drift["otherVersion"].every((o: Doc) => o.judgement === "unjudged"));
  } finally {
    await rm(outside, { force: true });
  }
});

test("--asset naming a card with no lock.sha256 is refused for that reason, not as current", async () => {
  writeBible("4", "blue");
  const find = (dir: string): string | undefined => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === ".assetgrove") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const hit = find(p);
        if (hit) return hit;
      } else if (e.name === "rock.md") return p;
    }
    return undefined;
  };
  const card = find(lib.dir)!;
  const text = readFileSync(card, "utf8");
  assert.match(text, /^lock: .*\n/m);
  writeFileSync(card, text.replace(/^lock: .*\n/m, ""));
  try {
    const drift = doc(await cli(["library", "drift", ...target, "--json"]));
    assert.equal(drift["otherVersion"].find((o: Doc) => o.asset === "rock").sha256, null);
    const refused = await judge("--asset", "rock", "--dry-run");
    assert.equal(refused.code, 2, refused.stdout + refused.stderr);
    assert.match(refused.stdout + refused.stderr, /no lock\.sha256/);
    const current = await judge("--asset", "nothing-here", "--dry-run");
    assert.match(
      current.stdout + current.stderr,
      /is not an asset made under another bible version/,
    );
  } finally {
    writeFileSync(card, text);
    writeBible("3", "amber");
  }
});
