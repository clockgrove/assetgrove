import "./fixtures/env.ts";
import { stateDir } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Budget, BudgetExceededError } from "../src/budget.ts";
import { errorOutcome } from "../src/commands/runner.ts";
import { Caller } from "../src/calls.ts";
import { JobStoppedError, ProviderError } from "../src/errors.ts";
import type {
  Billing,
  GenerationProvider,
  ImageResult,
  JobStatus,
  ModelRequest,
  ModelResult,
  VisionResult,
} from "../src/gateway/provider.ts";
import type { Routes } from "../src/routes.ts";
import { executeRun } from "../src/runs/execute.ts";
import { Journal, jobKey, withRunScope } from "../src/runs/journal.ts";
import type { Clearance, RunScope } from "../src/runs/journal.ts";
import type { WorkPlan } from "../src/runs/plan.ts";
import { loadSettings } from "../src/settings.ts";
import { HOLDS_FILE, SpendLedger, appendHold } from "../src/spend.ts";
import type { LoadedReference } from "../src/types.ts";

const temporary: string[] = [];
after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

const ESTIMATE = 0.5;
const COST = 0.4;
const RUN_ID = "r-00000000000000aa";

/** A paid scripted provider that serves model calls as jobs, and can hang where a kill would stop it. */
class JobScript implements GenerationProvider {
  readonly billing: Billing = {
    adapter: "scripted-jobs",
    providerId: "jobs",
    paid: true,
    hosts: [],
    settle: "reported",
    reconcile: "unavailable",
    limit: { kind: "prepaid", usd: 100 },
  };
  /** Every key `submit` was called with, in order. */
  readonly submitted: string[] = [];
  /** The jobs the provider holds, by handle, with the key each was submitted with. */
  readonly held = new Map<string, string>();
  readonly results: string[] = [];
  /** Where the next process dies: after submit returns nothing, or on its first status read. */
  hang: "submit" | "status" | undefined;
  /** Each handle's statuses in turn (the last repeats); `done` when none is scripted. */
  readonly statuses = new Map<string, JobStatus[]>();
  /** Every new job's statuses. */
  script: JobStatus[] = ["running", "done"];
  /** Resolves once a job is at the provider. */
  reached: Promise<void>;
  #reach: () => void = () => {};
  readonly jobs: GenerationProvider["jobs"];

  constructor(options: { dedupesByKey?: boolean; find?: boolean } = {}) {
    this.reached = this.#arm();
    this.jobs = {
      model: {
        ...(options.dedupesByKey && { dedupesByKey: true }),
        submit: (_request: ModelRequest, { key }) => {
          this.submitted.push(key);
          const existing = options.dedupesByKey
            ? [...this.held].find(([, k]) => k === key)?.[0]
            : undefined;
          const handle = existing ?? `job-${this.held.size + 1}`;
          if (existing === undefined) {
            this.held.set(handle, key);
            this.statuses.set(handle, [...this.script]);
          }
          this.#reach();
          if (this.hang === "submit") return new Promise<string>(() => {});
          return Promise.resolve(handle);
        },
        status: (handle) => {
          if (this.hang === "status") return new Promise<JobStatus>(() => {});
          const queue = this.statuses.get(handle) ?? ["done"];
          return Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0]!);
        },
        result: (handle): Promise<ModelResult> => {
          this.results.push(handle);
          return Promise.resolve({
            handle,
            glb: new Uint8Array([1, 2, 3]),
            requestId: handle,
            costUsd: COST,
          });
        },
        ...(options.find && {
          find: (key: string) =>
            Promise.resolve([...this.held].find(([, k]) => k === key)?.[0] as string | undefined),
        }),
      },
    };
  }

  /** A fresh process: nothing hangs unless told, and `reached` waits for the next job. */
  restart(hang?: "submit" | "status"): void {
    this.hang = hang;
    this.reached = this.#arm();
  }

  #arm(): Promise<void> {
    return new Promise((resolve) => (this.#reach = resolve));
  }

  generateImage(): Promise<ImageResult> {
    return Promise.reject(new Error("not scripted"));
  }

  analyzeImages(): Promise<VisionResult> {
    return Promise.reject(new Error("not scripted"));
  }
}

const routes = {
  model3d: { provider: "jobs", model: "m", estimatedCostUsd: ESTIMATE },
} as unknown as Routes;
const view: LoadedReference & { view: string } = {
  view: "front",
  role: "front",
  path: "front.png",
  sha256: "a".repeat(64),
  mediaType: "image/png",
  bytes: new Uint8Array([9]),
} as LoadedReference & { view: string };
const clearance = { digest: "d", record: {} } as unknown as Clearance;

async function runDir(): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-jobs-")));
  temporary.push(root);
  const dir = join(root, RUN_ID);
  mkdirSync(dir);
  return dir;
}

function ledgerAt(dir: string, dailyUsd = 100): SpendLedger {
  return new SpendLedger({
    path: join(dir, "..", "spend.jsonl"),
    caps: { runUsd: 10, dailyUsd, workItemUsd: 100 },
    daily: { settings: dailyUsd },
    workItemLimit: { settings: 100 },
  });
}

/** One process's model call in the run directory, with a fresh journal, budget and caller. */
function call(
  dir: string,
  provider: JobScript,
  options: {
    cap?: number;
    ledger?: SpendLedger;
    deadlineMs?: number;
    scope?: Partial<RunScope>;
  } = {},
): { result: Promise<ModelResult>; budget: () => Budget } {
  const journal = new Journal(dir, RUN_ID);
  let budget: Budget | undefined;
  const result = withRunScope({ journal, clearance, ...options.scope }, async () => {
    budget = new Budget(options.cap ?? 5, options.ledger ?? ledgerAt(dir));
    const caller = new Caller({
      provider,
      providerName: "jobs",
      budget,
      routes,
      jobPolling: {
        firstMs: 1,
        maxMs: 1,
        deadlineMs: options.deadlineMs ?? 60_000,
        sleep: () => Promise.resolve(),
      },
    });
    return caller.model3d("model3d", "a lantern", [view]);
  });
  return { result, budget: () => budget as Budget };
}

/** Starts a call and leaves it where the provider hangs, as a killed process leaves it. */
async function killed(dir: string, provider: JobScript, hang: "submit" | "status"): Promise<void> {
  provider.restart(hang);
  const { result } = call(dir, provider);
  result.catch(() => {});
  await provider.reached;
  // Let the journal write after submit happen, as it does before a kill that comes later.
  await new Promise((resolve) => setImmediate(resolve));
  provider.restart();
}

function reservations(dir: string) {
  return ledgerAt(dir).entries();
}

async function jobRecords(dir: string): Promise<string[]> {
  return (await readdir(join(dir, "calls"))).filter((n) => n.endsWith(".job.json"));
}

test("the job key is a hash of the run id, the call key and the attempt", () => {
  const key = jobKey(RUN_ID, "c".repeat(64), 1);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(jobKey(RUN_ID, "c".repeat(64), 1), key);
  assert.notEqual(jobKey(RUN_ID, "c".repeat(64), 2), key);
  assert.notEqual(jobKey("r-00000000000000bb", "c".repeat(64), 1), key);
  assert.notEqual(jobKey(RUN_ID, "d".repeat(64), 1), key);
});

test("a job is reserved, journaled with its key and handle, polled and settled at its cost", async () => {
  const dir = await runDir();
  const provider = new JobScript();
  const { result } = call(dir, provider);
  const model = await result;
  assert.equal(model.handle, "job-1");
  assert.equal(provider.submitted.length, 1);
  const [entry] = reservations(dir);
  assert.equal(reservations(dir).length, 1);
  assert.equal(entry?.amountUsd, ESTIMATE);
  assert.equal(entry?.costUsd, COST);
  assert.equal(entry?.requestId, "job-1");
  assert.deepEqual(await jobRecords(dir), [], "the job record goes once the answer is journaled");
  assert.equal(new Journal(dir, RUN_ID).count(), 1);
  const key = provider.submitted[0]!;
  assert.equal(key, jobKey(RUN_ID, entry!.callKey!, 1));
});

test("a kill after submit resumes without a second submit or a second reservation", async () => {
  const dir = await runDir();
  const provider = new JobScript();
  await killed(dir, provider, "status");
  const [record] = await jobRecords(dir);
  assert.ok(record, "the submitted job is journaled");
  const open = new Journal(dir, RUN_ID).openJobs();
  assert.equal(open[0]?.handle, "job-1");
  assert.equal(open[0]?.attempt, 1);
  assert.equal(open[0]?.reservationId, reservations(dir)[0]?.id);
  assert.equal(reservations(dir)[0]?.costUsd, undefined, "the reservation stays open");

  // The cap fits one call only: a second reservation, or counting the open one twice, would refuse.
  const resumed = call(dir, provider, { cap: ESTIMATE });
  const model = await resumed.result;
  assert.equal(model.handle, "job-1");
  assert.equal(provider.submitted.length, 1, "no second submit");
  assert.equal(reservations(dir).length, 1, "no second reservation");
  assert.equal(reservations(dir)[0]?.costUsd, COST, "the adopted reservation is settled");
  assert.equal(resumed.budget().spentUsd, COST);
  assert.deepEqual(await jobRecords(dir), []);
});

test("a resumed run's forecast check does not count the adopted job twice", async () => {
  const dir = await runDir();
  const provider = new JobScript();
  await killed(dir, provider, "status");
  // The daily limit fits the forecast once beside the open reservation, not twice.
  const ledger = ledgerAt(dir, ESTIMATE + 0.1);
  await withRunScope({ journal: new Journal(dir, RUN_ID), clearance }, async () => {
    const budget = new Budget(5, ledger);
    assert.equal(budget.spentUsd, 0, "the open job is not counted as unanswered spend");
    budget.check(ESTIMATE, "the run");
  });
  const model = await call(dir, provider, { ledger }).result;
  assert.equal(model.handle, "job-1");
  assert.equal(reservations(dir).length, 1);
});

test("collecting a submitted job is refused by no cap or limit", async () => {
  const dir = await runDir();
  const provider = new JobScript();
  await killed(dir, provider, "status");
  // Another run has since spent the whole daily limit; the run's cap has no room left either.
  const full = ledgerAt(dir, 1);
  full.settle(full.reserve(1 - ESTIMATE, "another run's call", "jobs:other:m"), 1 - ESTIMATE);
  const model = await call(dir, provider, { cap: 0, ledger: full }).result;
  assert.equal(model.handle, "job-1");
  assert.equal(provider.submitted.length, 1);
});

test("a kill between submit and journal: a provider that dedupes by key gets the same key again", async () => {
  const dir = await runDir();
  const provider = new JobScript({ dedupesByKey: true });
  await killed(dir, provider, "submit");
  const [open] = new Journal(dir, RUN_ID).openJobs();
  assert.equal(open?.handle, undefined, "the intent is journaled, the handle is not");
  const model = await call(dir, provider, { cap: ESTIMATE }).result;
  assert.equal(model.handle, "job-1");
  assert.deepEqual(provider.submitted, [open!.key, open!.key], "submitted again with the same key");
  assert.equal(provider.held.size, 1, "the provider made one job");
  assert.equal(reservations(dir).length, 1, "no second reservation");
  assert.equal(reservations(dir)[0]?.costUsd, COST);
});

test("a kill between submit and journal: a provider that finds by key is asked, not submitted to", async () => {
  const dir = await runDir();
  const provider = new JobScript({ find: true });
  await killed(dir, provider, "submit");
  const model = await call(dir, provider, { cap: ESTIMATE }).result;
  assert.equal(model.handle, "job-1");
  assert.equal(provider.submitted.length, 1, "no second submit");
  assert.equal(reservations(dir).length, 1, "no second reservation");
  assert.equal(reservations(dir)[0]?.costUsd, COST);
});

test("a kill between submit and journal: a provider with neither stops for a person, naming the request", async () => {
  const dir = await runDir();
  const provider = new JobScript();
  await killed(dir, provider, "submit");
  const [open] = new Journal(dir, RUN_ID).openJobs();
  const resumed = call(dir, provider);
  await assert.rejects(resumed.result, (error: Error) => {
    assert.ok(error instanceof JobStoppedError);
    assert.match(error.message, /model3d call's job/);
    assert.ok(error.message.includes(open!.key), error.message);
    assert.ok(error.message.includes(`${open!.callKey}.job.json`), error.message);
    return true;
  });
  assert.equal(provider.submitted.length, 1, "no second submit");
  assert.equal(reservations(dir).length, 1, "no second reservation");
  assert.equal(new Journal(dir, RUN_ID).openJobs().length, 1, "the intent stays for the person");
});

test("unknown stops for a person and keeps the job journaled", async () => {
  const dir = await runDir();
  const provider = new JobScript();
  provider.script = ["running", "unknown"];
  await assert.rejects(call(dir, provider).result, (error: Error) => {
    assert.ok(error instanceof JobStoppedError, "a stop, not one failed candidate");
    assert.match(error.message, /job-1 in an unknown state/);
    return true;
  });
  assert.equal(new Journal(dir, RUN_ID).openJobs()[0]?.handle, "job-1");
  assert.equal(reservations(dir)[0]?.costUsd, undefined);
});

test("passing the deadline exits resumable; the resume collects the same job", async () => {
  const dir = await runDir();
  const provider = new JobScript();
  provider.script = ["running"];
  await assert.rejects(call(dir, provider, { deadlineMs: 3 }).result, (error: Error) => {
    assert.ok(error instanceof JobStoppedError, "a stop, not one failed candidate");
    assert.match(error.message, /job-1 is still running .*repeat the request to collect it/);
    return true;
  });
  assert.equal(new Journal(dir, RUN_ID).openJobs()[0]?.handle, "job-1");
  provider.statuses.set("job-1", ["done"]);
  const model = await call(dir, provider).result;
  assert.equal(model.handle, "job-1");
  assert.equal(provider.submitted.length, 1);
  assert.equal(reservations(dir).length, 1);
});

test("a failed job is retried with a new attempt key and its own reservation", async () => {
  const dir = await runDir();
  const provider = new JobScript();
  provider.script = ["failed"];
  // The first job fails; the retry's is scripted to finish.
  const submit = provider.jobs!.model!.submit.bind(provider.jobs!.model);
  provider.jobs!.model!.submit = async (request, options) => {
    const handle = await submit(request, options);
    provider.script = ["done"];
    return handle;
  };
  const model = await call(dir, provider).result;
  assert.equal(model.handle, "job-2");
  const [first, second] = provider.submitted;
  const callKey = reservations(dir)[0]!.callKey!;
  assert.equal(first, jobKey(RUN_ID, callKey, 1));
  assert.equal(second, jobKey(RUN_ID, callKey, 2));
  const [failed, retried] = reservations(dir);
  assert.equal(failed?.costUsd, ESTIMATE, "the failed job keeps its estimate");
  assert.equal(retried?.costUsd, COST);
});

test("a run held by a spend hold still collects a submitted job, and spends nothing new", async () => {
  const runs = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-jobs-held-")));
  temporary.push(runs);
  const dir = join(runs, RUN_ID);
  mkdirSync(dir);
  const settings = loadSettings();
  const ledger = SpendLedger.fromSettings(settings);
  const provider = new JobScript();
  const plan: WorkPlan = {
    jobs: [
      { operation: "model3d", provider: "jobs", model: "m", count: 2, estimatedCostUsd: ESTIMATE },
    ],
    candidates: 1,
    forecastUsd: 2 * ESTIMATE,
    capUsd: 5,
    paid: true,
    inputs: {},
    options: {},
    policyTextSha256: "",
    digest: "e".repeat(64),
    runDir: dir,
  };
  const calls: string[] = [];
  const execute = () =>
    executeRun({
      command: "jobs-test",
      plan,
      ctx: { settings, log: () => {} },
      toOutcome: (error) => ({
        exitCode: (error as { code?: string }).code === "spend_hold" ? 3 : 4,
        fields: {},
        human: "",
        error: {
          code:
            (error as { code?: string }).code === "spend_hold" ? "spend_hold" : "provider_error",
          message: (error as Error).message,
        },
      }),
      run: async () => {
        const budget = new Budget(plan.capUsd, ledger);
        const caller = new Caller({
          provider,
          providerName: "jobs",
          budget,
          routes,
          jobPolling: { firstMs: 1, maxMs: 1, sleep: () => Promise.resolve() },
        });
        for (const prompt of ["a lantern", "a kettle"]) {
          calls.push(prompt);
          await caller.model3d("model3d", prompt, [view]);
        }
        return { exitCode: 0, fields: {}, human: "" };
      },
    });

  try {
    // The first attempt dies while its first job runs.
    provider.restart("status");
    const first = execute();
    first.catch(() => {});
    await provider.reached;
    await new Promise((resolve) => setImmediate(resolve));
    provider.restart();
    assert.equal(new Journal(dir, RUN_ID).openJobs()[0]?.handle, "job-1");
    // The dead attempt's lock names this live process; a new process would take it over.
    rmSync(join(dir, "lock"), { force: true });
    calls.length = 0;

    appendHold(stateDir, {
      provider: "jobs",
      runId: "r-00000000000000ff",
      ledgerUsd: 1,
      providerUsd: 2,
      gapUsd: 1,
    });
    const held = await execute();
    assert.equal(held.error?.code, "spend_hold", JSON.stringify(held));
    assert.equal(held.exitCode, 3);
    assert.deepEqual(provider.results, ["job-1"], "the submitted job was collected");
    assert.equal(provider.submitted.length, 1, "nothing new was submitted");
    assert.equal(new Journal(dir, RUN_ID).count(), 1, "the collected answer is journaled");
    const mine = ledger.entries().filter((e) => e.runId === RUN_ID);
    assert.equal(mine.length, 1, "nothing new was reserved");
    assert.equal(mine[0]?.costUsd, COST);
    assert.deepEqual(calls, ["a lantern", "a kettle"]);
    const record = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
      reconcile?: unknown;
    };
    assert.ok(Array.isArray(record.reconcile), "the held run's end reconciles what it settled");

    // With nothing left to collect, the hold refuses the run before it starts.
    calls.length = 0;
    const refused = await execute();
    assert.equal(refused.error?.code, "spend_hold");
    assert.deepEqual(calls, [], "the command never ran");
  } finally {
    rmSync(join(stateDir, HOLDS_FILE), { force: true });
  }
  assert.equal(existsSync(join(stateDir, HOLDS_FILE)), false);
});

/** A provider whose submit throws: lost on the way (no status), or refused with an HTTP status. */
function failingSubmit(provider: JobScript, status?: number): void {
  const model = provider.jobs!.model!;
  const submit = model.submit.bind(model);
  let first = true;
  model.submit = async (request, options) => {
    if (!first) return submit(request, options);
    first = false;
    provider.submitted.push(options.key);
    throw new ProviderError("tripo model: request failed", {
      ...(status !== undefined && { status }),
    });
  };
}

test("a submit lost on the way keeps the intent and its reservation, and stops for a person on a provider with neither", async () => {
  const dir = await runDir();
  const provider = new JobScript();
  failingSubmit(provider);
  await assert.rejects(call(dir, provider).result, (error: Error) => {
    assert.ok(error instanceof JobStoppedError, error.message);
    assert.match(error.message, /neither find a job by its key nor deduplicate one/);
    return true;
  });
  const [open] = new Journal(dir, RUN_ID).openJobs();
  assert.equal(open?.handle, undefined, "an intent with no handle, not a failed job");
  assert.equal(open?.attempt, 1);
  assert.equal(reservations(dir)[0]?.costUsd, undefined, "the reservation stays open");
  // The resume treats it as a kill between submit and journal: no second submit.
  await assert.rejects(call(dir, provider).result, JobStoppedError);
  assert.equal(provider.submitted.length, 1, "no second submit, no new attempt key");
  assert.equal(reservations(dir).length, 1);
});

test("a submit lost on the way is submitted again with the same key where the provider dedupes", async () => {
  const dir = await runDir();
  const provider = new JobScript({ dedupesByKey: true });
  failingSubmit(provider);
  await assert.rejects(call(dir, provider).result, JobStoppedError);
  const model = await call(dir, provider, { cap: ESTIMATE }).result;
  assert.equal(model.handle, "job-1");
  const [first, second] = provider.submitted;
  assert.equal(second, first, "the same key, not a new attempt's");
  assert.equal(reservations(dir).length, 1, "no second reservation");
  assert.equal(reservations(dir)[0]?.costUsd, COST);
});

test("a submit the provider refused is a failed attempt, retried under a new key", async () => {
  const dir = await runDir();
  const provider = new JobScript();
  failingSubmit(provider, 400);
  await assert.rejects(call(dir, provider).result, ProviderError);
  assert.deepEqual(new Journal(dir, RUN_ID).openJobs(), [], "no open job");
  assert.equal(reservations(dir)[0]?.costUsd, ESTIMATE);
  const model = await call(dir, provider).result;
  assert.equal(model.handle, "job-1");
  assert.notEqual(provider.submitted[1], provider.submitted[0], "attempt 2 has its own key");
});

test("a job record left beside its journaled answer is no open job, and the journal hit removes it", async () => {
  const dir = await runDir();
  const provider = new JobScript();
  await call(dir, provider).result;
  const [entry] = reservations(dir);
  // A crash between journaling the answer and removing the job record leaves both.
  const journal = new Journal(dir, RUN_ID);
  journal.writeJob({
    callKey: entry!.callKey!,
    operation: "model3d",
    provider: "jobs",
    attempt: 1,
    key: jobKey(RUN_ID, entry!.callKey!, 1),
    handle: "job-1",
    reservationId: entry!.id,
    reservedUsd: ESTIMATE,
  });
  assert.deepEqual(journal.openJobs(), [], "the answered call's record holds no reservation");
  // The forecast check counts the answered call once (its journaled cost), not again as an open
  // reservation: a forecast that fits the daily limit only with the call taken off twice is refused.
  const daily = ledgerAt(dir, COST + 0.3);
  await withRunScope({ journal, clearance }, async () => {
    assert.throws(() => new Budget(5, daily).check(COST + 0.5, "the run"), BudgetExceededError);
  });
  // A spend hold refuses the run before it starts: the leftover record is no job to collect.
  appendHold(stateDir, {
    provider: "jobs",
    runId: "r-00000000000000ff",
    ledgerUsd: 1,
    providerUsd: 2,
    gapUsd: 1,
  });
  try {
    let ran = false;
    const held = await executeRun({
      command: "jobs-test",
      plan: {
        jobs: [
          {
            operation: "model3d",
            provider: "jobs",
            model: "m",
            count: 1,
            estimatedCostUsd: ESTIMATE,
          },
        ],
        candidates: 1,
        forecastUsd: ESTIMATE,
        capUsd: 5,
        paid: true,
        inputs: {},
        options: {},
        policyTextSha256: "",
        digest: "f".repeat(64),
        runDir: dir,
      },
      ctx: { settings: loadSettings(), log: () => {} },
      toOutcome: errorOutcome,
      run: () => {
        ran = true;
        return Promise.resolve({ exitCode: 0, fields: {}, human: "" });
      },
    });
    assert.equal(held.error?.code, "spend_hold", JSON.stringify(held));
    assert.equal(held.exitCode, 3);
    assert.equal(ran, false, "the held run never started");
  } finally {
    rmSync(join(stateDir, HOLDS_FILE), { force: true });
  }
  const resumed = call(dir, provider);
  const model = await resumed.result;
  assert.equal(model.handle, "job-1");
  assert.equal(provider.submitted.length, 1);
  assert.deepEqual(await jobRecords(dir), [], "the journal hit removed the leftover record");
});
