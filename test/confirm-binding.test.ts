/**
 * What one confirmation covers (design sections 6, 7 and 9): a spend confirmation pays for one
 * run (its first run binds it to the run directory, and the run finishing consumes it), so the
 * same request under another runs directory asks again while the same run resumes without asking;
 * a plan's confirmation covers one apply run of the plan file its run saved; a declined request
 * stays pending for `assetgrove confirm <id>`; and a write's digest covers its frame files.
 */
import "./fixtures/env.ts";
import {
  approve,
  approveProfile,
  confirmationsDir,
  stateDir,
  useAttended,
} from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { confirmCommand } from "../src/commands/confirm.ts";
import { commands } from "../src/commands/registry.ts";
import { parseCommandLine, runCommand } from "../src/commands/runner.ts";
import type { ConfirmPort, ConfirmRequest } from "../src/confirm/prompt.ts";
import { planDigest } from "../src/planning.ts";
import { loadSettings } from "../src/settings.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { shelterSpec, syntheticProfile, syntheticWorld } from "./fixtures/synthetic.ts";

const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const synthetic = fileURLToPath(new URL("./fixtures/synthetic.ts", import.meta.url));
const raster = fileURLToPath(new URL("../src/image/raster.ts", import.meta.url));

const temporary: string[] = [];
after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

/** A TTY port that answers `answer` and records every request it is asked. */
function port(answer: boolean, asked: ConfirmRequest[] = []): ConfirmPort {
  return {
    method: "tty",
    confirm: async (request) => {
      asked.push(request);
      return answer;
    },
  };
}

/** A command line run in this process, as the CLI parses it, with an injected TTY port. */
async function inProcess(argv: string[], prompt?: ConfirmPort) {
  const [name, ...rest] = argv;
  const command = commands.find((c) => c.name === name);
  assert.ok(command, name);
  const { args } = parseCommandLine(command, rest);
  return runCommand(command, args, {
    settings: loadSettings(),
    log: () => {},
    ...(prompt && { prompt }),
  });
}

/**
 * A paid scripted provider that counts its image calls, and fails every call while its `fail`
 * file exists.
 */
async function paidScript(dir: string) {
  const script = join(dir, "paid.mjs");
  const events = join(dir, "paid.events");
  const fail = join(dir, "paid.fail");
  await writeFile(
    script,
    `import { appendFileSync, existsSync } from "node:fs";
import base from ${JSON.stringify(pathToFileURL(passingScript).href)};
const fail = ${JSON.stringify(fail)};
const check = () => { if (existsSync(fail)) throw new Error("scripted outage"); };
export default {
  paid: true,
  image: (r, i) => (check(), appendFileSync(${JSON.stringify(events)}, "image\\n"), base.image(r, i)),
  vision: (r, i) => (check(), base.vision(r, i)),
};`,
  );
  approve(script);
  const count = async () =>
    existsSync(events) ? (await readFile(events, "utf8")).split("\n").filter(Boolean).length : 0;
  return { script, fail, count };
}

/** A stage request in a synthetic world, in a round of its own, without its runs directory. */
async function stageArgs(round: number) {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  const provider = await paidScript(world.dir);
  const args = [
    ...["stage", "--spec", spec, "--bible", bible, "--profile", profile],
    ...["--candidates", "1", "--round", String(round), "--provider-script", provider.script],
  ];
  return { dir: world.dir, args, provider };
}

const recordOf = async (digest: string) =>
  JSON.parse(await readFile(join(confirmationsDir, `${digest}.json`), "utf8")) as Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >;

test("a stage confirmation pays for one run: another --runs asks again, a stored record pays nothing new", async () => {
  useAttended();
  const s = await stageArgs(11);
  const asked: ConfirmRequest[] = [];
  const runsA = ["--runs", join(s.dir, "runs-a")];
  const first = await inProcess([...s.args, ...runsA], port(true, asked));
  assert.equal(first.exitCode, 0, first.error?.message);
  assert.equal(asked.length, 1);
  const paid = await s.provider.count();
  assert.ok(paid > 0);
  const record = await recordOf(first.fields["digest"] as string);
  assert.equal(record["run"].runDir, first.fields["runDir"]);
  assert.equal(typeof record["run"].consumedAt, "string", "the finished run consumed it");

  const again = await inProcess([...s.args, ...runsA], port(true, asked));
  assert.equal(again.fields["reused"], true);
  assert.equal(asked.length, 1);

  // Another runs directory, no one to ask: exit 8 and no call.
  const runsB = ["--runs", join(s.dir, "runs-b")];
  const unasked = await inProcess([...s.args, ...runsB]);
  assert.equal(unasked.exitCode, 8);
  assert.equal(unasked.error?.code, "confirmation_required");
  assert.equal(await s.provider.count(), paid, "no call without a new confirmation");
  // With a person, it asks again.
  const other = await inProcess([...s.args, ...runsB], port(true, asked));
  assert.equal(other.exitCode, 0, other.error?.message);
  assert.equal(asked.length, 2, "another runs directory asks again");
  assert.equal(other.fields["digest"], first.fields["digest"]);

  // The run directory deleted: the request runs again only after a new confirmation.
  await rm(first.fields["runDir"] as string, { recursive: true, force: true });
  const fresh = await inProcess([...s.args, ...runsA]);
  assert.equal(fresh.exitCode, 8);
  assert.equal(fresh.error?.code, "confirmation_required");
});

test("a run that failed resumes in its own directory without asking again", async () => {
  useAttended();
  const s = await stageArgs(12);
  const asked: ConfirmRequest[] = [];
  const runs = ["--runs", join(s.dir, "runs")];
  await writeFile(s.provider.fail, "");
  const failed = await inProcess([...s.args, ...runs], port(true, asked));
  assert.notEqual(failed.exitCode, 0);
  assert.equal(asked.length, 1);
  const record = await recordOf(failed.fields["digest"] as string);
  assert.equal(record["run"].runDir, failed.fields["runDir"]);
  assert.equal(record["run"].consumedAt, undefined, "a failed run does not consume it");
  await rm(s.provider.fail);

  const resumed = await inProcess([...s.args, ...runs]);
  assert.equal(resumed.exitCode, 0, resumed.error?.message);
  assert.equal(resumed.fields["runDir"], failed.fields["runDir"]);
  assert.equal(asked.length, 1, "the same run resumes under its confirmation");
});

test("a declined confirmation is saved as pending, and confirm <id> completes it", async () => {
  useAttended();
  const s = await stageArgs(13);
  const runs = ["--runs", join(s.dir, "runs")];
  const declined = await inProcess([...s.args, ...runs], port(false));
  assert.equal(declined.exitCode, 8);
  assert.equal(declined.error?.code, "confirmation_declined");
  const id = (declined.error as { confirmation?: { id: string } }).confirmation!.id;
  assert.ok(existsSync(join(stateDir, "pending", `${id}.json`)), "the request is pending");
  const confirmed = await runCommand(
    confirmCommand,
    { id },
    { settings: loadSettings(), log: () => {}, prompt: port(true) },
  );
  assert.equal(confirmed.exitCode, 0, confirmed.error?.message);
  const repeated = await inProcess([...s.args, ...runs]);
  assert.equal(repeated.exitCode, 0, repeated.error?.message);
});

/** A bible, spec, profile and run options for plan and apply, with a paid scripted provider. */
async function planFiles() {
  const dir = await tempDir("assetgrove-binding-plan-");
  const init = await inProcess([
    ...["init", "--directory", dir, "--world", "Synthetic Grove"],
    ...["--profile-preset", "sprite-32", "--style-preset", "flat-cartoon-kids"],
  ]);
  assert.equal(init.exitCode, 0, init.error?.message);
  const bible = (init.fields["files"] as { path: string; role: string }[]).find(
    (f) => f.role === "bible",
  )?.path as string;
  const spec = join(dir, "spec.json");
  const profile = join(dir, "profile.json");
  const runOptions = join(dir, "run-options.json");
  const plan = join(dir, "plan.json");
  const script = join(dir, "provider.mjs");
  await writeFile(
    spec,
    JSON.stringify({ kind: "still", assetId: "icon", subject: "icon", animationFamily: "still" }),
  );
  await writeFile(profile, JSON.stringify(syntheticProfile()));
  await writeFile(runOptions, JSON.stringify({ candidates: 1, strictness: 0.5 }));
  await writeFile(
    script,
    `import { pathToFileURL } from 'node:url';
const { drawSubject } = await import(pathToFileURL(${JSON.stringify(synthetic)}));
const { encodePng } = await import(pathToFileURL(${JSON.stringify(raster)}));
export default {
  paid: true,
  image() { return {images:[{mediaType:'image/png',bytes:encodePng(drawSubject(96))}]}; },
  vision() {
    return {text:JSON.stringify({prompt:'A friendly round icon, flat cel shading, bold outlines.',negativePrompt:'No text or photographic textures.',violations:[],clamps:[],styleScore:1,passed:true,reason:'scripted match',checks:['transparency','frame-count','identity','perspective','style'].map(check=>({check,passed:true,reason:'scripted match'}))})};
  }
};`,
  );
  approve(script);
  const planArgs = [
    "plan",
    ...["--spec", spec, "--bible", bible, "--profile", profile, "--run-options", runOptions],
    ...["--out", plan, "--runs", join(dir, "plan-runs"), "--provider-script", script],
  ];
  const apply = (out: string) => [
    "apply",
    plan,
    "--out",
    join(dir, out),
    "--provider-script",
    script,
  ];
  return { plan, planArgs, apply };
}

test("a plan's confirmation covers one apply run: another --out asks again", async () => {
  useAttended();
  const f = await planFiles();
  const asked: ConfirmRequest[] = [];
  const tty = port(true, asked);
  const planned = await inProcess(f.planArgs, tty);
  assert.equal(planned.exitCode, 0, planned.error?.message);
  assert.equal(asked.length, 1);

  const first = await inProcess(f.apply("runs-1"), tty);
  assert.equal(first.exitCode, 0, first.error?.message);
  assert.equal(asked.length, 1, "apply runs under the plan's confirmation");
  const again = await inProcess(f.apply("runs-1"), tty);
  assert.equal(again.fields["reused"], true);

  const unasked = await inProcess(f.apply("runs-2"));
  assert.equal(unasked.exitCode, 8, "another --out needs its own confirmation");
  assert.equal(unasked.error?.code, "confirmation_required");
  const second = await inProcess(f.apply("runs-2"), tty);
  assert.equal(second.exitCode, 0, second.error?.message);
  assert.equal(asked.length, 2);
  assert.equal(asked[1]!.details["command"], "apply");
});

test("apply of a plan whose prompts were edited and digest recomputed asks again", async () => {
  useAttended();
  const f = await planFiles();
  const asked: ConfirmRequest[] = [];
  const tty = port(true, asked);
  const planned = await inProcess(f.planArgs, tty);
  assert.equal(planned.exitCode, 0, planned.error?.message);
  assert.equal(asked.length, 1);

  const saved = JSON.parse(await readFile(f.plan, "utf8"));
  saved.prompts.images = saved.prompts.images.map((p: string) => `A different subject. ${p}`);
  delete saved.digest;
  await writeFile(f.plan, JSON.stringify({ ...saved, digest: planDigest(saved) }));
  const edited = await inProcess(f.apply("runs"));
  assert.equal(edited.exitCode, 8, "the plan's confirmation does not cover other prompts");
  assert.equal(edited.error?.code, "confirmation_required");
});

test("write-families: a frame changed after the write was confirmed asks again", async () => {
  const root = await tempDir("assetgrove-binding-write-");
  const target = join(root, "target");
  await mkdir(target);
  approveProfile(syntheticProfile(), { targetDir: target });
  await writeFile(join(root, "sheet.png"), syntheticSheet().png);
  await writeFile(join(root, "profile.json"), JSON.stringify(syntheticProfile()));
  const imported = await inProcess([
    ...["import", "--sheet", join(root, "sheet.png"), "--profile", join(root, "profile.json")],
    ...["--asset", "fern", "--tool", "hand drawn", "--no-propose"],
    ...["--digital-source-type", "digitalCreation", "--imports", join(root, "imports")],
  ]);
  assert.equal(imported.exitCode, 0, imported.error?.message);
  const importDir = imported.fields["importDir"] as string;
  const record = JSON.parse(await readFile(join(importDir, "import.json"), "utf8")) as {
    frames: { id: number; file: string }[];
  };
  const proposal = JSON.parse(await readFile(join(importDir, "grouping.json"), "utf8"));
  const grouping = join(root, "confirmed.json");
  await writeFile(
    grouping,
    JSON.stringify({
      ...proposal,
      status: "confirmed",
      families: [{ name: "walk-right", frames: [5, 6, 7, 8, 9, 10], reason: "legs swing" }],
    }),
  );
  useAttended();
  const args = [
    "write-families",
    "--import",
    importDir,
    "--target",
    target,
    "--grouping",
    grouping,
  ];
  const refused = await inProcess(args);
  assert.equal(refused.exitCode, 8);
  const id = (refused.error as { confirmation?: { id: string } }).confirmation!.id;
  const confirmed = await runCommand(
    confirmCommand,
    { id },
    { settings: loadSettings(), log: () => {}, prompt: port(true) },
  );
  assert.equal(confirmed.exitCode, 0, confirmed.error?.message);

  const file = (n: number) => join(importDir, record.frames.find((f) => f.id === n)!.file);
  await copyFile(file(6), file(5));
  const changed = await inProcess(args);
  assert.equal(changed.exitCode, 8, "the confirmed write does not cover other frame bytes");
  assert.equal(changed.error?.code, "confirmation_required");
  assert.notEqual((changed.error as { confirmation?: { id: string } }).confirmation!.id, id);
  assert.equal(existsSync(join(target, "assets")), false, "nothing was written");
});
