import "./fixtures/env.ts";
import { approve, approveProfile, ledgerPath } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

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
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
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
  assert.equal(stopped.signal, "SIGKILL", "the run was killed mid-way");
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

  // The ledger counts each call once: one reservation per callKey, every one settled, each naming
  // its provider, run and call.
  const runId = doc(resumed).runId as string;
  const { reserves, settled } = await ledgerOf(runId);
  assert.equal(reserves.length, n);
  assert.equal(new Set(reserves.map((r) => r.callKey)).size, n);
  for (const r of reserves) {
    assert.equal(r.provider, "scripted");
    assert.match(r.callKey ?? "", /^[0-9a-f]{64}$/);
    assert.ok(settled.has(r.id), "settled");
  }
});

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
