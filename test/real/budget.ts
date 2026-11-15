/**
 * The one budget every real check runs under (design section 20). Real checks cost money, so each
 * runs through the product's own spend controls: this module writes temporary developer settings
 * whose `stateDir` is a persistent ledger directory, whose caps hold this leg's share of the fixed
 * 25 USD total, whose run cap is 1.50 USD and whose paid providers declare their limits. Every call
 * reserves against `<ledger dir>/spend.jsonl` under the work item `real-checks`, so spend
 * accumulates across runs, and a forecast above the budget left is refused before any call.
 *
 * One `pnpm test:real` invocation is one run: it runs every check in one process
 * (`--test-isolation=none`), and the 1.50 USD run cap bounds what all of them spend together, read
 * from the ledger's spend since the invocation's first `realBudget()` on that ledger directory.
 *
 * Leg: `ci` when `CI` is set (15 USD), else `local` (8 USD); 2 USD stays in reserve. Ledger
 * directory: `ASSETGROVE_REAL_LEDGER` (a CI cache entry), else `<state home>/assetgrove/real-checks/<leg>`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget } from "../../src/budget.ts";
import { Caller } from "../../src/calls.ts";
import { stateHome, type Env } from "../../src/env.ts";
import type { Script } from "../../src/gateway/scripted.ts";
import { providerOfAdapter, type ConfiguredProvider } from "../../src/providers/adapter.ts";
import { defaultRoutes, type Routes } from "../../src/routes.ts";
import { loadSettings, type ProviderSettings, type Settings } from "../../src/settings.ts";
import { ledgerFor, SpendLedger } from "../../src/spend.ts";

export const TOTAL_USD = 25;
export const SHARES = { ci: 15, local: 8, reserve: 2 } as const;
export const RUN_USD = 1.5;
export const WORK_ITEM = "real-checks";
export const LEDGER_ENV = "ASSETGROVE_REAL_LEDGER";

export type Leg = "ci" | "local";

/** `ci` when the `CI` variable is set to anything but empty, `0` or `false`. */
export function legOf(env: Env = process.env): Leg {
  const ci = env["CI"]?.trim().toLowerCase();
  return ci && ci !== "0" && ci !== "false" ? "ci" : "local";
}

/** The persistent ledger directory of a leg. */
export function ledgerDirOf(env: Env = process.env, leg: Leg = legOf(env)): string {
  return env[LEDGER_ENV] || join(stateHome(env), "assetgrove", "real-checks", leg);
}

/** Work-item spend in each ledger directory when this process (one run) first opened it. */
const runStarts = new Map<string, number>();

/** The reason a check skips when one of `keys` is unset, else false. */
export function skipWithout(...keys: string[]): string | false {
  const missing = keys.filter((k) => !process.env[k]);
  return missing.length > 0 ? `${missing.join(" and ")} not set` : false;
}

export interface RealBudgetOptions {
  /** The environment keys are read from; `process.env` by default. Never modified. */
  env?: Env;
  /** Overrides the leg's ledger directory. */
  ledgerDir?: string;
  /** Overrides the leg's share (tests). */
  shareUsd?: number;
  /** Extra provider entries, each with its declared limit (tests pass a scripted one). */
  providers?: Record<string, ProviderSettings>;
}

export interface RealBudget {
  leg: Leg;
  shareUsd: number;
  ledgerDir: string;
  /** The settings the product loaded from the temporary file. */
  settings: Settings;
  /** The env the product reads: the caller's, with `ASSETGROVE_CONFIG` naming the temporary file. */
  env: Env;
  /** The cross-run ledger under the work item `real-checks`. */
  ledger: SpendLedger;
  /** What is left of this leg's share, from the ledger as it is now. */
  budgetLeftUsd(): number;
  /** What is left of the 1.50 USD run cap, which every check in this process (one run) shares. */
  runLeftUsd(): number;
  /** The provider the settings make for an adapter. */
  provider(adapter: string, script?: Script): ConfiguredProvider;
  /**
   * A check's budget: refuses (`BudgetExceededError`, exit 3) before any call when `forecastUsd` is
   * above what is left of the run cap or the budget left.
   */
  begin(forecastUsd: number, what: string, provider?: ConfiguredProvider): Budget;
  /** A recorded, budgeted caller on `provider`, after `begin` accepts the forecast. */
  caller(
    provider: ConfiguredProvider,
    forecastUsd: number,
    what: string,
    routes?: Routes,
  ): { caller: Caller; budget: Budget };
}

/** Writes the temporary settings and loads them through the product. */
export function realBudget(options: RealBudgetOptions = {}): RealBudget {
  const baseEnv = options.env ?? process.env;
  const leg = legOf(baseEnv);
  const shareUsd = options.shareUsd ?? SHARES[leg];
  const ledgerDir = options.ledgerDir ?? ledgerDirOf(baseEnv, leg);
  const limit = { kind: "key-budget", usd: shareUsd } as const;
  const file = {
    format: "assetgrove-settings/1",
    stateDir: ledgerDir,
    caps: { runUsd: RUN_USD, dailyUsd: shareUsd, workItemUsd: shareUsd },
    providers: {
      "vercel-ai-gateway": { limit },
      tripo: { limit },
      ...options.providers,
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "assetgrove-real-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  const env: Env = { ...baseEnv, ASSETGROVE_CONFIG: path };
  const settings = loadSettings({ env, cwd: dir });
  const ledger = SpendLedger.fromSettings(settings, { workItem: WORK_ITEM, env });
  const workItem = () => ledger.status().limits.find((l) => l.limit === "work-item");
  const budgetLeftUsd = () => workItem()?.remainingUsd ?? 0;
  const spentUsd = () => workItem()?.spentUsd ?? 0;
  if (!runStarts.has(ledgerDir)) runStarts.set(ledgerDir, spentUsd());
  const runStart = runStarts.get(ledgerDir) ?? 0;
  const runLeftUsd = () => Math.max(0, settings.caps.runUsd - (spentUsd() - runStart));
  const provider = (adapter: string, script?: Script) =>
    providerOfAdapter(settings, adapter, { env, ...(script !== undefined && { script }) });
  const begin = (forecastUsd: number, what: string, configured?: ConfiguredProvider) => {
    const runLedger =
      configured === undefined ? ledger : ledgerFor(ledger, configured.provider, undefined);
    const budget = new Budget(runLeftUsd(), runLedger);
    budget.check(forecastUsd, what);
    return budget;
  };
  return {
    leg,
    shareUsd,
    ledgerDir,
    settings,
    env,
    ledger,
    budgetLeftUsd,
    runLeftUsd,
    provider,
    begin,
    caller(configured, forecastUsd, what, routes = defaultRoutes) {
      const budget = begin(forecastUsd, what, configured);
      const caller = new Caller({
        provider: configured.provider,
        providerName: configured.id,
        budget,
        routes,
        log: (line) => console.log(line),
      });
      return { caller, budget };
    },
  };
}
