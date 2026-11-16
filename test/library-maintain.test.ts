/**
 * `library check`, `library rebuild`, `library stats` and `library drift` (issue #233), run through
 * the real CLI on libraries built by real picks in temporary Git repositories.
 */
import "./fixtures/env.ts";
import { approve } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCard } from "../src/library/card.ts";
import {
  appendAnnotation,
  appendVersion,
  parseReview,
  writeReview,
} from "../src/library/review.ts";
import type { AssetSpec } from "../src/types.ts";
import { gitTarget } from "./fixtures/git.ts";
import { fixtureLibrary } from "./fixtures/library.ts";
import { syntheticWorld } from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const variantScript = fileURLToPath(new URL("./fixtures/script-variant.ts", import.meta.url));
approve(passingScript, variantScript);

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

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

const doc = (result: Result): Doc => JSON.parse(result.stdout);
const text = (path: string) => readFile(path, "utf8");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    encoding: "utf8",
  });

const LFS = "*.png filter=lfs diff=lfs merge=lfs -text\n";
const UNION = "index.md merge=union\nlog.md merge=union\n*.review.json merge=union\n";
const NEEDS_SAME_ASSET = ["lantern.review.json", "log.md"];
const FOLDER = "props/lights";

interface Library {
  world: World;
  target: string;
  profile: string;
  lib: (command: string, ...extra: string[]) => Promise<Result>;
}

const stillSpec = (assetId: string): AssetSpec => ({ kind: "still", assetId, subject: "fern" });

async function pickStill(world: World, assetId: string, script = passingScript): Promise<Doc> {
  const profile = join(world.dir, "profile.json");
  const specPath = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  await writeFile(specPath, JSON.stringify(stillSpec(assetId)));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  const staged = await cli([
    "stage",
    ...["--spec", specPath, "--bible", bible, "--profile", profile],
    ...["--runs", world.runsDir, "--candidates", "1"],
    ...["--provider-script", script, "--json"],
  ]);
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const picked = await cli([
    ...["pick", "--run", doc(staged)["runDir"], "--candidate", "c1"],
    ...["--target", world.targetDir, "--json"],
  ]);
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);
  return doc(picked);
}

/** A Git target with media mapped to LFS and a library of the named assets, built by picks. */
async function library(
  assets: string[] = ["lantern", "torch"],
  gitattributes = LFS,
): Promise<Library> {
  const world = await syntheticWorld();
  gitTarget(world.targetDir);
  await writeFile(join(world.targetDir, ".gitattributes"), gitattributes);
  Object.assign(world.profile, {
    layout: {
      media: `${FOLDER}/{{spec.assetId}}.{{output.extension}}`,
      manifest: "manifests/{{spec.assetId}}.json",
    },
    manifest: {
      assetId: "{{spec.assetId}}",
      review: { status: "pending" },
      contentHash: "{{output.sha256}}",
    },
  });
  delete world.profile.validator;
  for (const id of assets) await pickStill(world, id);
  const profile = join(world.dir, "profile.json");
  return {
    world,
    target: world.targetDir,
    profile,
    lib: (command, ...extra) =>
      cli([
        "library",
        command,
        "--target",
        world.targetDir,
        "--profile",
        profile,
        ...extra,
        "--json",
      ]),
  };
}

const dir = (l: Library) => join(l.target, FOLDER);

/** Every index.md and log.md under the library, with its text. */
async function projections(l: Library): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir(l), { recursive: true })) {
    const name = entry.toString();
    if (/(^|\/)(index|log)\.md$/.test(name)) out[name] = await text(join(dir(l), name));
  }
  return out;
}

test("library check on a library built by picks exits 0, and a missing card, a hand-edited machine field and media not mapped to LFS each exit 6", async () => {
  const l = await library();
  const ok = await l.lib("check");
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.deepEqual(doc(ok)["problems"], []);
  assert.deepEqual(doc(ok)["needsRebuild"], []);

  const card = join(dir(l), "lantern.md");
  const original = await text(card);

  await rm(card);
  let bad = await l.lib("check");
  assert.equal(bad.code, 6);
  assert.equal(doc(bad)["error"].code, "library_check_failed");
  assert.deepEqual(doc(bad)["error"].problems, [{ file: "lantern.md", code: "card_missing" }]);
  await writeFile(card, original);

  await writeFile(card, original.replace(/^state: .*$/m, "state: rejected"));
  bad = await l.lib("check");
  assert.equal(bad.code, 6);
  assert.deepEqual(doc(bad)["error"].problems, [
    { file: "lantern.md", code: "machine_field_mismatch" },
  ]);
  await writeFile(card, original);
  assert.equal((await l.lib("check")).code, 0);

  await writeFile(join(l.target, ".gitattributes"), "*.glb filter=lfs\n");
  bad = await l.lib("check");
  assert.equal(bad.code, 6);
  assert.deepEqual(
    doc(bad)["error"].problems.map((p: Doc) => p.code),
    ["media_not_lfs", "media_not_lfs"],
  );
  assert.deepEqual(
    doc(bad)["error"].problems.map((p: Doc) => p.file),
    ["lantern.png", "torch.png"],
  );
});

test("after a union merge of two branches' log, index and review-record lines, check exits 0 listing needsRebuild; rebuild clears it and a second rebuild changes nothing", async () => {
  const l = await library(["lantern"], LFS + UNION);
  git(l.target, "add", "-A");
  git(l.target, "commit", "-q", "-m", "base");
  const base = git(l.target, "rev-parse", "HEAD").trim();
  const reviewPath = join(dir(l), "lantern.review.json");

  const branch = async (name: string, value: string, created: string) => {
    git(l.target, "checkout", "-q", "-b", name, base);
    const record = parseReview(await text(reviewPath), reviewPath);
    const next = appendAnnotation(record, {
      type: "Annotation",
      motivation: "describing",
      created,
      target: "lantern.png",
      "ag:action": "card-edit",
      body: { type: "TextualBody", value, purpose: "describing" },
    });
    await writeFile(reviewPath, writeReview(next));
    const rebuilt = await l.lib("rebuild");
    assert.equal(rebuilt.code, 0, rebuilt.stdout + rebuilt.stderr);
    git(l.target, "add", "-A");
    git(l.target, "commit", "-q", "-m", name);
  };
  await branch("a", "title from a", "2099-01-01T10:00:00Z");
  await branch("b", "title from b", "2099-01-02T10:00:00Z");
  git(l.target, "checkout", "-q", "a");
  git(l.target, "merge", "-q", "--no-edit", "b");

  const checked = await l.lib("check");
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);
  const needs = doc(checked)["needsRebuild"] as string[];
  assert.deepEqual(needs, NEEDS_SAME_ASSET);

  const rebuilt = await l.lib("rebuild");
  assert.equal(rebuilt.code, 0, rebuilt.stdout + rebuilt.stderr);
  assert.ok(doc(rebuilt)["rebuilt"].length > 0);
  const after = await l.lib("check");
  assert.equal(after.code, 0);
  assert.deepEqual(doc(after)["needsRebuild"], []);
  const record = parseReview(await text(reviewPath), reviewPath);
  assert.equal(record.annotations.filter((a) => a["ag:action"] === "card-edit").length, 2);
  const lines = (await text(join(dir(l), "log.md")))
    .split("\n")
    .filter((x) => x.includes("card-edit"));
  assert.equal(lines.length, 2);

  const before = await projections(l);
  const again = await l.lib("rebuild");
  assert.deepEqual(doc(again)["rebuilt"], []);
  assert.deepEqual(await projections(l), before);
});

test("two branches that each pick a different asset merge their index and log lines; check lists them under needsRebuild and rebuild clears it", async () => {
  const l = await library(["lantern"], LFS + UNION);
  git(l.target, "add", "-A");
  git(l.target, "commit", "-q", "-m", "base");
  const base = git(l.target, "rev-parse", "HEAD").trim();
  for (const id of ["torch", "lamp"]) {
    git(l.target, "checkout", "-q", "-b", id, base);
    await pickStill(l.world, id);
    git(l.target, "add", "-A");
    git(l.target, "commit", "-q", "-m", id);
  }
  git(l.target, "checkout", "-q", "torch");
  git(l.target, "merge", "-q", "--no-edit", "lamp");
  const checked = await l.lib("check");
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);
  assert.deepEqual(doc(checked)["needsRebuild"], ["log.md"]);
  const merged = await projections(l);
  assert.match(merged["index.md"]!, /lamp/);
  assert.match(merged["index.md"]!, /torch/);
  const rebuilt = await l.lib("rebuild");
  assert.equal(rebuilt.code, 0, rebuilt.stdout + rebuilt.stderr);
  assert.deepEqual(doc(rebuilt)["rebuilt"], ["log.md"]);
  assert.deepEqual(doc(await l.lib("check"))["needsRebuild"], []);
  assert.deepEqual(doc(await l.lib("rebuild"))["rebuilt"], []);
});

test("a check on an empty library, a hand-edited resource and a deleted provenance source", async () => {
  const empty = await library([]);
  await writeFile(empty.profile, JSON.stringify(empty.world.profile));
  const none = await empty.lib("check");
  assert.equal(none.code, 0, none.stdout + none.stderr);

  const l = await library(["lantern"]);
  const card = join(dir(l), "lantern.md");
  const original = await text(card);
  await writeFile(card, original.replace(/^resource: .*$/m, "resource: torch.png"));
  assert.equal((await l.lib("check")).code, 6);
  await writeFile(card, original.replace(/^ {2}- \{ id: provenance.*\n/m, ""));
  assert.equal((await l.lib("check")).code, 6);
  await writeFile(card, original);
  assert.equal((await l.lib("check")).code, 0);
});

test("drift refuses a style bible that cannot be read", async () => {
  const l = await library(["lantern"]);
  const drift = await l.lib("drift", "--bible", join(l.world.dir, "absent.json"));
  assert.equal(drift.code, 2);
  assert.equal(doc(drift)["error"].code, "invalid_input");
});

test("after every index.md and log.md is deleted, rebuild restores them byte for byte", async () => {
  const l = await library();
  const before = await projections(l);
  assert.ok(Object.keys(before).length >= 2);
  for (const name of Object.keys(before)) await rm(join(dir(l), name));
  const missing = await l.lib("check");
  assert.equal(missing.code, 6);
  const rebuilt = await l.lib("rebuild");
  assert.equal(rebuilt.code, 0, rebuilt.stdout + rebuilt.stderr);
  assert.deepEqual(await projections(l), before);
  assert.equal((await l.lib("check")).code, 0);
});

test("rebuild rewrites a hand-edited machine field and keeps the person's fields", async () => {
  const l = await library(["lantern"]);
  const card = join(dir(l), "lantern.md");
  const original = await text(card);
  await writeFile(
    card,
    original
      .replace(/^state: .*$/m, "state: rejected")
      .replace(/^title: .*$/m, "title: Hand title"),
  );
  assert.equal((await l.lib("check")).code, 6);
  assert.equal((await l.lib("rebuild")).code, 0);
  const next = await text(card);
  assert.match(next, /^state: pending$/m);
  assert.match(next, /^title: Hand title$/m);
});

test("a bible version change adds one root-log line on the first write, none on the second, and rebuild keeps it; drift lists stale and modified assets", async () => {
  const l = await library(["lantern"]);
  const logPath = join(dir(l), "log.md");
  const bibleLines = async () => (await text(logPath)).split("\n").filter((x) => / bible /.test(x));
  assert.deepEqual(await bibleLines(), []);

  l.world.bible.version = "synthetic-2";
  await pickStill(l.world, "torch");
  const lines = await bibleLines();
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /bible synthetic-1 → synthetic-2$/);
  await pickStill(l.world, "lamp");
  assert.deepEqual(await bibleLines(), lines);
  assert.equal((await l.lib("rebuild")).code, 0);
  assert.deepEqual(await bibleLines(), lines);
  assert.equal((await l.lib("check")).code, 0);
  // A rebuild that has the root log to re-render keeps the line.
  const current = await text(logPath);
  const heading = /^## .*$/m.exec(current)![0];
  await writeFile(logPath, current.replace(heading, `${heading}\n\n${heading}`));
  const laid = await l.lib("rebuild");
  assert.ok(doc(laid)["rebuilt"].includes("log.md"), laid.stdout);
  assert.deepEqual(await bibleLines(), lines);

  const bible = join(l.world.dir, "current-bible.json");
  await writeFile(bible, JSON.stringify({ version: "synthetic-2" }));
  const drift = await l.lib("drift", "--bible", bible);
  assert.equal(drift.code, 0, drift.stdout + drift.stderr);
  assert.deepEqual(
    doc(drift)["stale"].map((s: Doc) => s.asset),
    ["lantern"],
  );
  assert.deepEqual(doc(drift)["modified"], []);

  // A changed file is modified; a pointer is compared by its oid.
  const lantern = join(dir(l), "lantern.png");
  const torch = join(dir(l), "torch.png");
  const lamp = join(dir(l), "lamp.png");
  const torchBytes = await readFile(torch);
  const pointer = (oid: string) =>
    `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${torchBytes.length}\n`;
  await writeFile(lantern, Buffer.concat([await readFile(lantern), Buffer.from("edit")]));
  await writeFile(torch, pointer(sha256(torchBytes)));
  await writeFile(lamp, pointer("0".repeat(64)));
  const changed = await l.lib("drift", "--bible", bible);
  assert.deepEqual((doc(changed)["modified"] as Doc[]).map((m) => m.asset as string).sort(), [
    "lamp",
    "lantern",
  ]);
});

test("library stats counts by kind and state and gives the share of change requests approved within two new versions", async () => {
  const l = await library();
  const fake = (n: number) => String(n).repeat(64);
  const record = async (
    id: string,
    steps: (r: ReturnType<typeof parseReview>) => ReturnType<typeof parseReview>,
  ) => {
    const path = join(dir(l), `${id}.review.json`);
    await writeFile(path, writeReview(steps(parseReview(await text(path), path))));
  };
  const version = (r: ReturnType<typeof parseReview>, n: number, day: number) =>
    appendVersion(r, { sha256: fake(n), at: `2099-01-0${day}T10:00:00Z` });
  const request = (r: ReturnType<typeof parseReview>, id: string, sha: string, day: number) =>
    appendAnnotation(r, {
      type: "Annotation",
      motivation: "editing",
      created: `2099-01-0${day}T09:00:00Z`,
      target: { source: `${id}.png`, "ag:version": sha },
      body: { type: "TextualBody", value: "darker", purpose: "editing" },
    });
  const approve2 = (r: ReturnType<typeof parseReview>, id: string, sha: string, day: number) =>
    appendAnnotation(r, {
      type: "Annotation",
      motivation: "assessing",
      created: `2099-01-0${day}T11:00:00Z`,
      target: { source: `${id}.png`, "ag:version": sha },
      "ag:action": "approve",
    });
  // lantern: a request on v1 answered by v2, approved: counts. torch: a request on v1, approved
  // only at v4, three versions later: does not.
  await record("lantern", (r) => {
    const v1 = r.versions[0]!.sha256;
    return approve2(version(request(r, "lantern", v1, 2), 1, 3), "lantern", fake(1), 4);
  });
  await record("torch", (r) => {
    const v1 = r.versions[0]!.sha256;
    let next = request(r, "torch", v1, 2);
    next = version(next, 2, 3);
    next = version(next, 3, 4);
    next = version(next, 4, 5);
    return approve2(next, "torch", fake(4), 6);
  });
  const stats = await l.lib("stats");
  assert.equal(stats.code, 0, stats.stdout + stats.stderr);
  const d = doc(stats);
  assert.deepEqual(d["byKind"], { still: 2 });
  assert.deepEqual(d["byState"], { approved: 2 });
  assert.deepEqual(d["changeRequests"], { total: 2, approvedWithinTwoVersions: 1, share: 0.5 });
  await mkdir(join(l.world.dir, "unused"), { recursive: true });
});

test("a pick whose profile embeds provenance in the manifest, over a version with a provenance file of its own, needs no rebuild and keeps the current version's bible and time (#349)", async () => {
  const l = await library(["lantern"]);
  const beside = join(dir(l), "lantern.png.provenance.json");
  const stale = JSON.parse(await text(beside)) as Doc;
  assert.equal(stale["bibleVersion"], "synthetic-1");

  // Version 2 is made under a newer bible, by a profile that keeps provenance in the manifest; the
  // first version's provenance file stays beside the media.
  l.world.bible.version = "synthetic-2";
  (l.world.profile.manifest as Doc)["provenance"] = "{{provenance}}";
  const out = await pickStill(l.world, "lantern", variantScript);
  assert.equal(out["library"].version, 2);
  assert.deepEqual(JSON.parse(await text(beside)), stale);
  const manifest = JSON.parse(await text(join(l.target, "manifests", "lantern.json"))) as Doc;
  const current = manifest["provenance"] as Doc;
  assert.equal(current["bibleVersion"], "synthetic-2");
  assert.notEqual(current["finishedAt"], stale["finishedAt"]);

  const card = join(dir(l), "lantern.md");
  const picked = await text(card);
  const checked = await l.lib("check");
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);
  assert.deepEqual(doc(checked)["needsRebuild"], []);
  const fields = (t: string) => parseCard(t, card).data as Doc;
  assert.equal(fields(picked)["bible"], "synthetic-2");
  assert.equal(fields(picked)["generated"].at, current["finishedAt"]);

  // Rebuild changes nothing, the first time and the second.
  for (let run = 0; run < 2; run++) {
    const rebuilt = await l.lib("rebuild");
    assert.equal(rebuilt.code, 0, rebuilt.stdout + rebuilt.stderr);
    assert.deepEqual(doc(rebuilt)["rebuilt"], []);
    assert.equal(await text(card), picked);
  }
});

test("rebuild run twice on the round-trip fixture library changes nothing the second time (#349)", async () => {
  const fixture = fixtureLibrary();
  const rebuild = () =>
    cli([
      ...["library", "rebuild", "--target", fixture.dir],
      ...["--profile", join(fixture.dir, ".assetgrove", "profile.json"), "--json"],
    ]);
  const first = await rebuild();
  // The root folder (lantern, rock, walk, boat, and escape.md, whose resource leaves the root) is
  // among the projections rebuilt, as well as props/.
  assert.deepEqual(
    [...doc(first)["rebuilt"]].sort(),
    ["index.md", "log.md", "props/index.md", "props/log.md"],
    first.stdout + first.stderr,
  );
  const second = await rebuild();
  assert.deepEqual(doc(second)["rebuilt"], [], second.stdout);
  assert.deepEqual(doc(second)["problems"], doc(first)["problems"]);
});

test("a neighbour's card or review record with conflict markers keeps the folder's index and log rows through rebuild and through a pick of another asset, and is named (#349)", async () => {
  const l = await library();
  // The library root is the asset folder: its log also carries the bible lines.
  const indexPath = join(dir(l), "index.md");
  const logPath = join(dir(l), "log.md");
  let index = "";
  let log = "";
  const rows = (t: string, id: string) => t.split("\n").filter((x) => x.includes(`](${id}.md)`));
  const bibleLine = /bible synthetic-1 → synthetic-2$/m;
  // Every row the neighbour had is still there.
  const kept = async () => {
    assert.deepEqual(rows(await text(indexPath), "torch"), rows(index, "torch"));
    assert.deepEqual(rows(await text(logPath), "torch"), rows(log, "torch"));
  };

  const conflicted = async (path: string, edit: (original: string) => string) => {
    const original = await text(path);
    await writeFile(path, edit(original));
    return () => writeFile(path, original);
  };
  const cases = [
    {
      file: "torch.md",
      code: "card_invalid",
      edit: (t: string) =>
        t.replace(
          /^title: (.*)$/m,
          "<<<<<<< ours\ntitle: $1\n=======\ntitle: Torch from b\n>>>>>>> theirs",
        ),
    },
    {
      // A whole-file conflict: the marker is on line 1, so the file has no front matter at all.
      file: "torch.md",
      code: "card_invalid",
      edit: (t: string) =>
        `<<<<<<< ours\n${t}=======\n${t.replace(/^title: .*$/m, "title: Torch from b")}>>>>>>> theirs\n`,
    },
    {
      file: "torch.review.json",
      code: "review_invalid",
      edit: (t: string) => {
        const lines = t.split("\n");
        lines.splice(2, 0, "<<<<<<< ours", "=======", ">>>>>>> theirs");
        return lines.join("\n");
      },
    },
  ];
  for (const [n, c] of cases.entries()) {
    index = await text(indexPath);
    log = await text(logPath);
    assert.match(index, /torch/);
    assert.match(log, /torch/);
    const restore = await conflicted(join(dir(l), c.file), c.edit);
    const rebuilt = await l.lib("rebuild");
    assert.equal(rebuilt.code, 6, rebuilt.stdout + rebuilt.stderr);
    assert.deepEqual(doc(rebuilt)["error"].problems, [{ file: c.file, code: c.code }]);
    assert.ok(!doc(rebuilt)["rebuilt"].some((f: string) => /(index|log)\.md$/.test(f)));
    assert.equal(await text(indexPath), index);
    assert.equal(await text(logPath), log);

    // A pick of another asset in the folder, the first under a newer bible, succeeds, names the
    // file it could not read, writes its own rows and the bible line, and keeps the neighbour's.
    if (n === 0) l.world.bible.version = "synthetic-2";
    const out = await pickStill(l.world, `lamp${n}`);
    assert.deepEqual(
      (out["library"].unreadable as Doc[]).map((u) => [u.file.split(/[\\/]/).at(-1), u.code]),
      [[c.file, c.code]],
    );
    await kept();
    assert.equal(rows(await text(indexPath), `lamp${n}`).length, 1);
    assert.ok(rows(await text(logPath), `lamp${n}`).length > 0);
    assert.match(await text(logPath), bibleLine);
    // Rebuild while the file is still broken keeps all of it.
    const again = await l.lib("rebuild");
    assert.equal(again.code, 6, again.stdout + again.stderr);
    assert.ok(!doc(again)["rebuilt"].some((f: string) => /(index|log)\.md$/.test(f)));

    await restore();
    const fixed = await l.lib("rebuild");
    assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
    await kept();
    assert.equal(rows(await text(indexPath), `lamp${n}`).length, 1);
    assert.match(await text(logPath), bibleLine);
    assert.equal((await l.lib("check")).code, 0);
    assert.deepEqual(doc(await l.lib("rebuild"))["rebuilt"], []);
  }
});

test("an unreadable card whose folder's index.md does not parse either leaves that index as it is, reported, through rebuild and a pick of another asset (#349)", async () => {
  const l = await library();
  const indexPath = join(dir(l), "index.md");
  const cardPath = join(dir(l), "torch.md");
  const index = await text(indexPath);
  const card = await text(cardPath);
  assert.match(index, /\]\(torch\.md\)/);
  assert.match(index, /^game: /m);
  await writeFile(
    cardPath,
    card.replace(
      /^title: (.*)$/m,
      "<<<<<<< ours\ntitle: $1\n=======\ntitle: Torch from b\n>>>>>>> theirs",
    ),
  );
  const brokenIndex = index.replace(
    /^game: (.*)$/m,
    "<<<<<<< ours\ngame: $1\n=======\ngame: Other\n>>>>>>> theirs",
  );
  await writeFile(indexPath, brokenIndex);
  const codes = (list: Doc[]) => list.map((u) => [u.file.split(/[\\/]/).at(-1), u.code]).sort();

  const rebuilt = await l.lib("rebuild");
  assert.equal(rebuilt.code, 6, rebuilt.stdout + rebuilt.stderr);
  assert.deepEqual(codes(doc(rebuilt)["error"].problems), [
    ["index.md", "index_invalid"],
    ["torch.md", "card_invalid"],
  ]);
  assert.ok(!doc(rebuilt)["rebuilt"].some((f: string) => /index\.md$/.test(f)));
  assert.equal(await text(indexPath), brokenIndex);

  const out = await pickStill(l.world, "lamp");
  assert.deepEqual(codes(out["library"].unreadable as Doc[]), [
    ["index.md", "index_invalid"],
    ["torch.md", "card_invalid"],
  ]);
  assert.equal(await text(indexPath), brokenIndex);

  // Fixed, both files rebuild: the torch row is still there and the lamp row is added.
  await writeFile(cardPath, card);
  await writeFile(indexPath, index);
  const fixed = await l.lib("rebuild");
  assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
  assert.match(await text(indexPath), /\]\(torch\.md\)/);
  assert.match(await text(indexPath), /\]\(lamp\.md\)/);
  assert.equal((await l.lib("check")).code, 0);
});

test("a notes file whose front matter only mentions Game Asset is not a card, and does not hide a folder's mismatch (#375)", async () => {
  const l = await library(["lantern"]);
  await writeFile(
    join(dir(l), "naming.md"),
    "---\ntitle: Game Asset naming rules\n---\nName assets plainly.\n",
  );
  const ok = await l.lib("check");
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.deepEqual(doc(ok)["problems"], []);
  assert.deepEqual(doc(ok)["needsRebuild"], []);

  await rm(join(dir(l), "index.md"));
  const missing = await l.lib("check");
  assert.equal(missing.code, 6);
  assert.deepEqual(doc(missing)["error"].problems, [{ file: "index.md", code: "index_missing" }]);
});
