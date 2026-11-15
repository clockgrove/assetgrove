import "./fixtures/env.ts";
import { approve, approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { pidAlive } from "../src/runs/lock.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));

const temporary: string[] = [];
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["AI_GATEWAY_API_KEY"];
  return env;
}

/** A paid scripted provider that takes `delayMs` per call and counts each call it answers. */
async function slowScript(dir: string, delayMs: number) {
  const script = join(dir, "slow.mjs");
  const events = join(dir, "slow.events");
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
import base from ${JSON.stringify(pathToFileURL(passingScript).href)};
// The scripted provider calls the script synchronously: the delay blocks, as a slow call would.
const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});
const answered = (kind) => appendFileSync(${JSON.stringify(events)}, kind + "\\n");
export default {
  paid: true,
  image: (r, i) => (wait(), answered("image"), base.image(r, i)),
  vision: (r, i) => (wait(), answered("vision"), base.vision(r, i)),
};`,
  );
  approve(script);
  const count = async () =>
    existsSync(events) ? (await readFile(events, "utf8")).split("\n").filter(Boolean).length : 0;
  return { script, count };
}

async function stageArgs() {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  approveProfile(world.profile, { targetDir: world.targetDir });
  return { world, args: { spec, bible, profile, runs: world.runsDir, candidates: 2 } };
}

/** The official client over stdio, against `assetgrove mcp` with the scripted provider. */
async function connect(script: string): Promise<{ client: Client; pid: number }> {
  const client = new Client({ name: "assetgrove-progress-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--provider-script", script],
    cwd: root,
    env: childEnv(),
    stderr: "pipe",
  });
  await client.connect(transport);
  clients.push(client);
  return { client, pid: transport.pid as number };
}

/** The request's WorkPlan, from the CLI's dry run. */
function dryRun(
  args: Record<string, unknown>,
): Promise<{ jobs: { count: number }[]; runDir: string }> {
  const flags = Object.entries(args).flatMap(([k, v]) => [`--${k}`, String(v)]);
  return new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      ["src/cli.ts", "stage", ...flags, "--dry-run", "--json"],
      { cwd: root, env: childEnv() },
      (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout))),
    ),
  );
}

async function journaled(runDir: string): Promise<number> {
  if (!existsSync(join(runDir, "calls"))) return 0;
  return (await readdir(join(runDir, "calls"))).filter((n) => /^[0-9a-f]{64}\.json$/.test(n))
    .length;
}

test("a stage with a progressToken receives at least one notification per job", async () => {
  const { world, args } = await stageArgs();
  const provider = await slowScript(world.dir, 0);
  const plan = await dryRun(args);
  const { client } = await connect(provider.script);
  const updates: { progress: number; total?: number }[] = [];
  const result = await client.callTool(
    { name: "stage", arguments: args },
    { onprogress: (p) => updates.push(p) },
  );
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  assert.ok(plan.jobs.length > 0);
  assert.ok(
    updates.length >= plan.jobs.length,
    `${updates.length} notifications for ${plan.jobs.length} jobs`,
  );
  const total = plan.jobs.reduce((sum, j) => sum + j.count, 0);
  assert.ok(updates.every((u) => u.total === total));
  // One update per planned call, each job's calls among them: progress takes every value 1..total.
  assert.ok(plan.jobs.every((j) => j.count >= 1));
  const seen = new Set(updates.map((u) => u.progress));
  for (let k = 1; k <= total; k++) assert.ok(seen.has(k), `no update for call ${k} of ${total}`);
});

test("after the client closes mid-run, repeating the request in a new server completes with only the missing calls", async () => {
  const { world, args } = await stageArgs();
  const provider = await slowScript(world.dir, 400);
  const plan = await dryRun(args);
  const n = plan.jobs.reduce((sum, j) => sum + j.count, 0);

  const first = await connect(provider.script);
  let answered: () => void;
  const twoAnswered = new Promise<void>((done) => (answered = done));
  const call = first.client
    .callTool(
      { name: "stage", arguments: args },
      { onprogress: (p) => (p.progress >= 2 ? answered() : undefined), timeout: 120_000 },
    )
    .catch(() => undefined);
  await twoAnswered;
  await first.client.close();
  await call;
  // The server process ends when its client goes; wait until it has.
  for (let i = 0; i < 200 && pidAlive(first.pid); i++) await delay(50);
  assert.equal(pidAlive(first.pid), false, "the first server stopped");

  const k = await journaled(plan.runDir);
  const before = await provider.count();
  assert.ok(k >= 2 && k < n, `stopped mid-run: ${k} of ${n} calls journaled`);

  const second = await connect(provider.script);
  const result = await second.client.callTool(
    { name: "stage", arguments: args },
    { timeout: 120_000 },
  );
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  const document = result.structuredContent as { reused: boolean; runDir: string };
  assert.equal(document.reused, false);
  assert.equal(document.runDir, plan.runDir);
  assert.equal(await provider.count(), before + (n - k), `only the ${n - k} missing calls`);
  assert.equal(await journaled(plan.runDir), n);
});
