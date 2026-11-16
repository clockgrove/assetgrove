/**
 * Spend, pick and write confirmation in the terminal (design section 7): headless settings, a
 * stored record, an inline TTY (an injected port here), or exit 8 with a pending id that
 * `assetgrove confirm <id>` completes; checked by the executor before the first reservation and on
 * every resume, and by `Caller` for every paid call.
 */
import "./fixtures/env.ts";
import { gitTarget } from "./fixtures/git.ts";
import {
  HEADLESS_OPERATOR,
  approve,
  approveProfile,
  cleared,
  confirmationsDir,
  stateDir,
  useAttended,
} from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { confirmCommand } from "../src/commands/confirm.ts";
import { commands } from "../src/commands/registry.ts";
import { failureOutcome } from "../src/commands/result.ts";
import { parseCommandLine, runCommand } from "../src/commands/runner.ts";
import type { CommandSpec } from "../src/commands/types.ts";
import type { ConfirmPort, ConfirmRequest } from "../src/confirm/prompt.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { defaultRoutes } from "../src/routes.ts";
import { loadSettings } from "../src/settings.ts";
import { syntheticProfile, shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
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

interface Result {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** The CLI in a child process with no TTY: stdin is closed and output is piped. */
function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error.code as unknown as number | null) ?? null) : 0,
          signal: error?.signal ?? null,
          stdout,
          stderr,
        }),
    );
    child.stdin?.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
const doc = (r: Result): Doc => JSON.parse(r.stdout) as Doc;

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

/** The context of an in-process command run under the current settings, with `prompt`. */
function context(prompt?: ConfirmPort) {
  return { settings: loadSettings(), log: () => {}, ...(prompt && { prompt }) };
}

function spec(name: string): CommandSpec {
  const found = commands.find((c) => c.name === name);
  assert.ok(found, name);
  return found;
}

/** A command line run in this process, as the CLI parses it, with an injected TTY port. */
async function inProcess(argv: string[], prompt?: ConfirmPort) {
  const [name, ...rest] = argv;
  const command = spec(name!);
  const { args } = parseCommandLine(command, rest);
  return runCommand(command, args, context(prompt));
}

/**
 * A paid scripted provider that counts every call in `events`. When the `stop` file holds k, the
 * call after the k-th kills its own process: a run interrupted after k calls.
 */
async function countingScript(dir: string) {
  const script = join(dir, "counting.mjs");
  const events = join(dir, "counting.events");
  const stop = join(dir, "counting.stop");
  await writeFile(
    script,
    `import { appendFileSync, existsSync, readFileSync } from "node:fs";
import base from ${JSON.stringify(pathToFileURL(passingScript).href)};
const events = ${JSON.stringify(events)};
const stop = ${JSON.stringify(stop)};
const count = (kind) => {
  const made = existsSync(events) ? readFileSync(events, "utf8").split("\\n").filter(Boolean).length : 0;
  if (existsSync(stop) && made >= Number(readFileSync(stop, "utf8"))) process.kill(process.pid, "SIGKILL");
  appendFileSync(events, kind + "\\n");
};
export default {
  paid: true,
  image: (r, i) => (count("image"), base.image(r, i)),
  vision: (r, i) => (count("vision"), base.vision(r, i)),
};`,
  );
  approve(script);
  const count = async () =>
    existsSync(events) ? (await readFile(events, "utf8")).split("\n").filter(Boolean).length : 0;
  return { script, stop, count };
}

/** A stage request in a synthetic world: its CLI flags, without the provider script. */
async function stageRequest() {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  const flags = ["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir];
  return { world, flags };
}

const recordPath = (id: string) => join(confirmationsDir, `${id}.json`);

test("a paid command with attended settings, no TTY and no record exits 8 with confirmCommand and no call; after confirm <id> the repeat runs and records method terminal", async () => {
  useAttended();
  const { world, flags } = await stageRequest();
  const provider = await countingScript(world.dir);
  const args = ["stage", ...flags, "--candidates", "1", "--provider-script", provider.script];

  const refused = await cli([...args, "--json"]);
  assert.equal(refused.code, 8, refused.stderr);
  const error = doc(refused)["error"];
  assert.equal(error.code, "confirmation_required");
  assert.equal(error.confirmation.kind, "spend");
  assert.match(error.confirmation.id, /^[0-9a-f]{64}$/);
  assert.equal(typeof error.confirmation.summary, "string");
  assert.equal(error.confirmation.confirmCommand, `assetgrove confirm ${error.confirmation.id}`);
  assert.equal(await provider.count(), 0, "no provider call");
  const id = error.confirmation.id as string;
  assert.ok(existsSync(join(stateDir, "pending", `${id}.json`)), "the request is pending");
  assert.equal(existsSync(recordPath(id)), false);

  // `assetgrove confirm <id>` asks at the terminal (an injected TTY port) and writes the record.
  const noTty = await runCommand(confirmCommand, { id }, context());
  assert.equal(noTty.exitCode, 2);
  // What the person is shown comes from what the id hashes, not from the saved file's text.
  const pendingPath = join(stateDir, "pending", `${id}.json`);
  const pending = JSON.parse(await readFile(pendingPath, "utf8"));
  const forecastUsd = pending.body.forecastUsd as number;
  assert.ok(forecastUsd > 0);
  await writeFile(
    pendingPath,
    JSON.stringify({
      ...pending,
      summary: "stage would spend nothing",
      details: { ...pending.details, forecastUsd: 0, jobs: [] },
    }),
  );
  const asked: ConfirmRequest[] = [];
  const confirmed = await runCommand(confirmCommand, { id }, context(port(true, asked)));
  assert.equal(confirmed.exitCode, 0, confirmed.error?.message);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.kind, "spend");
  assert.equal(asked[0]!.details["digest"], id);
  assert.equal(asked[0]!.details["forecastUsd"], forecastUsd);
  assert.deepEqual(asked[0]!.details["jobs"], pending.body.jobs);
  assert.match(asked[0]!.summary, /^stage would spend up to \$/);
  const record = JSON.parse(await readFile(recordPath(id), "utf8"));
  assert.equal(record.kind, "spend");
  assert.equal(record.digest, id);
  assert.equal(record.method, "terminal");
  assert.equal(record.selfReported, true);
  assert.equal(record.toolMarkedRequiresUser, false);
  assert.equal(existsSync(join(stateDir, "pending", `${id}.json`)), false);

  const repeated = await cli([...args, "--json"]);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(doc(repeated)["digest"], id);
  assert.ok((await provider.count()) > 0);
  const run = JSON.parse(await readFile(join(doc(repeated)["runDir"], "run.json"), "utf8"));
  assert.equal(run.confirmation.method, "terminal");
  assert.equal(run.confirmation.digest, id);
});

test("a declined confirmation exits 8 confirmation_declined and writes no record", async () => {
  useAttended();
  const { world, flags } = await stageRequest();
  const provider = await countingScript(world.dir);
  // Another round: a request with the same inputs as another test's has its digest and record.
  const args = [
    ...["stage", ...flags, "--candidates", "1", "--round", "2"],
    ...["--provider-script", provider.script],
  ];
  const declined = await inProcess(args, port(false));
  assert.equal(declined.exitCode, 8);
  assert.equal(declined.error?.code, "confirmation_declined");
  assert.equal(await provider.count(), 0);
  const accepted = await inProcess(args, port(true));
  assert.equal(accepted.exitCode, 0, accepted.error?.message);
  const record = JSON.parse(
    await readFile(recordPath(accepted.fields["digest"] as string), "utf8"),
  );
  assert.equal(record.method, "tty");
});

test("deleting the record between interruption and resume makes the resume exit 8", async (t) => {
  if (process.platform === "win32") return t.skip("SIGKILL interruption is POSIX");
  useAttended();
  const { world, flags } = await stageRequest();
  const provider = await countingScript(world.dir);
  const args = ["stage", ...flags, "--candidates", "2", "--provider-script", provider.script];
  const first = await cli([...args, "--json"]);
  assert.equal(first.code, 8, first.stderr);
  const id = doc(first)["error"].confirmation.id as string;
  const confirmed = await runCommand(confirmCommand, { id }, context(port(true)));
  assert.equal(confirmed.exitCode, 0);

  const k = 2;
  await writeFile(provider.stop, String(k));
  const stopped = await cli([...args, "--json"]);
  assert.equal(stopped.signal, "SIGKILL", "the run was interrupted");
  assert.equal(await provider.count(), k);
  await rm(provider.stop);

  await rm(recordPath(id));
  const resumed = await cli([...args, "--json"]);
  assert.equal(resumed.code, 8, resumed.stderr);
  assert.equal(doc(resumed)["error"].code, "confirmation_required");
  assert.equal(doc(resumed)["error"].confirmation.id, id);
  assert.equal(await provider.count(), k, "the resume made no call");

  // Confirmed again, the resume pays only for the missing calls.
  assert.equal((await runCommand(confirmCommand, { id }, context(port(true)))).exitCode, 0);
  const finished = await cli([...args, "--json"]);
  assert.equal(finished.code, 0, finished.stderr);
});

test("a direct Caller paid call without a clearance exits 8", async () => {
  let calls = 0;
  const provider = new ScriptedProvider(
    {
      paid: true,
      image: () => {
        calls++;
        return { images: [{ mediaType: "image/png", bytes: new Uint8Array([1]) }] };
      },
      vision: () => ({ text: "ok" }),
    },
    { limit: { kind: "prepaid", usd: 10 } },
  );
  const caller = () =>
    new Caller({
      provider,
      providerName: "scripted",
      budget: new Budget(5),
      routes: defaultRoutes,
    });
  const error = await caller()
    .image("still", "a fox", [])
    .then(
      () => assert.fail("the call was made"),
      (e: unknown) => e,
    );
  const outcome = failureOutcome(error);
  assert.equal(outcome.exitCode, 8);
  assert.equal(outcome.error?.code, "confirmation_required");
  assert.equal(calls, 0);
  // Under a confirmed spend's clearance the same call is made.
  await cleared(() => caller().image("still", "a fox", []));
  assert.equal(calls, 1);
});

/** A bible, spec, profile and run options for plan and apply, with a free scripted provider. */
async function planFiles() {
  const dir = await tempDir("assetgrove-confirm-plan-");
  gitTarget(dir);
  const init = await cli([
    "init",
    "--directory",
    dir,
    "--world",
    "Synthetic Grove",
    "--profile-preset",
    "sprite-32",
    "--style-preset",
    "flat-cartoon-kids",
    "--json",
  ]);
  assert.equal(init.code, 0, init.stderr);
  const bible = (doc(init)["files"] as { path: string; role: string }[]).find(
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
  image() { return {images:[{mediaType:'image/png',bytes:encodePng(drawSubject(96))}]}; },
  vision() {
    return {text:JSON.stringify({prompt:'A friendly round icon, flat cel shading, bold outlines.',negativePrompt:'No text or photographic textures.',violations:[],clamps:[],styleScore:1,passed:true,reason:'scripted match',checks:['transparency','frame-count','identity','perspective','style'].map(check=>({check,passed:true,reason:'scripted match'}))})};
  }
};`,
  );
  approve(script);
  const runs = join(dir, "runs");
  const planArgs = [
    "plan",
    ...["--spec", spec, "--bible", bible, "--profile", profile, "--run-options", runOptions],
    ...["--out", plan, "--runs", join(dir, "plan-runs"), "--provider-script", script],
  ];
  const applyArgs = ["apply", plan, "--out", runs, "--provider-script", script];
  return { dir, bible, plan, planArgs, applyArgs };
}

test("plan then apply with unchanged inputs asks once; after a bible change or above the confirmed forecast it asks again", async () => {
  useAttended();
  const f = await planFiles();
  const asked: ConfirmRequest[] = [];
  const tty = port(true, asked);

  const planned = await inProcess(f.planArgs, tty);
  assert.equal(planned.exitCode, 0, planned.error?.message);
  assert.equal(asked.length, 1, "plan asks once");
  const saved = JSON.parse(await readFile(f.plan, "utf8"));
  const planRecord = JSON.parse(await readFile(recordPath(saved.requestDigest), "utf8"));
  assert.equal(planRecord.method, "tty");

  const applied = await inProcess(f.applyArgs, tty);
  assert.equal(applied.exitCode, 0, applied.error?.message);
  assert.equal(asked.length, 1, "apply uses the plan's confirmation");
  const run = JSON.parse(
    await readFile(join(applied.fields["runDir"] as string, "run.json"), "utf8"),
  );
  assert.equal(run.confirmation.digest, saved.requestDigest);

  // Another round is another paid request: the plan's record does not cover it.
  const again = await inProcess([...f.applyArgs, "--round", "2"], tty);
  assert.equal(again.exitCode, 0, again.error?.message);
  assert.equal(asked.length, 2, "apply --round 2 asks under its own digest");
  assert.equal(asked[1]!.details["command"], "apply");

  // The plan's record no longer covers the default round's apply (its finished run removed, so
  // the request runs again): another input hash, or a lower confirmed forecast.
  const applyDigest = applied.fields["digest"] as string;
  const fresh = async () => {
    await rm(applied.fields["runDir"] as string, { recursive: true, force: true });
    await rm(recordPath(applyDigest), { force: true });
  };
  await fresh();
  await writeFile(
    recordPath(saved.requestDigest),
    JSON.stringify({ ...planRecord, inputs: { ...planRecord.inputs, bible: "0".repeat(64) } }),
  );
  const changedInput = await inProcess(f.applyArgs, tty);
  assert.equal(changedInput.exitCode, 0, changedInput.error?.message);
  assert.equal(asked.length, 3, "an input hash that differs asks again");
  assert.equal(asked[2]!.details["command"], "apply");
  await fresh();
  await writeFile(
    recordPath(saved.requestDigest),
    JSON.stringify({ ...planRecord, forecastUsd: 0 }),
  );
  const rose = await inProcess(f.applyArgs, tty);
  assert.equal(rose.exitCode, 0, rose.error?.message);
  assert.equal(asked.length, 4, "a forecast above the confirmed one asks again");
  await writeFile(recordPath(saved.requestDigest), JSON.stringify(planRecord));

  // A bible change: the saved plan is stale (exit 2, nothing asked); planning again asks, and
  // apply of the new plan runs under that confirmation.
  await writeFile(f.bible, `${await readFile(f.bible, "utf8")}\nChanged after planning.\n`);
  const stale = await inProcess(f.applyArgs, tty);
  assert.equal(stale.exitCode, 2);
  assert.equal(asked.length, 4);
  const replanned = await inProcess(f.planArgs, tty);
  assert.equal(replanned.exitCode, 0, replanned.error?.message);
  assert.equal(asked.length, 5, "a bible change asks again");
  const reapplied = await inProcess(f.applyArgs, tty);
  assert.equal(reapplied.exitCode, 0, reapplied.error?.message);
  assert.equal(asked.length, 5);
});

test("with headless settings stage and pick run and record method headless and the operator; pick without --candidate exits 2", async () => {
  const { world, flags } = await stageRequest();
  approve(passingScript);
  gitTarget(world.targetDir);
  approveProfile(world.profile, { targetDir: world.targetDir });
  const staged = await cli([
    "stage",
    ...flags,
    "--candidates",
    "1",
    "--provider-script",
    passingScript,
    "--json",
  ]);
  assert.equal(staged.code, 0, staged.stderr);
  const runDir = doc(staged)["runDir"] as string;
  const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  assert.equal(run.confirmation.kind, "spend");
  assert.equal(run.confirmation.method, "headless");
  assert.equal(run.confirmation.operator, HEADLESS_OPERATOR);
  assert.ok(existsSync(recordPath(doc(staged)["digest"])));

  const pickArgs = ["pick", "--run", runDir, "--target", world.targetDir, "--json"];
  const unnamed = await cli(pickArgs);
  assert.equal(unnamed.code, 2, unnamed.stderr);
  assert.equal(doc(unnamed)["error"].code, "invalid_input");

  const picked = await cli([...pickArgs, "--candidate", "c1"]);
  assert.equal(picked.code, 0, picked.stderr);
  const confirmation = doc(picked)["confirmation"];
  assert.equal(confirmation.kind, "pick");
  assert.equal(confirmation.method, "headless");
  assert.equal(confirmation.operator, HEADLESS_OPERATOR);
  assert.equal(confirmation.choice, "c1");
  assert.ok(existsSync(recordPath(confirmation.digest)));
  const manifest = JSON.parse(await readFile(doc(picked)["manifestPath"], "utf8"));
  assert.deepEqual(manifest.provenance.generated.confirmation, confirmation);
});

test("attended pick: no TTY exits 8 pending; confirm <id> chooses the candidate and the repeat writes it", async () => {
  const { world, flags } = await stageRequest();
  approve(passingScript);
  gitTarget(world.targetDir);
  approveProfile(world.profile, { targetDir: world.targetDir });
  const staged = await cli([
    "stage",
    ...flags,
    "--candidates",
    "1",
    "--provider-script",
    passingScript,
    "--json",
  ]);
  assert.equal(staged.code, 0, staged.stderr);
  useAttended();
  const pickArgs = ["pick", "--run", doc(staged)["runDir"], "--target", world.targetDir, "--json"];
  const refused = await cli(pickArgs);
  assert.equal(refused.code, 8, refused.stderr);
  const asked = doc(refused)["error"].confirmation;
  assert.equal(asked.kind, "pick");
  const chooser: ConfirmPort = { ...port(true), choose: async () => "c1" };
  const confirmed = await runCommand(confirmCommand, { id: asked.id }, context(chooser));
  assert.equal(confirmed.exitCode, 0, confirmed.error?.message);
  const picked = await cli(pickArgs);
  assert.equal(picked.code, 0, picked.stderr);
  assert.equal(doc(picked)["confirmation"].method, "terminal");
  assert.equal(doc(picked)["confirmation"].choice, "c1");
});

test("apply --auto-approve exits 2 invalid_input and a saved plan has no approved field", async () => {
  const f = await planFiles();
  const planned = await cli([...f.planArgs, "--json"]);
  assert.equal(planned.code, 0, planned.stderr);
  const saved = JSON.parse(await readFile(f.plan, "utf8"));
  assert.equal("approved" in saved, false);
  const refused = await cli([...f.applyArgs, "--auto-approve", "--json"]);
  assert.equal(refused.code, 2, refused.stderr);
  assert.equal(doc(refused)["error"].code, "invalid_input");
});
