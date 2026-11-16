/**
 * A person reviews, approves, adopts hand edits and edits cards (issue #235; docs/library.md,
 * "Review actions"). These run the real CLI against a still picked into a temporary Git repository.
 */
import "./fixtures/env.ts";
import { approve, approveProfile, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { confirmCommand } from "../src/commands/confirm.ts";
import { runCommand } from "../src/commands/runner.ts";
import type { ConfirmPort } from "../src/confirm/prompt.ts";
import { readCredentials } from "../src/credentials.ts";
import { decodeImage, encodePng, setPixel } from "../src/image/raster.ts";
import { parseCard } from "../src/library/card.ts";
import { annotationId, parseReview } from "../src/library/review.ts";
import type { ReviewRecord } from "../src/library/review.ts";
import { DIGITAL_SOURCE_TYPES, readDigitalSourceType } from "../src/metadata.ts";
import { loadSettings } from "../src/settings.ts";
import type { AssetSpec, TargetProfile } from "../src/types.ts";
import { gitTarget } from "./fixtures/git.ts";
import { syntheticWorld } from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(passingScript);

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function doc(result: Result): Record<string, any> {
  return JSON.parse(result.stdout);
}

const text = (path: string) => readFile(path, "utf8");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const review = async (path: string): Promise<ReviewRecord> => parseReview(await text(path), path);
const card = async (path: string) => parseCard(await text(path), path).data;
const logLines = async (path: string) =>
  (await text(path)).split("\n").filter((line) => line.startsWith("- "));

/** Some log line matches (lines of one second sort by text). */
function assertLine(lines: string[], pattern: RegExp): void {
  assert.ok(
    lines.some((line) => pattern.test(line)),
    `${pattern} in\n${lines.join("\n")}`,
  );
}

const spec: AssetSpec = { kind: "still", assetId: "lantern", subject: "fern" };

interface Picked {
  world: World;
  runDir: string;
  dir: string;
  cardPath: string;
  reviewPath: string;
  mediaPath: string;
  manifestPath: string;
  logPath: string;
}

/** A still `lantern` staged and picked (headless) into `props/` of a Git repository. */
async function pickedStill(
  manifestFields: Record<string, unknown> = {},
  manifestLayout = "manifests/{{spec.assetId}}.json",
  validator?: string,
  style?: TargetProfile["style"],
): Promise<Picked> {
  const world = await syntheticWorld();
  gitTarget(world.targetDir);
  const profile: Partial<TargetProfile> = {
    layout: {
      media: "props/{{spec.assetId}}.{{output.extension}}",
      manifest: manifestLayout,
    },
    manifest: {
      assetId: "{{spec.assetId}}",
      review: { status: "pending" },
      contentHash: "{{output.sha256}}",
      ...manifestFields,
    },
  };
  Object.assign(world.profile, profile);
  if (style !== undefined) world.profile.style = style;
  delete world.profile.validator;
  if (validator !== undefined) {
    // A validator script in the target, approved for its exact command.
    await writeFile(join(world.targetDir, "check.mjs"), validator);
    world.profile.validator = {
      command: [process.execPath, join(world.targetDir, "check.mjs"), "{{manifest}}"],
    };
    approveProfile(world.profile, { targetDir: world.targetDir });
  }
  const specPath = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profilePath = join(world.dir, "profile.json");
  await writeFile(specPath, JSON.stringify(spec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profilePath, JSON.stringify(world.profile));
  const staged = await cli([
    "stage",
    ...["--spec", specPath, "--bible", bible, "--profile", profilePath],
    // The project's runs directory, where adopt finds the run that made the asset.
    ...["--runs", join(world.targetDir, ".assetgrove/runs"), "--candidates", "1"],
    ...["--provider-script", passingScript, "--json"],
  ]);
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const runDir = doc(staged)["runDir"] as string;
  const pick = await cli([
    "pick",
    "--run",
    runDir,
    "--candidate",
    "c1",
    "--target",
    world.targetDir,
    "--json",
  ]);
  assert.equal(pick.code, 0, pick.stdout + pick.stderr);
  const dir = join(world.targetDir, "props");
  return {
    world,
    runDir,
    dir,
    cardPath: join(dir, "lantern.md"),
    reviewPath: join(dir, "lantern.review.json"),
    mediaPath: join(dir, "lantern.png"),
    manifestPath: join(world.targetDir, manifestLayout.replace("{{spec.assetId}}", "lantern")),
    logPath: join(dir, "log.md"),
  };
}

/** Every file under the target with its bytes, outside `.git`. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (path.includes(`${join(dir, ".git")}`)) continue;
    files.set(path, sha256(new Uint8Array(await readFile(path))));
  }
  return files;
}

/** The fields of a result document outside `sharedText`, as text. */
function outsideShared(d: Record<string, unknown>): string {
  return JSON.stringify({ ...d, sharedText: undefined });
}

/** Confirms a pending request at the terminal, as a person would. */
async function confirm(id: string): Promise<void> {
  const port: ConfirmPort = {
    method: "tty",
    confirm: async () => true,
    choose: async (r) => r.choices?.[0],
  };
  const done = await runCommand(
    confirmCommand,
    { id },
    { settings: loadSettings(), log: () => {}, prompt: port },
  );
  assert.equal(done.exitCode, 0, done.error?.message);
}

/** Runs a confirmed command: it asks (exit 8), a person confirms, it runs again. */
async function confirmed(args: string[]): Promise<Result> {
  const asked = await cli(args);
  assert.equal(asked.code, 8, asked.stdout + asked.stderr);
  assert.equal(doc(asked)["error"].code, "confirmation_required");
  await confirm(doc(asked)["error"].confirmation.id as string);
  return cli(args);
}

test("review --comment, --reply, --resolve and --reject append annotations to a version's record; existing lines never change", async () => {
  const p = await pickedStill();
  const before = await text(p.reviewPath);
  const commented = await cli(["review", p.cardPath, "--comment", "tail tip darker", "--json"]);
  assert.equal(commented.code, 0, commented.stdout + commented.stderr);
  const c = doc(commented);
  assert.equal(c["annotation"].motivation, "commenting");
  assert.equal(c["state"], "pending");
  // The text reaches the result only under sharedText.
  assert.deepEqual(
    c["sharedText"].map((s: { text: string }) => s.text),
    ["tail tip darker"],
  );
  assert.doesNotMatch(outsideShared(c), /tail tip darker/);
  const id = c["annotation"].id as string;

  const replied = await cli([
    "review",
    p.mediaPath,
    "--reply",
    id,
    "--comment",
    "agreed",
    "--json",
  ]);
  assert.equal(replied.code, 0, replied.stdout + replied.stderr);
  assert.equal(doc(replied)["annotation"].motivation, "replying");
  const resolved = await cli(["review", p.reviewPath, "--resolve", id, "--json"]);
  assert.equal(resolved.code, 0, resolved.stdout + resolved.stderr);
  assert.equal(doc(resolved)["annotation"].action, "resolve");
  const unknown = await cli([
    "review",
    p.cardPath,
    "--reply",
    "#0000000000000000",
    "--comment",
    "x",
    "--json",
  ]);
  assert.equal(unknown.code, 2);

  const rejected = await cli(["review", p.cardPath, "--reject", "wrong subject", "--json"]);
  assert.equal(rejected.code, 0, rejected.stdout + rejected.stderr);
  assert.equal(doc(rejected)["state"], "rejected");
  assert.doesNotMatch(outsideShared(doc(rejected)), /wrong subject/);

  const after = await text(p.reviewPath);
  for (const line of before.split("\n")) {
    if (line.startsWith('{"')) assert.ok(after.includes(line.replace(/,$/, "")), line);
  }
  const record = await review(p.reviewPath);
  assert.deepEqual(
    record.annotations.map((a) => a.motivation),
    ["moderating", "commenting", "replying", "moderating", "assessing"],
  );
  assert.equal((await card(p.cardPath))["state"], "rejected");
  const lines = await logLines(p.logPath);
  assert.equal(lines.length, 2, lines.join("\n"));
  assertLine(lines, / reject \[.*\]\(lantern\.md\): wrong subject$/);
  // The manifest's review field stays at pending.
  assert.equal(JSON.parse(await text(p.manifestPath)).review.status, "pending");
});

test("review on a candidate appends to the run folder's record; existing lines never change", async () => {
  const p = await pickedStill();
  const recordPath = join(p.runDir, "reviews", "c1.review.json");
  const first = await cli([
    "review",
    p.runDir,
    "--candidate",
    "c1",
    "--comment",
    "warmer glow",
    "--json",
  ]);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(doc(first)["record"], recordPath);
  const before = await text(recordPath);
  const second = await cli([
    "review",
    p.runDir,
    "--candidate",
    "c1",
    "--reject",
    "too dark",
    "--json",
  ]);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  const after = await text(recordPath);
  const line = before.split("\n").find((l) => l.startsWith('{"id"'))!;
  assert.ok(after.includes(line.replace(/,$/, "")));
  assert.deepEqual((await review(recordPath)).annotations.map((a) => a.motivation).sort(), [
    "assessing",
    "commenting",
  ]);
  const missing = await cli(["review", p.runDir, "--candidate", "c9", "--comment", "x", "--json"]);
  assert.equal(missing.code, 2);
});

test("approve under headless settings exits 8 confirmation_required and writes nothing", async () => {
  const p = await pickedStill();
  const before = await snapshot(p.world.targetDir);
  const out = await cli(["approve", p.cardPath, "--json"]);
  assert.equal(out.code, 8, out.stdout + out.stderr);
  assert.equal(doc(out)["error"].code, "confirmation_required");
  assert.deepEqual(await snapshot(p.world.targetDir), before);
});

test("approve records an assessing annotation with the confirmation, sets the card approved, rewrites the lock and logs a line; the manifest stays pending", async () => {
  const p = await pickedStill();
  useAttended();
  const out = await confirmed(["approve", p.cardPath, "--json"]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const d = doc(out);
  assert.equal(d["state"], "approved");
  const record = await review(p.reviewPath);
  const approval = record.annotations.at(-1)!;
  assert.equal(approval.motivation, "assessing");
  assert.equal(approval["ag:action"], "approve");
  assert.equal(approval["ag:confirmation"]?.method, "terminal");
  assert.equal(approval["ag:confirmation"]?.digest, d["confirmation"].digest);
  const data = (await card(p.cardPath)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(data["state"], "approved");
  assert.equal(data["lock"].sha256, record.versions[0]!.sha256);
  assert.equal(data["lock"].sha256, sha256(new Uint8Array(await readFile(p.mediaPath))));
  assert.ok(
    data["verified"].some(
      (v: Record<string, string>) => v["by"] === "human:developer" && v["method"] === "terminal",
    ),
  );
  const lines = await logLines(p.logPath);
  assert.equal(lines.length, 2);
  assertLine(lines, / approve \[/);
  assert.equal(JSON.parse(await text(p.manifestPath)).review.status, "pending");
});

test("a stored approve confirmation no longer applies after a reject is appended, or after a merge brings in another annotation", async () => {
  const p = await pickedStill();
  useAttended();
  const args = ["approve", p.cardPath, "--json"];
  const asked = await cli(args);
  assert.equal(asked.code, 8);
  const first = doc(asked)["error"].confirmation.id as string;
  await confirm(first);

  const rejected = await cli(["review", p.cardPath, "--reject", "not yet", "--json"]);
  assert.equal(rejected.code, 0, rejected.stdout + rejected.stderr);
  const again = await cli(args);
  assert.equal(again.code, 8, again.stdout + again.stderr);
  const second = doc(again)["error"].confirmation.id as string;
  assert.notEqual(second, first);
  await confirm(second);

  // A merge (Git's union driver) adds another branch's annotation line to the record.
  const record = await review(p.reviewPath);
  const content = {
    type: "Annotation",
    motivation: "commenting",
    created: "2030-01-01T00:00:00Z",
    body: [{ type: "TextualBody", purpose: "commenting", value: "from another branch" }],
    target: { source: "lantern.png", "ag:version": record.versions[0]!.sha256 },
  };
  const line = JSON.stringify({ id: annotationId(content), ...content });
  const merged = (await text(p.reviewPath)).replace("] }\n}", `${line}\n] }\n}`);
  await writeFile(p.reviewPath, merged);
  assert.equal((await review(p.reviewPath)).annotations.length, record.annotations.length + 1);
  const afterMerge = await cli(args);
  assert.equal(afterMerge.code, 8, afterMerge.stdout + afterMerge.stderr);
  assert.notEqual(doc(afterMerge)["error"].confirmation.id, second);
  assert.equal(
    (await review(p.reviewPath)).annotations.some((a) => a["ag:action"] === "approve"),
    false,
  );
});

/** The picked PNG with one opaque pixel recoloured, as a person's hand edit. */
/** Where `handEdit` keeps the original. */
const originalOf = (p: Picked) => join(p.world.dir, "original.png");

/** Edits the picked file as a person would, keeping the original at `<dir>/original.png` (outside the target). */
async function handEdit(path: string): Promise<Uint8Array> {
  await copyFile(path, join(dirname(dirname(dirname(path))), "original.png"));
  const raster = decodeImage(new Uint8Array(await readFile(path)));
  for (let i = 0; i < raster.width * raster.height; i++) {
    if (raster.data[i * 4 + 3] === 255) {
      setPixel(raster, i % raster.width, Math.floor(i / raster.width), [
        255 - raster.data[i * 4]!,
        raster.data[i * 4 + 1]!,
        raster.data[i * 4 + 2]!,
        255,
      ]);
      break;
    }
  }
  const bytes = encodePng(raster);
  await writeFile(path, bytes);
  return bytes;
}

test("library adopt on a modified PNG records a new version with a human-edit step and the composite source type, after the free QA checks", async () => {
  const p = await pickedStill();
  const edited = await handEdit(p.mediaPath);
  // Headless settings never adopt, and nothing is written.
  const before = await snapshot(p.world.targetDir);
  const headless = await cli([
    "library",
    "adopt",
    p.cardPath,
    "--original",
    originalOf(p),
    "--json",
  ]);
  assert.equal(headless.code, 8, headless.stdout + headless.stderr);
  assert.deepEqual(await snapshot(p.world.targetDir), before);

  useAttended();
  const out = await confirmed([
    "library",
    "adopt",
    p.cardPath,
    "--original",
    originalOf(p),
    "--json",
  ]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const d = doc(out);
  assert.equal(d["version"], 2);
  assert.equal(d["editedSha256"], sha256(edited));
  assert.ok(d["qa"].length > 0 && d["qa"].every((r: { passed: boolean }) => r.passed));

  const bytes = new Uint8Array(await readFile(p.mediaPath));
  assert.equal(readDigitalSourceType(bytes, "image/png"), DIGITAL_SOURCE_TYPES.composite);
  const record = await review(p.reviewPath);
  assert.equal(record.versions.length, 2);
  const version = record.versions[1]!;
  assert.equal(version.sha256, sha256(bytes));
  assert.equal(version["digitalSourceType"], DIGITAL_SOURCE_TYPES.composite);
  assert.equal(version.confirmation?.method, "terminal");
  assert.equal(record.annotations.at(-1)!["ag:action"], "adopt");
  const provenance = JSON.parse(await text(`${p.mediaPath}.provenance.json`));
  assert.equal(provenance.digitalSourceType, DIGITAL_SOURCE_TYPES.composite);
  const ops = provenance.steps.map((s: { op: string }) => s.op);
  assert.equal(ops.at(-2), "human-edit");
  assert.equal(ops.at(-1), "embed-digital-source-type");
  assert.equal(
    version.provenanceSha256,
    sha256(new Uint8Array(await readFile(`${p.mediaPath}.provenance.json`))),
  );
  // Hand-off renders the manifest again from the adopted version; its review field stays pending.
  const manifest = JSON.parse(await text(p.manifestPath));
  assert.equal(manifest.contentHash, version.sha256);
  assert.deepEqual(manifest.review, { status: "pending" });
  // Its C2PA credentials record the edit of the original, a parentOf ingredient.
  const credentials = await readCredentials(bytes, "image/png");
  assert.deepEqual(
    credentials?.actions.slice(0, 2).map((a) => a.action),
    ["c2pa.opened", "c2pa.edited"],
  );
  const data = (await card(p.cardPath)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(data["version"], 2);
  assert.equal(data["lock"].sha256, version.sha256);
  assertLine(await logLines(p.logPath), / adopt \[.*\]\(lantern\.md\): version 2$/);

  // Nothing left to adopt: the working file is the current version.
  const again = await cli(["library", "adopt", p.cardPath, "--original", originalOf(p), "--json"]);
  assert.equal(again.code, 2, again.stdout + again.stderr);
});

test("library adopt updates provenance a manifest embeds in place and keeps the rest of the manifest", async () => {
  // The manifest sits inside the library root, so the card names it as the provenance source.
  const p = await pickedStill(
    { provenance: "{{provenance}}" },
    "props/{{spec.assetId}}.manifest.json",
  );
  assert.equal(existsSync(`${p.mediaPath}.provenance.json`), false);
  const manifestBefore = JSON.parse(await text(p.manifestPath));
  await handEdit(p.mediaPath);
  useAttended();
  const out = await confirmed([
    "library",
    "adopt",
    p.cardPath,
    "--original",
    originalOf(p),
    "--json",
  ]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const manifest = JSON.parse(await text(p.manifestPath));
  assert.deepEqual(manifest.review, { status: "pending" });
  assert.equal(manifest.assetId, manifestBefore.assetId);
  assert.equal(manifest.provenance.digitalSourceType, DIGITAL_SOURCE_TYPES.composite);
  const ops = manifest.provenance.steps.map((s: { op: string }) => s.op);
  assert.equal(ops.at(-2), "human-edit");
  const record = await review(p.reviewPath);
  assert.equal(record.versions.length, 2);
  // A version's provenanceSha256 hashes a provenance file of its own, never a manifest (as at pick).
  assert.equal(record.versions[1]!.provenanceSha256, undefined);
  // The manifest is rendered again from the adopted version.
  assert.equal(manifest.contentHash, record.versions[1]!.sha256);
});

/** Gives every visible pixel of the picked file, kept at `original.png`, alpha 128; returns how many. */
async function softenVisible(p: Picked): Promise<number> {
  await copyFile(p.mediaPath, originalOf(p));
  const raster = decodeImage(new Uint8Array(await readFile(p.mediaPath)));
  let softened = 0;
  for (let i = 3; i < raster.data.length; i += 4) {
    if (raster.data[i] !== 0) {
      raster.data[i] = 128;
      softened++;
    }
  }
  await writeFile(p.mediaPath, encodePng(raster));
  return softened;
}

test("library adopt refuses an edit that breaks its binary-alpha style before asking anyone, naming the rule and the count", async () => {
  const p = await pickedStill({}, undefined, undefined, { alpha: { mode: "binary" } });
  const softened = await softenVisible(p);
  useAttended();
  const out = await cli(["library", "adopt", p.cardPath, "--original", originalOf(p), "--json"]);
  assert.equal(out.code, 5, out.stdout + out.stderr);
  const error = doc(out)["error"];
  assert.equal(error.code, "qa_found_nothing");
  assert.match(
    error.message,
    new RegExp(
      `transparency: ${softened} of \\d+ pixels have partial alpha; the asset's style allows only alpha 0 or 255 \\(alpha mode binary\\)`,
    ),
  );
  assert.equal((await review(p.reviewPath)).versions.length, 1);
});

test("library adopt accepts soft alpha in an edit of an asset whose style allows it", async () => {
  const p = await pickedStill({}, undefined, undefined, { alpha: { mode: "soft" } });
  await softenVisible(p);
  useAttended();
  const out = await confirmed([
    "library",
    "adopt",
    p.cardPath,
    "--original",
    originalOf(p),
    "--json",
  ]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const qa = doc(out)["qa"] as { check: string; passed: boolean; reason: string }[];
  assert.match(qa.find((r) => r.check === "transparency")!.reason, /alpha mode soft/);
  assert.equal((await review(p.reviewPath)).versions.length, 2);
});

test("library adopt refuses an edit that fills every transparent pixel of an original that had one", async () => {
  const p = await pickedStill({}, undefined, undefined, { alpha: { mode: "binary" } });
  await copyFile(p.mediaPath, originalOf(p));
  const raster = decodeImage(new Uint8Array(await readFile(p.mediaPath)));
  let filled = 0;
  for (let i = 3; i < raster.data.length; i += 4) {
    if (raster.data[i] === 0) {
      raster.data[i] = 255;
      filled++;
    }
  }
  assert.ok(filled > 0, "the picked original has a transparent pixel");
  await writeFile(p.mediaPath, encodePng(raster));
  useAttended();
  const out = await cli(["library", "adopt", p.cardPath, "--original", originalOf(p), "--json"]);
  assert.equal(out.code, 5, out.stdout + out.stderr);
  const error = doc(out)["error"];
  assert.equal(error.code, "qa_found_nothing");
  assert.match(error.message, /transparency: no pixel is transparent/);
  assert.equal((await review(p.reviewPath)).versions.length, 1);
});

test("library adopt runs the profile's validator under pick's rules: unapproved it exits 8 before any write, and a rejection exits 6 and records no version", async () => {
  const p = await pickedStill({}, undefined, "process.exit(0);\n");
  await handEdit(p.mediaPath);
  useAttended();
  const args = ["library", "adopt", p.cardPath, "--original", originalOf(p), "--json"];
  // A person confirms the adopt; the validator was changed since its approval.
  const asked = await cli(args);
  assert.equal(asked.code, 8, asked.stdout + asked.stderr);
  await confirm(doc(asked)["error"].confirmation.id as string);
  const checkPath = join(p.world.targetDir, "check.mjs");
  await writeFile(checkPath, 'console.error("manifest refused"); process.exit(1);\n');
  const before = await snapshot(p.world.targetDir);
  const unapproved = await cli(args);
  assert.equal(unapproved.code, 8, unapproved.stdout + unapproved.stderr);
  assert.equal(doc(unapproved)["error"].code, "confirmation_required");
  assert.match(doc(unapproved)["error"].message, /validator/);
  assert.deepEqual(await snapshot(p.world.targetDir), before, "nothing is written");

  // Approved, it runs and rejects: exit 6, and the card, lock, record, index and log stay.
  approveProfile(
    { validator: { command: [process.execPath, checkPath, "{{manifest}}"] } },
    { targetDir: p.world.targetDir },
  );
  const library = [p.cardPath, p.reviewPath, p.logPath, join(p.dir, "index.md")];
  const kept = await Promise.all(library.map((path) => text(path)));
  const rejected = await cli(args);
  assert.equal(rejected.code, 6, rejected.stdout + rejected.stderr);
  assert.equal(doc(rejected)["error"].code, "validator_rejected");
  assert.match(doc(rejected)["validator"].output, /manifest refused/);
  assert.deepEqual(await Promise.all(library.map((path) => text(path))), kept);
  assert.equal((await review(p.reviewPath)).versions.length, 1);
  // Every file the rejected adopt wrote is put back: the person's edit, the manifest and the
  // provenance describe no unrecorded version.
  const rejectedAt = await snapshot(p.world.targetDir);
  const again = await cli(args);
  assert.equal(again.code, 6, again.stdout + again.stderr);
  assert.deepEqual(await snapshot(p.world.targetDir), rejectedAt);
  const provenancePath = `${p.mediaPath}.provenance.json`;
  assert.equal(
    JSON.parse(await text(provenancePath)).steps.some((s: { op: string }) => s.op === "human-edit"),
    false,
  );

  // Approved and accepting, the retry records one human-edit step and one validator entry for it.
  await writeFile(checkPath, "process.exit(0);\n");
  approveProfile(
    { validator: { command: [process.execPath, checkPath, "{{manifest}}"] } },
    { targetDir: p.world.targetDir },
  );
  const accepted = await cli(args);
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
  const provenance = JSON.parse(await text(provenancePath));
  const ops = provenance.steps.map((s: { op: string }) => s.op);
  assert.equal(ops.filter((op: string) => op === "human-edit").length, 1, ops.join());
  assert.equal(
    provenance.commands.filter((c: { kind: string }) => c.kind === "validator").length,
    2,
    "the pick's validator and the adopt's",
  );
});

test("library check reports a provenance that describes an adopted edit no version records", async () => {
  const p = await pickedStill();
  await writeFile(
    join(p.world.targetDir, ".gitattributes"),
    "*.png filter=lfs diff=lfs merge=lfs -text\n",
  );
  const check = () =>
    cli([
      ...["library", "check", "--target", p.world.targetDir],
      ...["--profile", join(p.world.dir, "profile.json"), "--json"],
    ]);
  const ok = await check();
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  // What an adopt that crashed before recording its version would leave in the provenance.
  const provenancePath = `${p.mediaPath}.provenance.json`;
  const provenance = JSON.parse(await text(provenancePath));
  const current = (await review(p.reviewPath)).versions[0]!.sha256;
  provenance.steps.push({
    op: "human-edit",
    params: { original: current, edited: "0".repeat(64) },
    engine: { name: "human", version: "1" },
    inputs: [],
    outputs: [],
  });
  await writeFile(provenancePath, JSON.stringify(provenance, null, 2));
  const bad = await check();
  assert.equal(bad.code, 6, bad.stdout + bad.stderr);
  assert.deepEqual(doc(bad)["error"].problems, [
    { file: "lantern.png.provenance.json", code: "provenance_unrecorded" },
  ]);
});

test("library adopt reaches a project through a linked path, as the default target's real path names it", async () => {
  const p = await pickedStill();
  const linked = join(p.world.dir, "linked");
  await symlink(p.world.targetDir, linked, "junction");
  await handEdit(p.mediaPath);
  useAttended();
  const out = await confirmed([
    "library",
    "adopt",
    join(linked, "props", "lantern.md"),
    "--original",
    originalOf(p),
    "--json",
  ]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.equal(doc(out)["version"], 2);
  assert.equal((await review(p.reviewPath)).versions.length, 2);
});

test("card edit changes title, description, tags and body, records one annotation and logs one line; a machine field exits 2 card_field_owned", async () => {
  const p = await pickedStill();
  const out = await cli([
    "card",
    "edit",
    p.cardPath,
    ...["--title", "Porch lantern", "--description", "A brass lantern, lit."],
    ...["--tag", "prop", "--tag", "light", "--body", "Used beside the front door."],
    "--json",
  ]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  const d = doc(out);
  assert.equal(d["annotation"].motivation, "describing");
  assert.equal(d["annotation"].action, "card-edit");
  assert.doesNotMatch(outsideShared(d), /Porch lantern|brass lantern|front door/);
  assert.ok(d["sharedText"].some((s: { text: string }) => s.text === "Porch lantern"));
  const cardText = await text(p.cardPath);
  const parsed = parseCard(cardText, p.cardPath);
  assert.equal(parsed.data["title"], "Porch lantern");
  assert.equal(parsed.data["description"], "A brass lantern, lit.");
  assert.deepEqual(parsed.data["tags"], ["prop", "light"]);
  assert.equal(parsed.body, "Used beside the front door.\n");
  assert.equal(parsed.data["state"], "pending");
  assert.match(
    await text(join(p.dir, "index.md")),
    /\[Porch lantern\]\(lantern\.md\): A brass lantern, lit\./,
  );
  const lines = await logLines(p.logPath);
  assert.equal(lines.length, 2);
  assertLine(lines, / card-edit \[Porch lantern\]\(lantern\.md\): title, description, tags, body$/);

  const tags = await cli(["card", "edit", p.cardPath, "--tag", "lamp", "--json"]);
  assert.equal(tags.code, 0, tags.stdout + tags.stderr);
  assert.equal(doc(tags)["annotation"].motivation, "tagging");

  const before = await text(p.cardPath);
  const owned = await cli(["card", "edit", p.cardPath, "--field", "state=approved", "--json"]);
  assert.equal(owned.code, 2, owned.stdout + owned.stderr);
  assert.equal(doc(owned)["error"].code, "card_field_owned");
  assert.equal(await text(p.cardPath), before);
  assert.equal(existsSync(join(p.dir, "lantern.md")), true);

  // An empty title is refused whichever option names it, and nothing is written.
  for (const args of [
    ["--title", ""],
    ["--field", "title="],
  ]) {
    const empty = await cli(["card", "edit", p.cardPath, ...args, "--json"]);
    assert.equal(empty.code, 2, empty.stdout + empty.stderr);
    assert.equal(await text(p.cardPath), before);
  }
  assert.equal((await logLines(p.logPath)).length, 3);
});
