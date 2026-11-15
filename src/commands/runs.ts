/**
 * `runs list` and `runs show` (design section 9): what the runs directory holds, read from each
 * run's `request.json`, `state.json`, `run.json` and call journal. Free: no provider call, no
 * ledger entry, no write.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { InputError } from "../errors.ts";
import { RUN_RECORD_FILE, REQUEST_FILE } from "../runs/dir.ts";
import { STATE_FILE, readRunState } from "../runs/execute.ts";
import type { RunState } from "../runs/execute.ts";
import { CALLS_DIR, journalCount } from "../runs/journal.ts";
import { LOCK_FILE, pidAlive } from "../runs/lock.ts";
import { DEFAULT_RUNS } from "../runs/plan.ts";
import { usd } from "./result.ts";
import { defineCommand } from "./types.ts";

const RUN_ID = /^r-[0-9a-f]{16}$/;

const RUNS_DIR_PROPERTY = {
  type: "string",
  description: "the runs directory to read",
  default: DEFAULT_RUNS,
} as const;

/** Where a run stands: its state, or `interrupted` when the process running it is gone. */
type Status = RunState["status"] | "interrupted" | "unknown";

/** One run as `runs list` shows it. */
export interface RunSummary {
  runId: string;
  runDir: string;
  command: string | null;
  digest: string | null;
  status: Status;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  attempts: number;
  /** How many calls the run's journal holds. */
  calls: number;
  forecastUsd: number | null;
  capUsd: number | null;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function lockHolder(runDir: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(join(runDir, LOCK_FILE), "utf8").trim(), 10);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function summary(runDir: string): RunSummary {
  const state = readRunState(runDir);
  const request = readJsonFile(join(runDir, REQUEST_FILE));
  const record = readJsonFile(join(runDir, RUN_RECORD_FILE));
  let status: Status = state?.status ?? "unknown";
  if (status === "running") {
    const pid = lockHolder(runDir);
    if (pid === undefined || !pidAlive(pid)) status = "interrupted";
  }
  const number = (v: unknown) => (typeof v === "number" ? v : null);
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    runId: basename(runDir),
    runDir,
    command: state?.command ?? text(record?.["command"]),
    digest: state?.digest ?? text(request?.["digest"]),
    status,
    startedAt: state?.startedAt ?? null,
    finishedAt: state?.finishedAt ?? null,
    exitCode: state?.exitCode ?? null,
    attempts: state?.attempts ?? 0,
    calls: journalCount(join(runDir, CALLS_DIR)),
    forecastUsd: number(request?.["forecastUsd"]),
    capUsd: number(request?.["capUsd"]),
  };
}

function listRuns(runsDir: string): RunSummary[] {
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => RUN_ID.test(name))
    .sort()
    .map((name) => summary(join(runsDir, name)));
}

function line(r: RunSummary): string {
  const cost = r.forecastUsd === null ? "" : `  forecast ${usd(r.forecastUsd)}`;
  return `${r.runId}  ${r.command ?? "?"}  ${r.status}  ${r.calls} call(s)${cost}`;
}

interface RunsListArgs {
  runs?: string;
}

export const runsListCommand = defineCommand<RunsListArgs>({
  name: "runs list",
  tool: "runs_list",
  summary: "list the runs in the runs directory and where each stands",
  details: `Lists every run directory (r-<16 hex of the request digest>) under --runs: its command,
digest, status (running, finished, failed, or interrupted when the process running it is gone),
times, attempts and how many calls its journal holds. Spends nothing and writes nothing.`,
  input: {
    type: "object",
    properties: { runs: RUNS_DIR_PROPERTY },
    additionalProperties: false,
  },
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args) {
    const runsDir = resolve(args.runs ?? DEFAULT_RUNS);
    const runs = listRuns(runsDir);
    const human = runs.length === 0 ? `no runs in ${runsDir}` : runs.map(line).join("\n");
    return { exitCode: 0, fields: { runsDir, runs }, human };
  },
});

interface RunsShowArgs {
  run: string;
  runs?: string;
}

export const runsShowCommand = defineCommand<RunsShowArgs>({
  name: "runs show",
  tool: "runs_show",
  summary: "show one run: its request, state, record and journaled calls",
  details: `Shows the run named by its id (r-<16 hex>) under --runs: the request (request.json, the
WorkPlan), the state (state.json), the run record (run.json) and each call in its journal
(calls/<callKey>.json) with its operation, provider, model and cost. Spends nothing and writes
nothing.`,
  input: {
    type: "object",
    properties: {
      run: { type: "string", description: "the run id", placeholder: "<r-16hex>" },
      runs: RUNS_DIR_PROPERTY,
    },
    required: ["run"],
    additionalProperties: false,
  },
  positionals: [{ name: "run" }],
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args) {
    if (!RUN_ID.test(args.run))
      throw new InputError(`invalid run id "${args.run}": expected r-<16 hex>`);
    const runDir = join(resolve(args.runs ?? DEFAULT_RUNS), args.run);
    if (!existsSync(runDir)) throw new InputError(`no run ${args.run} in ${dirname(runDir)}`);
    const callsDir = join(runDir, CALLS_DIR);
    let names: string[] = [];
    try {
      names = readdirSync(callsDir).filter((n) => /^[0-9a-f]{64}\.json$/.test(n));
    } catch {
      names = [];
    }
    const calls = names.sort().flatMap((name) => {
      const entry = readJsonFile(join(callsDir, name));
      if (entry === undefined) return [];
      const record = entry["record"] as Record<string, unknown> | undefined;
      return [
        {
          callKey: entry["callKey"],
          operation: entry["operation"],
          provider: entry["provider"],
          model: entry["model"],
          costUsd: record?.["costUsd"] ?? null,
          costSource: record?.["costSource"] ?? null,
          requestId: record?.["requestId"] ?? null,
        },
      ];
    });
    const fields = {
      ...summary(runDir),
      request: readJsonFile(join(runDir, REQUEST_FILE)) ?? null,
      state: readJsonFile(join(runDir, STATE_FILE)) ?? null,
      record: readJsonFile(join(runDir, RUN_RECORD_FILE)) ?? null,
      journal: calls,
    };
    const human = [
      line(fields),
      ...calls.map(
        (c) =>
          `  ${String(c.operation)}  ${String(c.provider)}  ${String(c.model)}  ${String(c.costUsd)}`,
      ),
    ].join("\n");
    return { exitCode: 0, fields, human };
  },
});
