import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BudgetExceededError } from "./budget.ts";
import { WORK_ITEM_ENV, workItemEnv, type Env } from "./env.ts";
import { InputError } from "./errors.ts";
import type { GenerationProvider } from "./gateway/provider.ts";
import { assertLimitsDeclared, billingParts } from "./limits.ts";
import type { Settings } from "./settings.ts";
import type { TargetProfile } from "./types.ts";

/**
 * Provider spend across runs. A run's `Budget` caps that run alone; this ledger caps what every
 * run with the same developer settings spends together: a daily cap over the last 24 hours, and a
 * cap per work item (an Objective, a campaign or a session label). Both come from the settings'
 * `caps`; a target profile's `spend` may lower them, never raise them.
 *
 * The ledger is an append-only JSON Lines file, `<stateDir>/spend.jsonl`. Every paid call appends
 * a reservation of its estimate before it is made and a settlement with its actual cost after. A
 * reservation is checked against the entries before it in the file, so concurrent runs are
 * ordered by their appends and can never both fit into the same remaining spend; a reservation
 * that does not fit is cancelled (settled at 0) and the call is refused. A reservation never
 * settled (a killed run) keeps its estimate for good, as a failed call does in `Budget`: the
 * provider may have billed it. A retry of that call is another provider call, so it makes its
 * own reservation, dated now and checked against the limits as they are now; no reservation is
 * ever reused, so every call that reached a provider is counted once. Whether a call is
 * paid is its provider's billing (src/providers/adapter.ts); free calls are never recorded.
 */

export { WORK_ITEM_ENV };

/**
 * The ledger a run with this provider reserves against, with the profile's caps: none when no
 * part of the provider is paid. A single paid provider with no declared limit is refused here,
 * before any spend (`provider_limit_undeclared`). A provider set (src/providers/set.ts) is not
 * checked as a whole: the routes of the settings may name providers this command never calls, so
 * the `Caller` refuses each call whose own provider declares no limit, before its reservation.
 * With no provider yet (a plan made without a key), the ledger still bounds the forecast, as an
 * unknown provider counts as paid.
 */
export function ledgerFor(
  ledger: SpendLedger | undefined,
  provider: GenerationProvider | undefined,
  profile?: Pick<TargetProfile, "spend">,
): SpendLedger | undefined {
  if (provider === undefined) return ledger?.forProfile(profile);
  if (!billingParts(provider).some((b) => b.paid)) return undefined;
  const isSet = (provider as { parts?: unknown }).parts !== undefined;
  if (!isSet) assertLimitsDeclared(provider);
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
  /** The caps from the settings, before a profile lowers them. */
  caps: { runUsd: number; dailyUsd: number; workItemUsd: number };
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
  | ({
      op: "reserve";
      id: string;
      at: string;
      route: string;
      workItem?: string;
      amountUsd: number;
    } & ReserveMeta)
  | { op: "settle"; id: string; at: string; costUsd: number; requestId?: string };

/** What a reservation names beside its route: the provider, the run and the call (design section 3). */
export interface ReserveMeta {
  /** The settings id of the provider that serves the call. */
  provider?: string;
  /** The run (`r-<16 hex>`) the call belongs to. */
  runId?: string;
  /** The call's journal key (src/runs/journal.ts). */
  callKey?: string;
}

/** One paid call of a run as the ledger counts it. */
export interface LedgerCall {
  /** The reservation's ledger id. */
  id: string;
  provider: string;
  callKey?: string;
  /** The settled cost, or the reservation's estimate while unsettled. */
  costUsd: number;
}

/** One reservation of the ledger with its settlement, as `entries()` lists it. */
export interface LedgerEntry {
  /** The reservation's ledger id. */
  id: string;
  /** When the reservation was made. */
  at: string;
  route: string;
  provider?: string;
  runId?: string;
  callKey?: string;
  workItem?: string;
  /** The reserved estimate. */
  amountUsd: number;
  /** The settled cost, absent while unsettled. */
  costUsd?: number;
  /** When it was settled. */
  settledAt?: string;
  /** The provider's own request ID for the call, when the settlement records one. */
  requestId?: string;
}

/** A cap as the settings set it, and the profile's lower value when it has one. */
interface LimitSetting {
  settings: number;
  profile?: number;
}

interface LedgerOptions {
  path: string;
  workItem?: string;
  caps: { runUsd: number; dailyUsd: number; workItemUsd: number };
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
   * The ledger of these settings, `<stateDir>/spend.jsonl`, with their daily and work-item caps.
   * The work item is `workItem` (from `--work-item`), else `ASSETGROVE_WORK_ITEM`.
   */
  static fromSettings(
    settings: Pick<Settings, "stateDir" | "caps">,
    options: { workItem?: string; env?: Env; now?: () => Date } = {},
  ): SpendLedger {
    const workItem = (options.workItem ?? workItemEnv(options.env))?.trim() || undefined;
    return new SpendLedger({
      path: join(settings.stateDir, "spend.jsonl"),
      ...(workItem !== undefined && { workItem }),
      caps: { ...settings.caps },
      daily: { settings: settings.caps.dailyUsd },
      workItemLimit: { settings: settings.caps.workItemUsd },
      ...(options.now !== undefined && { now: options.now }),
    });
  }

  /** This ledger with the target profile's `spend` limits: each lowers its cap, never raises it. */
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
      caps: { ...this.options.caps },
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
  reserve(amountUsd: number, what: string, route: string, meta: ReserveMeta = {}): string {
    const id = randomUUID();
    this.append({
      op: "reserve",
      id,
      at: this.now().toISOString(),
      route,
      ...(meta.provider !== undefined && { provider: meta.provider }),
      ...(meta.runId !== undefined && { runId: meta.runId }),
      ...(meta.callKey !== undefined && { callKey: meta.callKey }),
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

  /**
   * The paid calls of one run, every attempt's, each with what the ledger counts for it: its settled cost, or its estimate while unsettled. Spends nothing.
   */
  runCalls(runId: string): LedgerCall[] {
    const entries = this.read();
    const settled = new Map<string, number>();
    for (const e of entries) if (e.op === "settle") settled.set(e.id, e.costUsd);
    const calls: LedgerCall[] = [];
    for (const e of entries) {
      if (e.op !== "reserve" || e.runId !== runId) continue;
      calls.push({
        id: e.id,
        provider: e.provider ?? "",
        ...(e.callKey !== undefined && { callKey: e.callKey }),
        costUsd: settled.get(e.id) ?? e.amountUsd,
      });
    }
    return calls;
  }

  /**
   * Every reservation in the ledger, in order, each with its settlement (the last one, when a
   * reservation was settled more than once). Spends nothing.
   */
  entries(): LedgerEntry[] {
    const entries = this.read();
    const settles = new Map<string, Extract<Entry, { op: "settle" }>>();
    for (const e of entries) if (e.op === "settle") settles.set(e.id, e);
    const out: LedgerEntry[] = [];
    for (const e of entries) {
      if (e.op !== "reserve") continue;
      const settle = settles.get(e.id);
      out.push({
        id: e.id,
        at: e.at,
        route: e.route,
        ...(e.provider !== undefined && { provider: e.provider }),
        ...(e.runId !== undefined && { runId: e.runId }),
        ...(e.callKey !== undefined && { callKey: e.callKey }),
        ...(e.workItem !== undefined && { workItem: e.workItem }),
        amountUsd: e.amountUsd,
        ...(settle !== undefined && { costUsd: settle.costUsd, settledAt: settle.at }),
        ...(typeof settle?.requestId === "string" && { requestId: settle.requestId }),
      });
    }
    return out;
  }

  /**
   * Records what a reserved call actually cost, and the provider's own request ID for the call
   * when it gave one (reconcile looks the call up by it).
   */
  settle(id: string, costUsd: number, requestId?: string): void {
    this.append({
      op: "settle",
      id,
      at: this.now().toISOString(),
      costUsd,
      ...(requestId !== undefined && { requestId }),
    });
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
      ["provider", "runId", "callKey"].every((k) => e[k] === undefined || typeof e[k] === "string")
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

/**
 * A spend hold (design section 3): reconciling a run found the provider's own usage further from
 * the ledger than the margin. Holds are appended to `<stateDir>/holds.jsonl`; every paid run is
 * refused (exit 3 `spend_hold`) while one is not listed in the settings' `spend.acknowledgedHolds`.
 */
export interface Hold {
  /** 16 hex digits; a person lists it in `spend.acknowledgedHolds` to clear the hold. */
  id: string;
  at: string;
  provider: string;
  runId: string;
  ledgerUsd: number;
  providerUsd: number;
  gapUsd: number;
}

export const HOLDS_FILE = "holds.jsonl";

/** `<stateDir>/holds.jsonl`. */
export function holdsPath(stateDir: string): string {
  return join(stateDir, HOLDS_FILE);
}

/** Every hold recorded under a state directory, oldest first. */
export function readHolds(stateDir: string): Hold[] {
  const holds: Hold[] = [];
  for (const value of readJsonLines(holdsPath(stateDir), "spend holds")) {
    const h = value as Record<string, unknown>;
    if (
      typeof h["id"] === "string" &&
      typeof h["at"] === "string" &&
      typeof h["provider"] === "string" &&
      typeof h["runId"] === "string" &&
      ["ledgerUsd", "providerUsd", "gapUsd"].every((k) => typeof h[k] === "number")
    )
      holds.push(value as Hold);
  }
  return holds;
}

/** Appends a hold with a new id and returns it. */
export function appendHold(
  stateDir: string,
  hold: Omit<Hold, "id" | "at">,
  now: Date = new Date(),
): Hold {
  const recorded: Hold = { id: randomBytes(8).toString("hex"), at: now.toISOString(), ...hold };
  appendJsonLine(holdsPath(stateDir), recorded, "spend holds");
  return recorded;
}

/** The holds the settings do not acknowledge. */
export function openHolds(settings: Pick<Settings, "stateDir" | "spend">): Hold[] {
  const acknowledged = new Set(settings.spend.acknowledgedHolds.map((id) => id.toLowerCase()));
  return readHolds(settings.stateDir).filter((h) => !acknowledged.has(h.id.toLowerCase()));
}

/** A paid run refused while a hold is not acknowledged. Exit 3 `spend_hold`. */
export class SpendHoldError extends Error {
  readonly code = "spend_hold";
  readonly holds: Hold[];
  constructor(holds: Hold[]) {
    const ids = holds.map((h) => h.id).join(", ");
    super(
      `refused: spend hold ${ids}: the provider's own usage differs from the spend ledger by more than the reconcile margin; after a person has looked, list the id in the developer settings' spend.acknowledgedHolds`,
    );
    this.name = "SpendHoldError";
    this.holds = holds;
  }
}

/** Throws `SpendHoldError` while a hold is not acknowledged. */
export function assertNoOpenHold(settings: Pick<Settings, "stateDir" | "spend">): void {
  const holds = openHolds(settings);
  if (holds.length > 0) throw new SpendHoldError(holds);
}

/** The JSON values of a JSON Lines file; none when it is missing. A torn line is skipped. */
export function readJsonLines(path: string, what: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new InputError(`cannot read ${what} ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null) values.push(value);
    } catch {
      // A line torn by a crash mid-write records nothing usable.
    }
  }
  return values;
}

/** Appends one JSON line in one O_APPEND write. */
export function appendJsonLine(path: string, value: unknown, what: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch (error) {
    throw new InputError(`cannot write ${what} ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}
