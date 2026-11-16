/**
 * Reconcile of earlier real-check runs (the Phase 1 gate's reconcile evidence). The gateway
 * reports a call's cost some time after the call, so the call a run has just made is always
 * pending. The real-check ledger directory is kept between runs, so a run instead compares the
 * gateway entries earlier runs left in `<ledger dir>/spend.jsonl` with the cost the gateway now
 * reports for each, looked up by the request ID the entry's settlement records. Whether an entry
 * is old enough is the gateway's own answer for it: no cost yet means pending. Nothing is waited
 * for, written or spent.
 */
import { AssertionError } from "node:assert";
import type { Billing } from "../../src/gateway/provider.ts";
import { marginFor } from "../../src/reconcile.ts";
import type { Settings } from "../../src/settings.ts";
import type { SpendLedger } from "../../src/spend.ts";
import { WORK_ITEM } from "./budget.ts";

const EPSILON = 1e-9;

export type EarlierStatus = "agreed" | "mismatched" | "pending" | "not-comparable";

/** One earlier run's ledger entry, as the gateway reports it now. */
export interface EarlierEntry {
  /** The reservation's ledger id. */
  id: string;
  /** When it was reserved. */
  at: string;
  route: string;
  /** What the ledger counts for the call: its settled cost, else its estimate. */
  ledgerUsd: number;
  requestId?: string;
  status: EarlierStatus;
  providerUsd?: number;
  gapUsd?: number;
  marginUsd?: number;
  /** Why an entry is pending or not comparable. */
  note?: string;
}

export interface EarlierReconcile {
  provider: string;
  ledger: string;
  entries: EarlierEntry[];
  /** Entries whose amounts were compared with the gateway's reported cost: agreed and mismatched. */
  compared: number;
  agreed: number;
  pending: number;
  mismatched: number;
  /** Entries with no gateway request ID to look up, or one the gateway cannot look up. */
  notComparable: number;
}

/**
 * Compares each entry of `provider` under the work item `real-checks` reserved before `before`
 * (this run's start) with the cost `billing.callCost` reports for its request ID, within the
 * settings' reconcile margin (`marginFor`, src/reconcile.ts).
 */
export async function reconcileEarlier(
  budget: { ledger: SpendLedger; settings: Pick<Settings, "reconcile"> },
  billing: Pick<Billing, "callCost">,
  options: { provider: string; before: Date },
): Promise<EarlierReconcile> {
  const cutoff = options.before.getTime();
  const earlier = budget.ledger.entries().filter(
    (e) =>
      e.provider === options.provider &&
      e.workItem === WORK_ITEM &&
      Date.parse(e.at) < cutoff &&
      // A reservation refused by a limit was cancelled at 0 before any call.
      !(e.costUsd === 0 && e.requestId === undefined),
  );
  const entries: EarlierEntry[] = [];
  for (const e of earlier) {
    const base = {
      id: e.id,
      at: e.at,
      route: e.route,
      ledgerUsd: e.costUsd ?? e.amountUsd,
      ...(e.requestId !== undefined && { requestId: e.requestId }),
    };
    if (e.requestId === undefined) {
      entries.push({
        ...base,
        status: "not-comparable",
        note:
          e.costUsd === undefined
            ? "never settled: the call was interrupted"
            : "no gateway request ID recorded (a failed call, or an entry from before IDs were recorded)",
      });
      continue;
    }
    if (billing.callCost === undefined) {
      entries.push({
        ...base,
        status: "not-comparable",
        note: "the provider gives no per-call cost",
      });
      continue;
    }
    let reported: number | null | undefined;
    try {
      reported = await billing.callCost(e.requestId);
    } catch (error) {
      entries.push({
        ...base,
        status: "pending",
        note: `lookup failed: ${(error as Error).message}`,
      });
      continue;
    }
    if (reported === null) {
      entries.push({
        ...base,
        status: "not-comparable",
        note: "the gateway cannot look this ID up",
      });
      continue;
    }
    if (reported === undefined) {
      entries.push({
        ...base,
        status: "pending",
        note: "the gateway has not reported its cost yet",
      });
      continue;
    }
    const gapUsd = Math.abs(reported - base.ledgerUsd);
    const marginUsd = marginFor(budget.settings, base.ledgerUsd);
    entries.push({
      ...base,
      status: gapUsd <= marginUsd + EPSILON ? "agreed" : "mismatched",
      providerUsd: reported,
      gapUsd,
      marginUsd,
    });
  }
  const count = (status: EarlierStatus) => entries.filter((e) => e.status === status).length;
  const agreed = count("agreed");
  const pending = count("pending");
  const mismatched = count("mismatched");
  return {
    provider: options.provider,
    ledger: budget.ledger.path,
    entries,
    compared: agreed + mismatched,
    agreed,
    pending,
    mismatched,
    notComparable: count("not-comparable"),
  };
}

const usd = (n: number | undefined) => `$${(n ?? 0).toFixed(4)}`;

/** How one mismatched entry reads: its ledger id, call, request ID and both amounts. */
export function mismatchLine(e: EarlierEntry): string {
  return (
    `mismatch: ledger entry ${e.id} (${e.route}, ${e.at}, request ${e.requestId}): ` +
    `ledger ${usd(e.ledgerUsd)} vs gateway ${usd(e.providerUsd)}, gap ${usd(e.gapUsd)} above margin ${usd(e.marginUsd)}`
  );
}

/** The summary a person reads as the gate's evidence, then one line per mismatch and pending entry. */
export function reconcileLines(r: EarlierReconcile): string[] {
  const extra = r.notComparable > 0 ? `; ${r.notComparable} more not comparable` : "";
  return [
    `reconcile (earlier runs, ${r.provider}): ${r.compared} ledger entries compared with the gateway's usage, ` +
      `${r.agreed} agreed, ${r.pending} pending, ${r.mismatched} mismatched${extra}`,
    ...r.entries.filter((e) => e.status === "mismatched").map(mismatchLine),
    ...r.entries
      .filter((e) => e.status === "pending")
      .map((e) => `pending: ledger entry ${e.id} (${e.route}, ${e.at}): ${e.note}`),
  ];
}

/**
 * Why the check cannot show a reconcile, else undefined: no earlier entries (a first run on an
 * empty cache), or none the gateway has reported a cost for yet.
 */
export function skipReasonOf(r: EarlierReconcile): string | undefined {
  if (r.entries.length === 0)
    return `no earlier runs' ${r.provider} entries in the ledger ${r.ledger} (a first run on an empty cache): nothing to reconcile`;
  if (r.agreed + r.mismatched === 0)
    return (
      `none of the ${r.entries.length} earlier ${r.provider} ledger entries has a reported cost to compare yet: ` +
      `${r.pending} pending, ${r.notComparable} not comparable`
    );
  return undefined;
}

/** Throws naming each mismatched entry, with its amounts. */
export function assertAgreed(r: EarlierReconcile): void {
  const lines = r.entries.filter((e) => e.status === "mismatched").map(mismatchLine);
  if (lines.length > 0)
    throw new AssertionError({
      message: `${lines.length} earlier ledger entr${lines.length === 1 ? "y does" : "ies do"} not agree with the gateway:\n${lines.join("\n")}`,
    });
}
