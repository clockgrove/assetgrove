/**
 * A run's call journal (design section 9): `calls/<callKey>.json` for every provider call the run
 * has had answered, with the result's media beside it as `calls/<sha256>.bin`. The `Caller`
 * checks the journal before it reserves anything; a hit reserves nothing and returns the stored
 * result, so repeating a request never pays twice for a finished call.
 *
 * The journal reaches every `Caller` through the run scope the executor opens around a paid
 * command's run (`AsyncLocalStorage`), so no command threads it through by hand.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CallRecord } from "../types.ts";
import { canonicalJson } from "./plan.ts";

export const CALLS_DIR = "calls";

/** What a callKey covers (design section 9). */
export interface CallKeyInput {
  operation: string;
  provider: string;
  model: string;
  prompt: string;
  referenceHashes: readonly string[];
  seed?: number;
  /** The candidate or frame index, where the command gives one. */
  index?: number;
}

/** One journaled call: its key, the record the `Caller` kept and the provider's result. */
export interface JournalEntry {
  callKey: string;
  operation: string;
  provider: string;
  model: string;
  record: CallRecord;
  /** The provider result, each byte array replaced by `{ "$media": "<sha256>" }`. */
  result: unknown;
}

/** What a run tells its progress sink as calls are answered. */
export interface CallProgress {
  operation: string;
  /** True when the journal answered the call; nothing was reserved or paid. */
  reused: boolean;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** sha256 hex of the canonical JSON of the call's operation, provider, model, prompt, references, seed and index. */
export function callKey(input: CallKeyInput & { occurrence?: number }): string {
  return sha256Hex(
    canonicalJson({
      operation: input.operation,
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      referenceHashes: input.referenceHashes,
      seed: input.seed,
      index: input.index,
      occurrence: input.occurrence,
    }),
  );
}

/** Writes a file whole or not at all: a temporary file renamed over the name. */
function writeAtomic(path: string, data: string | Uint8Array): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

/** A run directory's call journal. */
export class Journal {
  readonly dir: string;
  /** The run id the ledger's reservations name. */
  readonly runId: string;
  private readonly occurrences = new Map<string, number>();

  constructor(runDir: string, runId: string) {
    this.dir = join(runDir, CALLS_DIR);
    this.runId = runId;
  }

  /**
   * The key of a call: identical calls in one run (a seedless route, the same prompt twice) are
   * told apart by how many came before them, so each keeps its own record.
   */
  key(input: CallKeyInput): string {
    const base = callKey(input);
    const occurrence = this.occurrences.get(base) ?? 0;
    this.occurrences.set(base, occurrence + 1);
    return occurrence === 0 ? base : callKey({ ...input, occurrence });
  }

  /** The stored call of a key, with its media restored; undefined when the run has none. */
  read(key: string): JournalEntry | undefined {
    const path = join(this.dir, `${key}.json`);
    if (!existsSync(path)) return undefined;
    let entry: JournalEntry;
    try {
      entry = JSON.parse(readFileSync(path, "utf8")) as JournalEntry;
    } catch {
      return undefined; // An unreadable record is a missing call: it is made again.
    }
    try {
      return { ...entry, result: this.restore(entry.result) };
    } catch {
      return undefined;
    }
  }

  /** Stores an answered call; its media first, so a record never names missing media. */
  write(entry: JournalEntry): void {
    mkdirSync(this.dir, { recursive: true });
    const result = this.store(entry.result);
    writeAtomic(
      join(this.dir, `${entry.callKey}.json`),
      `${JSON.stringify({ ...entry, result }, null, 2)}\n`,
    );
  }

  /**
   * What the journaled calls cost, as their records settled it: spend a resume answers from the
   * journal and never pays again.
   */
  spentUsd(): number {
    let total = 0;
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
    } catch {
      return 0;
    }
    for (const name of names) {
      try {
        const entry = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as JournalEntry;
        const cost = entry.record?.costUsd;
        if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) total += cost;
      } catch {
        // An unreadable record is a missing call: it is made, and paid for, again.
      }
    }
    return total;
  }

  /** How many calls the journal holds. */
  count(): number {
    return journalCount(this.dir);
  }

  private store(value: unknown): unknown {
    if (value instanceof Uint8Array) {
      const hash = sha256Hex(value);
      const path = join(this.dir, `${hash}.bin`);
      if (!existsSync(path)) writeAtomic(path, value);
      return { $media: hash };
    }
    if (Array.isArray(value)) return value.map((v) => this.store(v));
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.store(v)]));
    return value;
  }

  private restore(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.restore(v));
    if (value !== null && typeof value === "object") {
      const media = (value as Record<string, unknown>)["$media"];
      if (typeof media === "string" && /^[0-9a-f]{64}$/.test(media))
        return new Uint8Array(readFileSync(join(this.dir, `${media}.bin`)));
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.restore(v)]));
    }
    return value;
  }
}

/** How many call records a `calls` directory holds. */
export function journalCount(callsDir: string): number {
  try {
    return readdirSync(callsDir).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).length;
  } catch {
    return 0;
  }
}

/**
 * A run's clearance to spend (design section 7): built in memory by the executor
 * (src/runs/execute.ts) from the confirmation it verified for the run's digest, or from headless
 * settings, and nowhere else. `Caller` refuses a paid call without one.
 */
export interface Clearance {
  digest: string;
  record: import("../types.ts").ConfirmationRecord;
}

/** The run a paid command is executing: its journal and where answered calls are reported. */
export interface RunScope {
  journal: Journal;
  onCall?: (progress: CallProgress) => void;
  /** The run's clearance to spend; absent when the request needed no confirmation. */
  clearance?: Clearance;
}

const scope = new AsyncLocalStorage<RunScope>();

/** Runs `body` inside a run scope: every `Caller` made in it journals its calls there. */
export function withRunScope<T>(run: RunScope, body: () => Promise<T>): Promise<T> {
  return scope.run(run, body);
}

/** The run scope of the current call, when a paid command's executor opened one. */
export function currentRunScope(): RunScope | undefined {
  return scope.getStore();
}
