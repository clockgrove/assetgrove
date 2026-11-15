/**
 * A request's run directory (design section 6): `<runs>/r-<first 16 hex of the digest>/`, holding
 * `request.json` (the WorkPlan) and `run.json` (the run record). Records are named by hex only.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PromptPolicyRecord } from "../policy/text.ts";
import type { WorkPlan } from "./plan.ts";

export const REQUEST_FILE = "request.json";
export const RUN_RECORD_FILE = "run.json";

/** The run id of a digest: `r-` and its first 16 hex digits. */
export function runIdOf(digest: string): string {
  return `r-${digest.slice(0, 16)}`;
}

/** The run directory of a digest under a runs directory. */
export function runDirOf(runsDir: string, digest: string): string {
  return join(runsDir, runIdOf(digest));
}

/** Creates the run directory and writes the WorkPlan to its `request.json`. */
export async function openRunDir(plan: WorkPlan): Promise<string> {
  await mkdir(plan.runDir, { recursive: true });
  await writeFile(join(plan.runDir, REQUEST_FILE), `${JSON.stringify(plan, null, 2)}\n`);
  return plan.runDir;
}

/** The run record the runner writes for a command that writes none of its own. */
export interface CommandRunRecord {
  runId: string;
  runDir: string;
  command: string;
  digest: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  exitCode: number;
  error?: string;
  spentUsd?: number;
  /** The numbered contact sheet in the run directory, when the command wrote one. */
  contactSheet?: string;
  /** The prompt policy's check of the request's prompt text. */
  promptPolicy?: PromptPolicyRecord;
  /** The person's confirmation of the request's spend (design section 7), when it needed one. */
  confirmation?: import("../types.ts").ConfirmationRecord;
}

/** Writes a command's run record to `run.json` in its run directory. */
export async function writeRunRecord(record: CommandRunRecord): Promise<void> {
  await writeFile(join(record.runDir, RUN_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

/** The run id of a run directory: its base name. */
export function runIdOfDir(runDir: string): string {
  return basename(runDir);
}
