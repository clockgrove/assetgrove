import "./fixtures/env.ts";
import { approve, approveProfile, ledgerPath } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs, { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { RunInProgressError, acquireRunLock, type RunLock } from "../src/runs/lock.ts";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { shelterSpec, syntheticWorld, writeStyleBible } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));

const temporary: string[] = [];
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
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

/**
 * True when the child was killed, not ended by itself. POSIX reports the signal; Windows has no
 * signals, so a killed process shows a non-zero exit code and no result document.
 */
function killed(result: Result): boolean {
  if (result.signal === "SIGKILL") return true;
  return process.platform === "win32" && result.code !== 0 && result.stdout.trim() === "";
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  return env;
}

function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env: childEnv(), maxBuffer: 64 * 1024 * 1024 },
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

/**
 * A paid scripted provider that counts every call it answers in `events`, one line each. When the
 * `stop` file holds k, the call after the k-th kills its own process (SIGKILL): a run stopped
 * after k calls, with its lock and state left behind.
 */
async function countingScript(
  dir: string,
  answers: { image?: string; vision?: string } = {},
): Promise<{ script: string; events: string; stop: string; count: () => Promise<number> }> {
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
  image: (r, i) => (count("image"), ${answers.image ?? "base.image(r, i)"}),
  vision: (r, i) => (count("vision"), ${answers.vision ?? "base.vision(r, i)"}),
  promptPolicy: () => (count("prompt-policy"), { answer: { type: "boolean", probability: 0 } }),
  cutout: () => (count("cutout"), { answer: { type: "boolean", probability: 0 } }),
};`,
  );
  approve(script);
  const count = async () =>
    existsSync(events) ? (await readFile(events, "utf8")).split("\n").filter(Boolean).length : 0;
  return { script, events, stop, count };
}

interface Reserve {
  op: "reserve";
  id: string;
  provider?: string;
  runId?: string;
  callKey?: string;
}

async function ledgerOf(runId: string): Promise<{ reserves: Reserve[]; settled: Set<string> }> {
  const entries = existsSync(ledgerPath)
    ? (await readFile(ledgerPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Reserve | { op: "settle"; id: string })
    : [];
  return {
    reserves: entries.filter((e): e is Reserve => e.op === "reserve" && e.runId === runId),
    settled: new Set(entries.filter((e) => e.op === "settle").map((e) => e.id)),
  };
}

async function journal(runDir: string): Promise<string[]> {
  if (!existsSync(join(runDir, "calls"))) return [];
  return (await readdir(join(runDir, "calls"))).filter((n) => /^[0-9a-f]{64}\.json$/.test(n));
}

/** The synthetic world's shelter strip request, as stage flags. */
async function stageRequest() {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "BIBLE.md");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeStyleBible(bible, world.bible);
  await writeFile(profile, JSON.stringify(world.profile));
  approveProfile(world.profile, { targetDir: world.targetDir });
  const flags = ["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir];
  return { world, spec, bible, profile, runs: world.runsDir, flags };
}

/** A materials request (material-cli.test.ts): an albedo, a derivation and a profile. */
async function materialsRequest(dir: string) {
  const renderer = join(dir, "render.mjs");
  await writeFile(
    renderer,
    `import {copyFileSync} from 'node:fs'; copyFileSync(process.argv[2],process.argv[3]);`,
  );
  const raster = createRaster(8, 8);
  for (let y = 1; y < 7; y++)
    for (let x = 1; x < 7; x++) setPixel(raster, x, y, [100, 100, 100, 255]);
  const albedo = join(dir, "albedo.png");
  await writeFile(albedo, encodePng(raster));
  await writeFile(
    join(dir, "spec.json"),
    JSON.stringify({
      kind: "still",
      assetId: "synthetic",
      frames: { count: 1, width: 4, height: 4 },
    }),
  );
  const profile = {
    format: "assetgrove-target-profile/1",
    name: "synthetic",
    license: "MIT",
    frames: { width: 4, height: 4 },
    style: {
      materials: {
        channels: ["height", "normal"],
        scales: [1, 2],
        flickerBound: 0,
        lightRig: {
          "dusk-rain": { direction: [0.5, -0.5, 1], intensity: 0.4 },
          night: { direction: [0, 0, 1], intensity: 0.1 },
        },
        preview: {
          version: "synthetic-copy-1",
          command: [process.execPath, renderer, albedo, "{{output}}"],
        },
      },
    },
  };
  await writeFile(join(dir, "profile.json"), JSON.stringify(profile));
  approveProfile(profile, { profileDir: dir });
  await writeFile(
    join(dir, "derivation.json"),
    JSON.stringify({
      maps: {
        height: { method: "mask-extraction", version: "1", path: "albedo.png" },
        normal: { method: "height-derived-normal", version: "1" },
      },
    }),
  );
  return [
    ...["--albedo", albedo, "--spec", join(dir, "spec.json")],
    ...["--profile", join(dir, "profile.json"), "--derivation", join(dir, "derivation.json")],
    ...["--out", join(dir, "out"), "--runs", join(dir, "runs")],
  ];
}

const MATERIAL_CHECKS = `({ text: JSON.stringify({ checks: ["flat-albedo","normal-orientation","emissive-placement","dusk-rain","night"].map((check) => ({ check, passed: true, reason: "synthetic fixture" })) }) })`;

test("a second identical stage, generate-sheet and materials run each make zero provider calls and return reused true", async () => {
  // stage
  {
    const { world, flags } = await stageRequest();
    const provider = await countingScript(world.dir);
    const args = ["stage", ...flags, "--candidates", "1", "--provider-script", provider.script];
    const first = await cli([...args, "--json"]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(doc(first).reused, false);
    const calls = await provider.count();
    assert.ok(calls > 0);
    const ledger = await readFile(ledgerPath, "utf8");
    const second = await cli([...args, "--json"]);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(doc(second).reused, true);
    assert.equal(doc(second).runDir, doc(first).runDir);
    assert.deepEqual(doc(second).candidates, doc(first).candidates);
    assert.equal(await provider.count(), calls, "stage: no provider call");
    assert.equal(await readFile(ledgerPath, "utf8"), ledger, "stage: no ledger entry");
  }
  // generate-sheet
  {
    const { world, flags } = await stageRequest();
    const png = Buffer.from(
      syntheticSheet({ families: [{ name: "shelter", count: 6, facing: 1, walk: false }] }).png,
    ).toString("base64");
    const provider = await countingScript(world.dir, {
      image: `({ images: [{ mediaType: "image/png", bytes: Uint8Array.from(Buffer.from("${png}", "base64")) }] })`,
      vision: `({ text: JSON.stringify({ families: [{ name: "shelter", frames: [1, 2, 3, 4, 5, 6] }] }) })`,
    });
    const args = [
      "generate-sheet",
      ...flags,
      ...["--imports", join(world.dir, "imports"), "--provider-script", provider.script],
    ];
    const first = await cli([...args, "--json"]);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.equal(doc(first).reused, false);
    const calls = await provider.count();
    assert.ok(calls > 0);
    const second = await cli([...args, "--json"]);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(doc(second).reused, true);
    assert.equal(doc(second).importDir, doc(first).importDir);
    assert.equal(await provider.count(), calls, "generate-sheet: no provider call");
  }
  // materials
  {
    const dir = await tempDir("assetgrove-runs-materials-");
    const provider = await countingScript(dir, {
      image: `(() => { throw new Error("unexpected model generation"); })()`,
      vision: MATERIAL_CHECKS,
    });
    const args = [
      "materials",
      ...(await materialsRequest(dir)),
      "--provider-script",
      provider.script,
    ];
    const first = await cli([...args, "--json"]);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.equal(doc(first).reused, false);
    const calls = await provider.count();
    assert.ok(calls > 0);
    const second = await cli([...args, "--json"]);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(doc(second).reused, true);
    assert.equal(doc(second).reportPath, doc(first).reportPath);
    assert.equal(await provider.count(), calls, "materials: no provider call");
  }
});

test("a run stopped after k of n calls resumes making only n-k calls, and the ledger counts each call once", async () => {
  const { world, flags } = await stageRequest();
  const provider = await countingScript(world.dir);
  const args = ["stage", ...flags, "--candidates", "2", "--provider-script", provider.script];
  const plan = doc(await cli([...args, "--dry-run", "--json"]));
  const n = (plan.jobs as { count: number }[]).reduce((sum, j) => sum + j.count, 0);
  const k = 5;
  assert.ok(n > k);

  await writeFile(provider.stop, String(k));
  const stopped = await cli([...args, "--json"]);
  assert.ok(killed(stopped), "the run was killed mid-way");
  assert.equal(await provider.count(), k);
  assert.equal((await journal(plan.runDir)).length, k);
  const state = JSON.parse(await readFile(join(plan.runDir, "state.json"), "utf8"));
  assert.equal(state.status, "running");

  await rm(provider.stop);
  const resumed = await cli([...args, "--json"]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(doc(resumed).reused, false);
  assert.equal(await provider.count(), n, `the resume made only the ${n - k} missing calls`);
  assert.equal((await journal(plan.runDir)).length, n);
  assert.equal(existsSync(join(plan.runDir, "lock")), false, "the lock is released");

  // The ledger counts each call once: every answered call has one settled reservation naming its
  // provider, run and call. The call the kill interrupted may have been billed, so its reservation
  // stays at its estimate and the retry of that call reserved again rather than reusing it.
  const runId = doc(resumed).runId as string;
  const { reserves, settled } = await ledgerOf(runId);
  assert.equal(reserves.length, n + 1);
  assert.equal(new Set(reserves.map((r) => r.callKey)).size, n);
  for (const r of reserves) {
    assert.equal(r.provider, "scripted");
    assert.match(r.callKey ?? "", /^[0-9a-f]{64}$/);
  }
  const open = reserves.filter((r) => !settled.has(r.id));
  assert.equal(open.length, 1, "only the interrupted attempt is unsettled");
  assert.equal(reserves.filter((r) => r.callKey === open[0]?.callKey).length, 2);
});

test("a resumed run is checked against the spend limit for its missing calls only", async () => {
  const { world, spec, bible, runs } = await stageRequest();
  const provider = await countingScript(world.dir);
  const base = ["stage", "--spec", spec, "--bible", bible, "--runs", runs];
  const args = [...base, "--candidates", "2", "--provider-script", provider.script];
  const probe = doc(
    await cli([...args, "--profile", join(world.dir, "profile.json"), "--dry-run", "--json"]),
  );
  const jobs = probe.jobs as { count: number; estimatedCostUsd: number }[];
  const n = jobs.reduce((sum, j) => sum + j.count, 0);
  const forecast = probe.forecastUsd as number;
  const largest = Math.max(...jobs.map((j) => j.estimatedCostUsd));
  assert.ok(forecast > 0 && largest > 0);
  // The work item's limit fits the whole forecast and one interrupted call, no more.
  const profile = { ...world.profile, spend: { workItemLimitUsd: forecast + largest } };
  const profilePath = join(world.dir, "limited-profile.json");
  await writeFile(profilePath, JSON.stringify(profile));
  approveProfile(profile, { targetDir: world.targetDir });
  const workItem = `resume-${process.pid}-${Date.now()}`;
  const limited = [...args, "--profile", profilePath, "--work-item", workItem, "--json"];

  const k = 5;
  assert.ok(n > k);
  await writeFile(provider.stop, String(k));
  const stopped = await cli(limited);
  assert.ok(killed(stopped), stopped.stderr);
  await rm(provider.stop);
  // The whole forecast again would cross the limit; the missing calls and the interrupted one fit.
  const resumed = await cli(limited);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(doc(resumed).reused, false);
  assert.equal(await provider.count(), n, "only the missing calls were made");
});

test("a failed call's charge counts against the run's cap when the request is repeated", async () => {
  const { world, flags } = await stageRequest();
  // Each process's third and later image calls fail after the provider may have billed them.
  const script = join(world.dir, "failing.mjs");
  await writeFile(
    script,
    `import base from ${JSON.stringify(pathToFileURL(passingScript).href)};
let images = 0;
export default {
  paid: true,
  image: (r, i) => {
    if (++images >= 3) throw new Error("the upstream timed out after making the image");
    return base.image(r, i);
  },
  vision: (r, i) => base.vision(r, i),
  promptPolicy: () => ({ answer: { type: "boolean", probability: 0 } }),
};`,
  );
  approve(script);
  const cap = 0.35;
  const args = [
    "stage",
    ...flags,
    "--candidates",
    "1",
    "--cap",
    String(cap),
    "--provider-script",
    script,
  ];
  const codes: Array<string | undefined> = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await cli([...args, "--json"]);
    const runId = doc(r).runId as string;
    codes.push(doc(r).error?.code as string | undefined);
    const { reserves } = await ledgerOf(runId);
    assert.ok(reserves.length > 0);
    const charged = await ledgerUsd(runId);
    assert.ok(
      charged <= cap + 1e-9,
      `attempt ${attempt + 1}: $${charged} in the ledger, cap $${cap}`,
    );
  }
  assert.equal(codes[0], "provider_error");
  assert.equal(codes.at(-1), "cap_refused", codes.join(", "));
});

async function ledgerUsd(runId: string): Promise<number> {
  const entries = (await readFile(ledgerPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(
      (l) =>
        JSON.parse(l) as {
          op: string;
          id: string;
          runId?: string;
          amountUsd?: number;
          costUsd?: number;
        },
    );
  const settled = new Map(entries.filter((e) => e.op === "settle").map((e) => [e.id, e.costUsd!]));
  return entries
    .filter((e) => e.op === "reserve" && e.runId === runId)
    .reduce((sum, e) => sum + (settled.get(e.id) ?? e.amountUsd!), 0);
}

test("round 2 creates a new run directory; a live lock exits 2 run_in_progress; a dead pid's lock is taken over", async () => {
  const { world, flags } = await stageRequest();
  const provider = await countingScript(world.dir);
  const args = ["stage", ...flags, "--candidates", "1", "--provider-script", provider.script];
  const first = await cli([...args, "--json"]);
  assert.equal(first.code, 0, first.stderr);
  const calls = await provider.count();

  const round2 = await cli([...args, "--round", "2", "--json"]);
  assert.equal(round2.code, 0, round2.stderr);
  assert.equal(doc(round2).reused, false);
  assert.notEqual(doc(round2).runDir, doc(first).runDir);
  assert.ok(existsSync(doc(first).runDir) && existsSync(doc(round2).runDir));
  assert.equal(await provider.count(), calls * 2, "a new round pays for its own calls");

  // A live process holds round 3's lock: the request is refused before any call.
  const round3 = [...args, "--round", "3"];
  const runDir = doc(await cli([...round3, "--dry-run", "--json"])).runDir as string;
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "lock"), `${process.pid}\n`);
  const busy = await cli([...round3, "--json"]);
  assert.equal(busy.code, 2, busy.stderr);
  assert.equal(doc(busy).error.code, "run_in_progress");
  assert.equal(await provider.count(), calls * 2);
  assert.equal(await readFile(join(runDir, "lock"), "utf8"), `${process.pid}\n`);

  // A dead process's lock is taken over, and released when the run ends.
  const dead = spawn(process.execPath, ["-e", ""]);
  const deadPid = dead.pid as number;
  await new Promise((done) => dead.once("exit", done));
  await writeFile(join(runDir, "lock"), `${deadPid}\n`);
  const taken = await cli([...round3, "--json"]);
  assert.equal(taken.code, 0, taken.stderr);
  assert.equal(doc(taken).runDir, runDir);
  assert.equal(existsSync(join(runDir, "lock")), false);
});

test("a dead lock is taken over by exactly one process, and a lock left by this pid's namesake is dead", async () => {
  const runDir = await tempDir("assetgrove-lock-");
  const dead = spawn(process.execPath, ["-e", ""]);
  const deadPid = dead.pid as number;
  await new Promise((done) => dead.once("exit", done));
  const other = process.ppid; // a live process other than this one

  // A live takeover guard means another process is claiming the dead lock: refused, untouched.
  await writeFile(join(runDir, "lock"), `${deadPid}\n`);
  await writeFile(join(runDir, "lock.takeover"), `${other}\n`);
  assert.throws(() => acquireRunLock(runDir), RunInProgressError);
  assert.equal(await readFile(join(runDir, "lock"), "utf8"), `${deadPid}\n`);

  // Its guard gone, the first claimant takes the dead lock over; a second one, with the dead
  // pid read before, finds the new holder live and is refused rather than overwriting it.
  await rm(join(runDir, "lock.takeover"));
  const first = acquireRunLock(runDir, other);
  assert.equal(first.tookOver, true);
  const holderPid = async () => (await readFile(join(runDir, "lock"), "utf8")).split("\n")[0];
  assert.equal(await holderPid(), String(other));
  assert.throws(() => acquireRunLock(runDir), RunInProgressError);
  assert.equal(await holderPid(), String(other));
  first.release();
  assert.equal(existsSync(join(runDir, "lock")), false);

  // A guard left by a dead claimant is cleared, and the dead lock is taken over.
  await writeFile(join(runDir, "lock"), `${deadPid}\n`);
  await writeFile(join(runDir, "lock.takeover"), `${deadPid}\n`);
  const cleared = acquireRunLock(runDir);
  assert.equal(cleared.tookOver, true);
  assert.deepEqual((await readdir(runDir)).sort(), ["lock"]);

  // This process's own lock is live while it holds it ...
  assert.throws(() => acquireRunLock(runDir), RunInProgressError);
  cleared.release();
  // ... but a lock naming this pid that this process never took was left by a dead namesake.
  await writeFile(join(runDir, "lock"), `${process.pid}\n`);
  const namesake = acquireRunLock(runDir);
  assert.equal(namesake.tookOver, true);
  namesake.release();
  assert.equal(existsSync(join(runDir, "lock")), false);
});

test("a claimant arriving while a lock is being created never finds it empty and takes it over", async () => {
  const runDir = await tempDir("assetgrove-lock-create-");
  const other = process.ppid; // a live process other than this one
  // The second claimant runs at the first one's write: after its exclusive create, before its
  // content, where a reader of an empty lock would take it over as dead.
  const original = fs.writeFileSync;
  let second: RunLock | RunInProgressError | undefined;
  let arrived = false;
  fs.writeFileSync = ((...args: Parameters<typeof original>) => {
    if (!arrived) {
      arrived = true;
      try {
        second = acquireRunLock(runDir, other);
      } catch (error) {
        if (!(error instanceof RunInProgressError)) throw error;
        second = error;
      }
    }
    return original(...args);
  }) as typeof original;
  syncBuiltinESMExports();
  let first: RunLock | RunInProgressError;
  try {
    first = acquireRunLock(runDir);
  } catch (error) {
    if (!(error instanceof RunInProgressError)) throw error;
    first = error;
  } finally {
    fs.writeFileSync = original;
    syncBuiltinESMExports();
  }
  const held = [first, second].filter((l) => l !== undefined && !(l instanceof Error));
  assert.equal(held.length, 1, "exactly one claimant holds the lock");
  for (const lock of held) (lock as RunLock).release();
});

test("a lock whose pid now names another live process is taken over, and a refusal names the lock file", async () => {
  const runDir = await tempDir("assetgrove-lock-reused-");
  const lock = join(runDir, "lock");
  const other = process.ppid; // a live process that never ran this request
  const stale = [
    // Its holder started long before this machine's last boot.
    `${other}\n${JSON.stringify({ startedMs: 0 })}\n`,
    ...(process.platform === "linux"
      ? [
          // Written in another boot.
          `${other}\n${JSON.stringify({ bootId: "00000000-0000-0000-0000-000000000000", startTicks: "1" })}\n`,
          // Written in this boot by a process that started at another time.
          `${other}\n${JSON.stringify({
            bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
            startTicks: "1",
          })}\n`,
        ]
      : []),
  ];
  for (const content of stale) {
    await writeFile(lock, content);
    const taken = acquireRunLock(runDir);
    assert.equal(taken.tookOver, true, content);
    taken.release();
  }
  // The live process's own lock still refuses, and the error names the lock file to remove.
  const held = acquireRunLock(runDir, other);
  assert.throws(
    () => acquireRunLock(runDir),
    (error: Error) => error instanceof RunInProgressError && error.message.includes(lock),
  );
  held.release();
});

test("a materials request's digest covers the preview's script outside the profile folder and the derivation's source images", async () => {
  const dir = await tempDir("assetgrove-materials-digest-");
  const profileDir = join(dir, "profile");
  const tools = join(dir, "tools");
  await mkdir(profileDir, { recursive: true });
  await mkdir(tools, { recursive: true });
  const args = await materialsRequest(profileDir);
  const renderer = join(tools, "render.mjs");
  await writeFile(
    renderer,
    `import {copyFileSync} from 'node:fs'; copyFileSync(process.argv[2],process.argv[3]);`,
  );
  const profilePath = join(profileDir, "profile.json");
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  profile.style.materials.preview.command = [
    process.execPath,
    "../tools/render.mjs",
    join(profileDir, "albedo.png"),
    "{{output}}",
  ];
  await writeFile(profilePath, JSON.stringify(profile));
  approveProfile(profile, { profileDir });
  const source = join(dir, "height-source.png");
  const mask = join(dir, "lamp-mask.png");
  const raster = createRaster(8, 8);
  await writeFile(source, encodePng(raster));
  await writeFile(mask, encodePng(raster));
  await writeFile(
    join(profileDir, "derivation.json"),
    JSON.stringify({
      maps: {
        height: { method: "mask-extraction", version: "1", path: "../height-source.png" },
        normal: { method: "height-derived-normal", version: "1" },
      },
      lightSources: [{ name: "lamp", mask: "../lamp-mask.png" }],
    }),
  );
  const digest = async () => {
    const plan = await cli(["materials", ...args, "--dry-run", "--json"]);
    assert.equal(plan.code, 0, plan.stderr);
    return doc(plan).digest as string;
  };
  const seen = new Set([await digest()]);
  assert.equal(seen.has(await digest()), true, "the same request has the same digest");
  const changed = async (what: string) => {
    const now = await digest();
    assert.ok(!seen.has(now), `${what} changes the digest`);
    seen.add(now);
  };
  await writeFile(renderer, `${await readFile(renderer, "utf8")}\n// changed\n`);
  await changed("the renderer outside the profile folder");
  setPixel(raster, 2, 2, [255, 255, 255, 255]);
  await writeFile(source, encodePng(raster));
  await changed("the map's source image");
  setPixel(raster, 3, 3, [255, 255, 255, 255]);
  await writeFile(mask, encodePng(raster));
  await changed("the light source's mask");
});

test("processes racing to take over one dead lock: exactly one acquires it", async () => {
  const runDir = await tempDir("assetgrove-lock-race-");
  const dead = spawn(process.execPath, ["-e", ""]);
  const deadPid = dead.pid as number;
  await new Promise((done) => dead.once("exit", done));
  await writeFile(join(runDir, "lock"), `${deadPid}\n`);
  const lockModule = pathToFileURL(join(root, "src/runs/lock.ts")).href;
  const go = join(runDir, "go");
  const claimant = `import { existsSync } from "node:fs";
import { acquireRunLock } from ${JSON.stringify(lockModule)};
while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 5));
try {
  const lock = acquireRunLock(${JSON.stringify(runDir)});
  process.stdout.write("acquired");
  await new Promise((r) => setTimeout(r, 1500));
  lock.release();
} catch (error) {
  process.stdout.write(error.code ?? String(error));
}`;
  const children = Array.from({ length: 6 }, () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", claimant], { cwd: root });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    return new Promise<string>((done) => child.once("exit", () => done(out)));
  });
  await new Promise((r) => setTimeout(r, 1000));
  await writeFile(go, "");
  const results = await Promise.all(children);
  assert.equal(results.filter((r) => r === "acquired").length, 1, results.join(", "));
  assert.equal(results.filter((r) => r === "run_in_progress").length, 5, results.join(", "));
  assert.equal(existsSync(join(runDir, "lock")), false);
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "assetgrove-runs-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp"],
      cwd: root,
      env: childEnv() as Record<string, string>,
      stderr: "pipe",
    }),
  );
  clients.push(client);
  return client;
}

test("runs list and runs show return the same JSON on the CLI and as tools", async () => {
  const { world, flags, runs } = await stageRequest();
  const provider = await countingScript(world.dir);
  const staged = await cli([
    ...["stage", ...flags, "--candidates", "1", "--provider-script", provider.script, "--json"],
  ]);
  assert.equal(staged.code, 0, staged.stderr);
  const runId = doc(staged).runId as string;

  const client = await connect();
  const listed = await cli(["runs", "list", "--runs", runs, "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  const list = doc(listed);
  assert.equal(list.command, "runs list");
  assert.deepEqual(
    list.runs.map((r: Doc) => [r.runId, r.command, r.status, r.calls]),
    [[runId, "stage", "finished", await provider.count()]],
  );
  const listTool = await client.callTool({ name: "runs_list", arguments: { runs } });
  assert.deepEqual(listTool.structuredContent, list);

  const shown = await cli(["runs", "show", runId, "--runs", runs, "--json"]);
  assert.equal(shown.code, 0, shown.stderr);
  const show = doc(shown);
  assert.equal(show.runId, runId);
  assert.equal(show.request.digest, doc(staged).digest);
  assert.equal(show.state.status, "finished");
  assert.equal(show.journal.length, await provider.count());
  const showTool = await client.callTool({ name: "runs_show", arguments: { run: runId, runs } });
  assert.deepEqual(showTool.structuredContent, show);

  const missing = await cli(["runs", "show", "r-0000000000000000", "--runs", runs, "--json"]);
  assert.equal(missing.code, 2);
  assert.equal(doc(missing).error.code, "invalid_input");
});
