import { InputError } from "./errors.ts";
import { currentRunScope, type Journal } from "./runs/journal.ts";
import type { ReserveMeta, SpendLedger } from "./spend.ts";

/**
 * Bounded spend: every provider call reserves against the run's cap first and is refused if it
 * would exceed it. With a spend ledger, the call is also reserved against the cross-run limits
 * (src/spend.ts) and refused when it would cross one.
 */

export class BudgetExceededError extends Error {
  readonly capUsd: number;
  readonly requestedUsd: number;
  constructor(capUsd: number, committedUsd: number, requestedUsd: number, what: string) {
    super(
      `refused: ${what} needs $${requestedUsd.toFixed(4)} but only $${(capUsd - committedUsd).toFixed(4)} of the $${capUsd.toFixed(2)} cap remains`,
    );
    this.name = "BudgetExceededError";
    this.capUsd = capUsd;
    this.requestedUsd = requestedUsd;
  }
}

export interface Reservation {
  readonly amountUsd: number;
  settled: boolean;
  /** The reservation's id in the spend ledger, when the budget has one. */
  readonly ledgerId?: string;
}

export class Budget {
  readonly capUsd: number;
  readonly ledger: SpendLedger | undefined;
  private spent = 0;
  private reserved = 0;

  /**
   * What the run's paid calls the journal does not answer cost in the ledger when this budget was
   * made: failed calls (settled at their estimate) and calls an interrupted attempt never settled.
   */
  readonly unansweredUsd: number;

  constructor(capUsd: number, ledger?: SpendLedger) {
    if (!(capUsd >= 0)) throw new InputError(`invalid cost cap: ${capUsd}`);
    this.capUsd = capUsd;
    this.ledger = ledger;
    const run = currentRunScope();
    // One run, one cap: what the executor's own calls spent before the command (the prompt
    // policy's model check) counts against every budget the command makes in the run, and so
    // does what earlier attempts' calls that never reached the journal were charged.
    this.unansweredUsd =
      ledger !== undefined && run?.journal !== undefined ? unansweredSpend(ledger, run.journal) : 0;
    this.spent = (run?.priorSpentUsd ?? 0) + this.unansweredUsd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get reservedUsd(): number {
    return this.reserved;
  }

  /**
   * The run-level check before any call: throws `BudgetExceededError` when the whole forecast does
   * not fit the cap beside what is spent and reserved, or would cross a ledger limit. Records nothing.
   * Inside a resumed run, the calls its journal already holds are answered without a reservation
   * and are already in the ledger, so the ledger is asked only for the rest of the forecast.
   */
  check(amountUsd: number, what: string): void {
    this.fitCap(amountUsd, what);
    const run = currentRunScope();
    // The executor's own journaled calls are not answered from the journal by this budget's calls.
    const journaled = Math.max(0, (run?.journal?.spentUsd() ?? 0) - (run?.priorSpentUsd ?? 0));
    // A job an earlier attempt reserved is adopted, not reserved again: it is in the ledger already.
    const adopted = (run?.journal?.openJobs() ?? []).reduce((sum, j) => sum + j.reservedUsd, 0);
    this.ledger?.check(Math.max(0, amountUsd - journaled - adopted), what);
  }

  /**
   * Throws `BudgetExceededError` when the amount does not fit beside what is spent and reserved,
   * or would cross a ledger limit. Only a paid call names its `route`, and only a call with a
   * route is reserved in the ledger; a scripted call reserves against the run's cap alone. `meta`
   * names the provider, run and call in the ledger's reservation.
   */
  reserve(amountUsd: number, what = "the call", route?: string, meta?: ReserveMeta): Reservation {
    this.fitCap(amountUsd, what);
    const ledgerId =
      route === undefined ? undefined : this.ledger?.reserve(amountUsd, what, route, meta);
    this.reserved += amountUsd;
    return { amountUsd, settled: false, ...(ledgerId !== undefined && { ledgerId }) };
  }

  /**
   * Takes over the open reservation an earlier attempt of the run made for a job it submitted
   * (src/runs/journal.ts `JobEntry`). Nothing is added to the ledger, and no cap or limit is
   * checked: the money was committed when it was reserved, and collecting the job spends no more.
   */
  adopt(amountUsd: number, ledgerId?: string): Reservation {
    this.reserved += amountUsd;
    return { amountUsd, settled: false, ...(ledgerId !== undefined && { ledgerId }) };
  }

  /**
   * Releases the reservation and records what was actually spent, with the provider's request ID
   * for the call when it gave one.
   */
  settle(reservation: Reservation, actualUsd: number, requestId?: string): void {
    if (reservation.settled) throw new Error("reservation already settled");
    reservation.settled = true;
    this.reserved -= reservation.amountUsd;
    this.spent += actualUsd;
    if (reservation.ledgerId !== undefined)
      this.ledger?.settle(reservation.ledgerId, actualUsd, requestId);
  }

  /** Counts spend made before this run, already in any ledger, against the run's cap. */
  addPrior(amountUsd: number, what: string): void {
    this.fitCap(amountUsd, what);
    this.spent += amountUsd;
  }

  private fitCap(amountUsd: number, what: string): void {
    const committed = this.spent + this.reserved;
    // The epsilon absorbs floating-point sums of cent values.
    if (committed + amountUsd > this.capUsd + 1e-9) {
      throw new BudgetExceededError(this.capUsd, committed, amountUsd, what);
    }
  }
}

/**
 * The ledger's spend for the journal's run beyond what the journal answers: per call key, every
 * reservation's cost less the journaled call's recorded cost. A journal hit counts its own cost
 * when it is answered (`Budget.addPrior`), so only failed and interrupted attempts remain. An open
 * job's reservation is left out too: its call adopts it (`Budget.adopt`) when it is collected.
 */
function unansweredSpend(ledger: SpendLedger, journal: Journal): number {
  const byKey = new Map<string, number>();
  const adopted = new Set(journal.openJobs().map((j) => j.reservationId));
  let total = 0;
  for (const call of ledger.runCalls(journal.runId)) {
    if (adopted.has(call.id)) continue;
    if (call.callKey === undefined) total += call.costUsd;
    else byKey.set(call.callKey, (byKey.get(call.callKey) ?? 0) + call.costUsd);
  }
  for (const [key, cost] of byKey) total += Math.max(0, cost - (journal.recordedCostUsd(key) ?? 0));
  return total;
}

/** A `--cap` above the settings' run cap: refused before any spend. Exit 3 `cap_refused`. */
export class CapRefusedError extends BudgetExceededError {
  readonly code = "cap_refused";
  constructor(capUsd: number, ceilingUsd: number) {
    super(ceilingUsd, 0, capUsd, "the run");
    this.name = "CapRefusedError";
    this.message = `refused: --cap $${capUsd.toFixed(2)} is above the $${ceilingUsd.toFixed(2)} run cap in the developer settings (caps.runUsd); only a person raises a cap`;
  }
}

/**
 * The run's cap: `--cap` when given, which may lower the settings' `caps.runUsd` but never raise
 * it (`CapRefusedError`); else the settings' cap, or a command's own lower default.
 */
export function runCap(
  cap: number | undefined,
  settings: { caps: { runUsd: number } },
  commandDefault?: number,
): number {
  const ceiling = settings.caps.runUsd;
  if (cap === undefined) return Math.min(ceiling, commandDefault ?? ceiling);
  if (!(typeof cap === "number" && Number.isFinite(cap) && cap >= 0))
    throw new InputError(`invalid cost cap: ${cap}`);
  if (cap > ceiling + 1e-9) throw new CapRefusedError(cap, ceiling);
  return cap;
}
