import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SCRIPTED_LIMIT, approve, approveProfile, writeSettings } from "./fixtures/env.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["src/cli.ts", ...args], { cwd: root }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

interface ReconcileEntry {
  provider: string;
  status: string;
  ledgerUsd?: number;
  providerUsd?: number;
  gapUsd?: number;
  holdId?: string;
  pendingId?: string;
}

interface Hold {
  id: string;
  provider: string;
  runId: string;
  ledgerUsd: number;
  providerUsd: number;
  gapUsd: number;
}

/**
 * A paid provider script. With `usage`, its scripted usage reader reports per-call cost: each
 * call costs `usage.costUsd` at the provider, or is not reported yet while `usage.flag` (when
 * given) names a missing file; then the file's number is the cost.
 */
async function paidScript(
  dir: string,
  usage?: { costUsd?: number; flag?: string },
): Promise<string> {
  const path = join(dir, "paid-script.mjs");
  const reader =
    usage === undefined
      ? ""
      : `reconcile: "per-call-cost",
  callCost: () => ${
    usage.flag !== undefined
      ? `existsSync(${JSON.stringify(usage.flag)}) ? Number(readFileSync(${JSON.stringify(usage.flag)}, "utf8")) : undefined`
      : String(usage.costUsd)
  },`;
  await writeFile(
    path,
    `import { existsSync, readFileSync } from "node:fs";
import base from ${JSON.stringify(pathToFileURL(passingScript).href)};
export default {
  paid: true,
  ${reader}
  image: (r, i) => base.image(r, i),
  vision: (r, i) => base.vision(r, i),
};`,
  );
  approve(path);
  return path;
}

/** A stage request on a fresh synthetic world, and a directory for its script. */
async function stageArgs(candidates = 1): Promise<{ args: string[]; dir: string }> {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  approveProfile(world.profile, { targetDir: world.targetDir });
  const args = [
    "stage",
    ...["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir],
    ...["--candidates", String(candidates), "--json"],
  ];
  return { args, dir: world.dir };
}

async function freshState(): Promise<string> {
  return mkdtemp(join(tmpdir(), "assetgrove-reconcile-"));
}

function settings(stateDir: string, extra: Record<string, unknown> = {}): void {
  writeSettings({ stateDir, providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } }, ...extra });
}

async function runReconcile(r: Result): Promise<ReconcileEntry[]> {
  const document = JSON.parse(r.stdout) as { runDir: string };
  const record = JSON.parse(await readFile(join(document.runDir, "run.json"), "utf8")) as {
    reconcile?: ReconcileEntry[];
  };
  assert.ok(record.reconcile, "run.json records reconcile");
  return record.reconcile;
}

async function readLines<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

function errorCode(r: Result): string | undefined {
  return (JSON.parse(r.stdout) as { error?: { code: string } }).error?.code;
}

test("a gap above the margin writes a hold; paid runs exit 3 spend_hold until settings acknowledge it", async () => {
  const stateDir = await freshState();
  settings(stateDir, { reconcile: { marginUsd: 0.01, marginPct: 5 } });
  const { args, dir } = await stageArgs();
  const script = await paidScript(dir, { costUsd: 1 });

  const first = await cli([...args, "--provider-script", script]);
  assert.equal(first.code, 0, first.stderr);
  const [entry] = await runReconcile(first);
  assert.equal(entry?.provider, "scripted");
  assert.equal(entry?.status, "held");
  const holds = await readLines<Hold>(join(stateDir, "holds.jsonl"));
  assert.equal(holds.length, 1);
  const hold = holds[0]!;
  assert.match(hold.id, /^[0-9a-f]{16}$/);
  assert.equal(entry?.holdId, hold.id);
  assert.equal(hold.provider, "scripted");
  assert.ok(hold.ledgerUsd > 0);
  assert.ok(hold.providerUsd > hold.ledgerUsd);
  assert.ok(Math.abs(hold.gapUsd - (hold.providerUsd - hold.ledgerUsd)) < 1e-9);

  // Every paid run is refused while the hold is open, before anything is spent.
  const ledger = await readFile(join(stateDir, "spend.jsonl"), "utf8");
  const other = await stageArgs(2);
  const held = await cli([...other.args, "--provider-script", script]);
  assert.equal(held.code, 3, held.stderr);
  assert.equal(errorCode(held), "spend_hold");
  assert.equal(await readFile(join(stateDir, "spend.jsonl"), "utf8"), ledger, "nothing spent");

  // spend status lists it as open.
  const status = await cli(["spend", "status", "--json"]);
  const listed = JSON.parse(status.stdout) as { holds: Array<Hold & { acknowledged: boolean }> };
  assert.deepEqual(
    listed.holds.map((h) => [h.id, h.acknowledged]),
    [[hold.id, false]],
  );

  // A person lists the hold id in the settings: paid runs go ahead.
  settings(stateDir, {
    reconcile: { marginUsd: 0.01, marginPct: 5 },
    spend: { acknowledgedHolds: [hold.id] },
  });
  const freed = await cli([...args, "--provider-script", script]);
  assert.equal(freed.code, 0, freed.stderr);
});

test("a gap within the margin writes no hold", async () => {
  const stateDir = await freshState();
  settings(stateDir, { reconcile: { marginUsd: 100 } });
  const { args, dir } = await stageArgs();
  const script = await paidScript(dir, { costUsd: 1 });
  const r = await cli([...args, "--provider-script", script]);
  assert.equal(r.code, 0, r.stderr);
  const [entry] = await runReconcile(r);
  assert.equal(entry?.status, "reconciled");
  assert.ok((entry?.gapUsd ?? 0) > 0, "a gap, within the margin");
  assert.equal(entry?.holdId, undefined);
  assert.equal(existsSync(join(stateDir, "holds.jsonl")), false);
});

test("a provider without usage records reconcile unavailable, and settings check says so", async () => {
  const stateDir = await freshState();
  settings(stateDir);
  const { args, dir } = await stageArgs();
  const script = await paidScript(dir);
  const r = await cli([...args, "--provider-script", script]);
  assert.equal(r.code, 0, r.stderr);
  const entries = await runReconcile(r);
  assert.deepEqual(
    entries.map((e) => [e.provider, e.status]),
    [["scripted", "unavailable"]],
  );
  assert.equal(existsSync(join(stateDir, "holds.jsonl")), false);

  const check = await cli(["settings", "check", "--json"]);
  assert.equal(check.code, 0, check.stderr);
  const providers = (
    JSON.parse(check.stdout) as { providers: Array<{ provider: string; reconcile: string }> }
  ).providers;
  assert.equal(providers.find((p) => p.provider === "scripted")?.reconcile, "unavailable");
});

test("a pending lookup is retried at the next paid run's start", async () => {
  const stateDir = await freshState();
  settings(stateDir, { reconcile: { marginUsd: 0.01 } });
  const { args, dir } = await stageArgs();
  const flag = join(dir, "reported-cost.txt");
  const script = await paidScript(dir, { flag });

  const first = await cli([...args, "--provider-script", script]);
  assert.equal(first.code, 0, first.stderr);
  const [entry] = await runReconcile(first);
  assert.equal(entry?.status, "pending");
  assert.ok(entry?.pendingId);
  assert.equal(existsSync(join(stateDir, "holds.jsonl")), false);

  // The provider reports the calls now, far above the ledger: the next paid run's start
  // resolves the lookup, which holds, so that run is refused.
  await writeFile(flag, "2");
  const other = await stageArgs(2);
  const next = await cli([...other.args, "--provider-script", script]);
  assert.equal(next.code, 3, next.stderr);
  assert.equal(errorCode(next), "spend_hold");
  const holds = await readLines<Hold>(join(stateDir, "holds.jsonl"));
  assert.equal(holds.length, 1);
  assert.equal(holds[0]?.runId, (JSON.parse(first.stdout) as { runId: string }).runId);
  const records = await readLines<{ op: string; id: string }>(join(stateDir, "reconcile.jsonl"));
  assert.deepEqual(
    records.map((r) => [r.op, r.id]),
    [
      ["pending", entry.pendingId],
      ["resolved", entry.pendingId],
    ],
  );
});

test("spend reconcile retries a pending lookup", async () => {
  const stateDir = await freshState();
  settings(stateDir, { reconcile: { marginUsd: 5 } });
  const { args, dir } = await stageArgs();
  const flag = join(dir, "reported-cost.txt");
  const script = await paidScript(dir, { flag });

  const first = await cli([...args, "--provider-script", script]);
  assert.equal(first.code, 0, first.stderr);
  const [entry] = await runReconcile(first);
  assert.equal(entry?.status, "pending");

  // Not reported yet: it stays pending.
  const waiting = await cli(["spend", "reconcile", "--provider-script", script, "--json"]);
  assert.equal(waiting.code, 0, waiting.stderr);
  const still = JSON.parse(waiting.stdout) as { reconciled: ReconcileEntry[] };
  assert.deepEqual(
    still.reconciled.map((e) => [e.status, e.pendingId]),
    [["pending", entry?.pendingId]],
  );

  await writeFile(flag, "0.5");
  const done = await cli(["spend", "reconcile", "--provider-script", script, "--json"]);
  assert.equal(done.code, 0, done.stderr);
  const resolved = JSON.parse(done.stdout) as { reconciled: ReconcileEntry[] };
  assert.equal(resolved.reconciled.length, 1);
  assert.equal(resolved.reconciled[0]?.status, "reconciled");
  assert.ok((resolved.reconciled[0]?.providerUsd ?? 0) > 0);

  // Resolved once: nothing is left to retry.
  const again = await cli(["spend", "reconcile", "--provider-script", script, "--json"]);
  assert.deepEqual((JSON.parse(again.stdout) as { reconciled: unknown[] }).reconciled, []);
});
