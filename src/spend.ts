import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BudgetExceededError } from "./budget.ts";
import type { Env } from "./env.ts";
import { InputError } from "./errors.ts";
import type { GenerationProvider } from "./gateway/provider.ts";
import { assertLimitsDeclared, isPaid } from "./limits.ts";
import type { Settings } from "./settings.ts";
import type { TargetProfile } from "./types.ts";

/**
 * Provider spend across runs (design section 3). A run's `Budget` caps that run alone; this ledger
 * caps what every run of this developer spends together: a daily cap over the last 24 hours, and a
 * cap per work item (an Objective, a campaign or a session label). Both caps come from the
 * developer settings (`caps.dailyUsd`, `caps.workItemUsd`), lowered only by a target profile's
 * `spend` limits; the ledger is `<stateDir>/spend.jsonl`.
 *
 * The ledger is an append-only JSON Lines file. Every paid call appends a reservation of its
 * estimate before it is made and a settlement with its actual cost after. A reservation is checked
 * against the entries before it in the file, so concurrent runs are ordered by their appends and
 * can never both fit into the same remaining spend; a reservation that does not fit is cancelled
 * (settled at 0) and the call is refused. A reservation never settled (a crashed run) keeps its
 * estimate, as a failed call does in `Budget`. Whether a call is paid is its provider's billing,
 * decided by the adapter (src/providers/adapter.ts); free calls are never recorded.
 */

/** The variable naming the work item when `--work-item` does not. No other spend variable is read. */
export const WORK_ITEM_ENV = "ASSETGROVE_WORK_ITEM";

/** The ledger file under the settings' state directory. */
export const LEDGER_FILE = "spend.jsonl";

/**
 * The ledger a run with this provider reserves against, with the profile's limits: none for a
 * free provider, whose runs keep only their own cap. A paid provider must declare its limit
 * first (`provider_limit_undeclared`, exit 3), before anything is reserved.
 */
export function ledgerFor(
  ledger: SpendLedger | undefined,
  provider: GenerationProvider | undefined,
  profile?: Pick<TargetProfile, "spend">,
): SpendLedger | undefined {
  if (!isPaid(provider)) return undefined;
  assertLimitsDeclared(provider);
  return ledger?.forProfile(profile);
}
const DAY_MS = 24 * 60 * 60 * 1000;
const EPSILON = 1e-9;

export type SpendLimitName = "daily" | "work-item";
export type LimitSource = "settings" | "profile";

export interface SpendLimitStatus {
  limit: SpendLimitName;
  /** The work item the limit counts, for the work-item limit. */
  workItem?: string;
  limitUsd: number;
  source: LimitSource;
  spentUsd: number;
  remainingUsd: number;
}

export interface SpendStatus {
  ledger: string;
  /** Null when no work item is named: only the daily limit applies then. */
  workItem: string | null;
  limits: SpendLimitStatus[];
}

/** A call or run refused because it would cross a cross-run limit. Exit 3, like the run's cap. */
export class SpendLimitError extends BudgetExceededError {
  readonly limit: SpendLimitName;
  readonly workItem: string | undefined;
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly ledger: string;
  constructor(status: SpendLimitStatus, requestedUsd: number, what: string, ledger: string) {
    super(status.limitUsd, status.spentUsd, requestedUsd, what);
    this.name = "SpendLimitError";
    this.limit = status.limit;
    this.workItem = status.workItem;
    this.limitUsd = status.limitUsd;
    this.spentUsd = status.spentUsd;
    this.ledger = ledger;
    this.message =
      `refused: ${what} needs $${requestedUsd.toFixed(4)} but the ${limitLabel(status)} has ` +
      `$${status.spentUsd.toFixed(4)} spent and $${status.remainingUsd.toFixed(4)} left ` +
      `(spend ledger ${ledger})`;
  }
}

export function limitLabel(status: SpendLimitStatus): string {
  return status.limit === "daily"
    ? `$${status.limitUsd.toFixed(2)} daily limit (last 24 hours)`
    : `$${status.limitUsd.toFixed(2)} work-item limit for "${status.workItem}"`;
}

type Entry =
  | {
      op: "reserve";
      id: string;
      at: string;
      provider?: string;
      route: string;
      workItem?: string;
      amountUsd: number;
    }
  | { op: "settle"; id: string; at: string; costUsd: number };

/** A limit as each source sets it: the settings cap, lowered only by a lower profile limit. */
interface LimitSetting {
  settings: number;
  profile?: number;
}

interface LedgerOptions {
  path: string;
  workItem?: string;
  daily: LimitSetting;
  workItemLimit: LimitSetting;
  now?: () => Date;
}

export class SpendLedger {
  readonly path: string;
  readonly workItem: string | undefined;
  private readonly options: LedgerOptions;
  private readonly now: () => Date;

  constructor(options: LedgerOptions) {
    this.options = options;
    this.path = options.path;
    this.workItem = options.workItem;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The ledger and caps from the developer settings: `<stateDir>/spend.jsonl`, `caps.dailyUsd` and
   * `caps.workItemUsd`. The work item is `workItem` (from `--work-item`), else
   * `ASSETGROVE_WORK_ITEM`, else none.
   */
  static fromSettings(
    settings: Pick<Settings, "stateDir" | "caps">,
    options: { workItem?: string; env?: Env; now?: () => Date } = {},
  ): SpendLedger {
    const env = options.env ?? process.env;
    const workItem = (options.workItem ?? env[WORK_ITEM_ENV])?.trim() || undefined;
    return new SpendLedger({
      path: join(settings.stateDir, LEDGER_FILE),
      ...(workItem !== undefined && { workItem }),
      daily: { settings: settings.caps.dailyUsd },
      workItemLimit: { settings: settings.caps.workItemUsd },
      ...(options.now !== undefined && { now: options.now }),
    });
  }

  /** This ledger with the target profile's `spend` limits added; the stricter of each pair wins. */
  forProfile(profile: Pick<TargetProfile, "spend"> | undefined): SpendLedger {
    const spend = profile?.spend;
    if (spend === undefined) return this;
    if (typeof spend !== "object" || spend === null || Array.isArray(spend))
      throw new InputError("profile spend must be an object");
    const daily = profileLimit(spend.dailyLimitUsd, "spend.dailyLimitUsd");
    const item = profileLimit(spend.workItemLimitUsd, "spend.workItemLimitUsd");
    return new SpendLedger({
      ...this.options,
      daily: withProfile(this.options.daily, daily),
      workItemLimit: withProfile(this.options.workItemLimit, item),
    });
  }

  /** Spend against each limit that applies, from the ledger as it is now. */
  status(): SpendStatus {
    const entries = this.read();
    return {
      ledger: this.path,
      workItem: this.workItem ?? null,
      limits: this.limits(entries, entries.length),
    };
  }

  /** Throws `SpendLimitError` when `amountUsd` more would cross a limit. Records nothing. */
  check(amountUsd: number, what: string): void {
    const entries = this.read();
    this.assertFits(this.limits(entries, entries.length), amountUsd, what);
  }

  /**
   * Records a reservation of `amountUsd` for a call on `route`, or throws `SpendLimitError` (with
   * the reservation cancelled) when it does not fit beside the reservations recorded before it.
   * Returns the reservation's ledger id, for `settle`.
   */
  reserve(amountUsd: number, what: string, route: string, provider?: string): string {
    const id = randomUUID();
    this.append({
      op: "reserve",
      id,
      at: this.now().toISOString(),
      ...(provider !== undefined && { provider }),
      route,
      ...(this.workItem !== undefined && { workItem: this.workItem }),
      amountUsd,
    });
    const entries = this.read();
    const index = entries.findIndex((e) => e.op === "reserve" && e.id === id);
    try {
      if (index < 0) throw new Error(`spend ledger ${this.path} lost a reservation`);
      this.assertFits(this.limits(entries, index), amountUsd, what);
    } catch (error) {
      this.settle(id, 0);
      throw error;
    }
    return id;
  }

  /** Records what a reserved call actually cost. */
  settle(id: string, costUsd: number): void {
    this.append({ op: "settle", id, at: this.now().toISOString(), costUsd });
  }

  private assertFits(limits: SpendLimitStatus[], amountUsd: number, what: string): void {
    // Nothing to spend is never refused, even when actual costs have run past a limit.
    if (amountUsd <= 0) return;
    for (const limit of limits) {
      if (limit.spentUsd + amountUsd > limit.limitUsd + EPSILON)
        throw new SpendLimitError(limit, amountUsd, what, this.path);
    }
  }

  /** Each applicable limit, counting the reservations among the first `before` entries. */
  private limits(entries: Entry[], before: number): SpendLimitStatus[] {
    const settled = new Map<string, number>();
    for (const e of entries) if (e.op === "settle") settled.set(e.id, e.costUsd);
    const since = this.now().getTime() - DAY_MS;
    let daily = 0;
    let item = 0;
    for (const e of entries.slice(0, before)) {
      if (e.op !== "reserve") continue;
      const cost = settled.get(e.id) ?? e.amountUsd;
      if (Date.parse(e.at) > since) daily += cost;
      if (this.workItem !== undefined && e.workItem === this.workItem) item += cost;
    }
    const status = (
      limit: SpendLimitName,
      setting: LimitSetting,
      spentUsd: number,
    ): SpendLimitStatus => {
      const { usd, source } = effective(setting);
      return {
        limit,
        ...(limit === "work-item" && { workItem: this.workItem }),
        limitUsd: usd,
        source,
        spentUsd,
        remainingUsd: Math.max(0, usd - spentUsd),
      };
    };
    return [
      status("daily", this.options.daily, daily),
      ...(this.workItem !== undefined
        ? [status("work-item", this.options.workItemLimit, item)]
        : []),
    ];
  }

  private read(): Entry[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new InputError(`cannot read spend ledger ${this.path}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    const entries: Entry[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue; // A line torn by a crash mid-write records nothing usable.
      }
      if (isEntry(value)) entries.push(value);
    }
    return entries;
  }

  /** One `appendFileSync` is one O_APPEND write, so concurrent appends never interleave. */
  private append(entry: Entry): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (error) {
      throw new InputError(`cannot write spend ledger ${this.path}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e["id"] !== "string" || typeof e["at"] !== "string") return false;
  if (e["op"] === "reserve")
    return (
      typeof e["route"] === "string" &&
      typeof e["amountUsd"] === "number" &&
      Number.isFinite(e["amountUsd"]) &&
      (e["workItem"] === undefined || typeof e["workItem"] === "string") &&
      (e["provider"] === undefined || typeof e["provider"] === "string")
    );
  return e["op"] === "settle" && typeof e["costUsd"] === "number" && Number.isFinite(e["costUsd"]);
}

function effective(setting: LimitSetting): { usd: number; source: LimitSource } {
  if (setting.profile !== undefined && setting.profile < setting.settings)
    return { usd: setting.profile, source: "profile" };
  return { usd: setting.settings, source: "settings" };
}

function withProfile(setting: LimitSetting, value: number | undefined): LimitSetting {
  if (value === undefined) return setting;
  const profile = setting.profile === undefined ? value : Math.min(setting.profile, value);
  return { ...setting, profile };
}

function profileLimit(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new InputError(`profile ${field} must be a non-negative number of USD`);
  return value;
}
