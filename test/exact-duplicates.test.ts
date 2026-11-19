import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pickCommand, pickRequest } from "../src/commands/pick.ts";
import { intakeCommand } from "../src/commands/intake.ts";
import { confirmCommand } from "../src/commands/confirm.ts";
import { runCommand, parseCommandLine } from "../src/commands/runner.ts";
import type { ConfirmPort, ConfirmRequest } from "../src/confirm/prompt.ts";
import type { Outcome } from "../src/commands/types.ts";
import { emptyReview, appendVersion, writeReview, parseReview } from "../src/library/review.ts";
import { encodePng } from "../src/image/raster.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { sha256 } from "../src/request.ts";
import { loadSettings } from "../src/settings.ts";
import type { Provenance } from "../src/types.ts";
import { libraryProfile } from "./fixtures/library.ts";
import { drawSubject } from "./fixtures/synthetic.ts";
import { gitTarget } from "./fixtures/git.ts";

const provenance: Provenance = {
  digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  generator: "still",
  route: "scripted",
  models: ["synthetic"],
  prompt: "a test prop",
  parameters: {},
  requestIds: [],
  referenceHashes: [],
  bibleVersion: "1",
  license: "MIT",
  providerTerms: [],
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:00:01Z",
  costUsd: 0,
  calls: [],
};
const bytes = encodePng(drawSubject(32, 1));
const different = encodePng(drawSubject(32, 2));
const context = (prompt?: ConfirmPort) => ({
  settings: loadSettings(),
  log: () => {},
  ...(prompt && { prompt }),
});
const port = (answer: boolean, asked: ConfirmRequest[] = []): ConfirmPort => ({
  method: "tty",
  confirm: async (request) => {
    asked.push(request);
    return answer;
  },
});
const ok = (result: Outcome) => assert.equal(result.exitCode, 0, result.error?.message);

async function tracked(target: string, id: string, versions: Uint8Array[]) {
  const root = join(target, "assets");
  await mkdir(root, { recursive: true });
  let record = emptyReview(`asset://test-grove/${id}/review`);
  for (const [i, version] of versions.entries())
    record = appendVersion(record, {
      sha256: sha256(version),
      at: `2026-01-0${i + 1}T00:00:00Z`,
      run: `old-${id}`,
      candidate: "c1",
      confirmation: { method: "tty" },
    });
  await writeFile(join(root, `${id}.review.json`), writeReview(record));
  await writeFile(join(root, `${id}.png`), versions.at(-1)!);
  await writeFile(
    join(root, `${id}.md`),
    `---\ntype: Game Asset\nformat: assetgrove-card/1\ntitle: Same title\nresource: ${id}.png\nversion: ${versions.length}\nlock: { sha256: ${sha256(versions.at(-1)!)} }\n---\n`,
  );
}

async function setup(assetId = "incoming") {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-exact-")));
  const target = gitTarget(join(dir, "target"));
  const profile = libraryProfile();
  const profilePath = join(dir, "profile.json");
  await writeFile(profilePath, JSON.stringify(profile));
  await tracked(target, "lantern", [bytes, different]);
  await tracked(target, "twin", [bytes]);
  const run = join(dir, "run");
  await mkdir(run);
  await writeFile(join(run, "c1.png"), bytes);
  await writeFile(join(run, "c2.png"), different);
  await writeFile(
    join(run, "run.json"),
    JSON.stringify({
      runId: "r-exact",
      createdAt: "2026-01-02T00:00:00Z",
      spec: { kind: "still", assetId },
      specDir: dir,
      profile,
      bibleVersion: "1",
      capUsd: 0,
      estimateUsd: 0,
      spentUsd: 0,
      requested: 2,
      filtered: 0,
      errors: [],
      candidates: [bytes, different].map((b, i) => ({
        id: `c${i + 1}`,
        file: `c${i + 1}.png`,
        mediaType: "image/png",
        extension: "png",
        sha256: sha256(b),
        reasons: [],
        fields: {},
        provenance,
      })),
    }),
  );
  const args = { run, target, candidate: "c1" };
  return { dir, target, profilePath, run, args };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory())
      for (const [name, value] of Object.entries(await snapshot(path)))
        files[`${entry.name}/${name}`] = value;
    else files[entry.name] = (await readFile(path)).toString("base64");
  }
  return files;
}

const references = (result: Outcome) =>
  (result.fields["matches"] as { assetId: string; version: number }[]).map((m) => [
    m.assetId,
    m.version,
  ]);

test("intake and pick report exact bytes across cards and historical versions", async () => {
  const f = await setup();
  const before = await snapshot(f.target);
  const input = await runCommand(
    intakeCommand,
    { file: join(f.run, "c1.png"), target: f.target, profile: f.profilePath },
    context(),
  );
  ok(input);
  assert.deepEqual(references(input), [
    ["lantern", 1],
    ["twin", 1],
  ]);
  assert.equal(input.fields["sha256"], sha256(bytes));
  assert.equal(input.fields["outcome"], "decision-required");
  const unnamed = await runCommand(pickCommand, { run: f.run, target: f.target }, context());
  assert.equal(unnamed.error?.code, "invalid_input");
  assert.deepEqual(
    (unnamed.fields["duplicates"] as { candidate: string; assetId: string; version: number }[]).map(
      (m) => [m.candidate, m.assetId, m.version],
    ),
    [
      ["c1", "lantern", 1],
      ["c1", "twin", 1],
      ["c2", "lantern", 2],
    ],
  );
  assert.deepEqual(await snapshot(f.target), before);
});

test("duplicate outcomes are explicit and confirmed; decline, exit and existing-version leave the library unchanged", async () => {
  const f = await setup();
  const before = await snapshot(f.target);
  const args = { ...f.args, duplicate: "existing-version", existingVersion: "lantern@1" };
  const pending = await runCommand(pickCommand, args, context());
  assert.equal(
    pending.error?.code,
    "confirmation_required",
    "headless settings cannot accept duplicates",
  );
  const declined = await runCommand(pickCommand, args, context(port(false)));
  assert.equal(declined.error?.code, "confirmation_declined");
  const exited = await runCommand(
    pickCommand,
    { ...f.args, duplicate: "exit" },
    context(port(false)),
  );
  ok(exited);
  assert.equal(exited.fields["outcome"], "exit");
  const request = await pickRequest({
    ...f.args,
    duplicate: "existing-version",
    existingVersion: "lantern@1",
  });
  const asked: ConfirmRequest[] = [];
  const confirmed = await runCommand(
    confirmCommand,
    { id: request.id },
    context(port(true, asked)),
  );
  ok(confirmed);
  assert.equal(asked[0]!.details["outcome"], "existing-version");
  const selected = await runCommand(pickCommand, args, context());
  ok(selected);
  assert.equal(selected.fields["outcome"], "existing-version");
  assert.equal((selected.fields["existingVersion"] as { assetId: string }).assetId, "lantern");
  assert.equal((selected.fields["existingVersion"] as { version: number }).version, 1);
  assert.deepEqual(await snapshot(f.target), before);
  const keepArgs = { ...f.args, duplicate: "keep-separate" };
  const keepDeclined = await runCommand(pickCommand, keepArgs, context(port(false)));
  assert.equal(keepDeclined.error?.code, "confirmation_declined");
  assert.deepEqual(await snapshot(f.target), before);
  const keepAsked: ConfirmRequest[] = [];
  const kept = await runCommand(pickCommand, keepArgs, context(port(true, keepAsked)));
  ok(kept);
  assert.equal(kept.fields["outcome"], "keep-separate");
  assert.equal(keepAsked[0]!.details["outcome"], "keep-separate");
  const record = parseReview(
    await readFile(join(f.target, "assets/incoming.review.json"), "utf8"),
    "incoming",
  );
  assert.equal(record.versions.length, 1);
  assert.equal(record.versions[0]!.confirmation!.digest, keepAsked[0]!.id);
  for (const name of [
    "lantern.md",
    "lantern.review.json",
    "lantern.png",
    "twin.md",
    "twin.review.json",
    "twin.png",
  ])
    assert.equal(
      (await readFile(join(f.target, "assets", name))).toString("base64"),
      before[`assets/${name}`],
    );
  const repeat = await runCommand(pickCommand, keepArgs, context());
  ok(repeat);
  assert.equal(repeat.fields["outcome"], "keep-separate");
  assert.equal(
    parseReview(await readFile(join(f.target, "assets/incoming.review.json"), "utf8"), "incoming")
      .versions.length,
    1,
  );
});

test("same names and similar pixels with distinct bytes remain distinct", async () => {
  const f = await setup();
  const input = join(f.dir, "twin.png");
  const raster = drawSubject(32, 1);
  raster.data[0] = (raster.data[0]! + 1) % 256;
  const similar = encodePng(raster);
  await writeFile(input, similar);
  const result = await runCommand(
    intakeCommand,
    { file: input, target: f.target, profile: f.profilePath },
    context(),
  );
  ok(result);
  assert.deepEqual(result.fields["matches"], []);
  assert.equal(result.fields["outcome"], "distinct");
  await writeFile(join(f.run, "c1.png"), similar);
  const run = JSON.parse(await readFile(join(f.run, "run.json"), "utf8"));
  run.candidates[0].sha256 = sha256(similar);
  await writeFile(join(f.run, "run.json"), JSON.stringify(run));
  const request = await pickRequest(f.args);
  assert.equal(request.details["duplicates"], undefined);
  await tracked(f.target, "broken", [bytes]);
  await writeFile(join(f.target, "assets/broken.review.json"), "not a review record");
  await writeFile(
    join(f.target, "assets/escape.md"),
    "---\ntype: Game Asset\nformat: assetgrove-card/1\ntitle: Escape\nresource: ../../outside.png\n---\n",
  );
  const admitted = await runCommand(pickCommand, f.args, context());
  ok(admitted);
  assert.equal((admitted.fields["library"] as { version: number }).version, 1);
  const unnamed = await runCommand(pickCommand, { run: f.run, target: f.target }, context());
  assert.equal(unnamed.fields["outcome"], "decision-required");
  assert.deepEqual(
    (unnamed.fields["duplicates"] as { candidate: string; assetId: string; version: number }[]).map(
      (m) => [m.candidate, m.assetId, m.version],
    ),
    [["c2", "lantern", 2]],
  );
  const parsed = parseCommandLine(pickCommand, [
    "--run",
    f.run,
    "--target",
    f.target,
    "--candidate",
    "c1",
    "--duplicate",
    "existing-version",
    "--existing-version",
    "lantern@1",
  ]);
  assert.equal(parsed.args["existingVersion"], "lantern@1");
});

test("duplicate decisions reject changed matches, changed input and replaying an older own version", async () => {
  const f = await setup();
  const stale: ConfirmPort = {
    method: "tty",
    confirm: async () => {
      await tracked(f.target, "new-match", [bytes]);
      return true;
    },
  };
  const result = await runCommand(
    pickCommand,
    { ...f.args, duplicate: "keep-separate" },
    context(stale),
  );
  assert.equal(result.error?.code, "plan_changed");
  const before = await snapshot(f.target);
  await writeFile(join(f.run, "c1.png"), different);
  const changed = await runCommand(
    pickCommand,
    { ...f.args, duplicate: "existing-version", existingVersion: "lantern@1" },
    context(port(true)),
  );
  assert.equal(changed.error?.code, "invalid_input");
  assert.deepEqual(await snapshot(f.target), before);
  const own = await setup("lantern");
  const replay = await runCommand(
    pickCommand,
    { ...own.args, duplicate: "keep-separate" },
    context(port(true)),
  );
  assert.equal(replay.error?.code, "version_exists");
});
