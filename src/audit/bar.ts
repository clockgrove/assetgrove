/**
 * The set-consistency bar of the set-level audit (design section 8) and the statistics it judges.
 *
 * The bar is the `dataBars.setConsistency` block under "The data-dependent 1.0 bars" of
 * docs/decisions.md. docs/ is not shipped, so core carries the bar as `SET_CONSISTENCY_BAR`, which
 * a test holds equal to that block. Without a bar the audit judges nothing.
 */

/** The heading in docs/decisions.md whose fenced JSON block holds the data-dependent bars. */
export const DATA_BARS_HEADING = "## The data-dependent 1.0 bars";

export interface SetConsistencyBar {
  /** The largest standard deviation a score may have across a consistent set. */
  maxStdDev: number;
  /** How far below the set's median a score may fall before its asset is named. */
  maxBelowMedian: number;
  /** The smallest set the bar judges. */
  minSetSize: number;
}

/** The bar docs/decisions.md records (#288); a test holds it equal to the document. */
export const SET_CONSISTENCY_BAR: SetConsistencyBar | undefined = {
  maxStdDev: 0.1,
  maxBelowMedian: 0.2,
  minSetSize: 5,
};

/**
 * The `dataBars.setConsistency` block of docs/decisions.md, or undefined when the document records
 * none (no section, no block, or no `setConsistency` entry). A malformed bar throws.
 */
export function parseSetConsistencyBar(decisionsMarkdown: string): SetConsistencyBar | undefined {
  const start = decisionsMarkdown.indexOf(`${DATA_BARS_HEADING}\n`);
  if (start < 0) return undefined;
  const rest = decisionsMarkdown.slice(start + DATA_BARS_HEADING.length);
  const next = rest.search(/\n## /);
  const section = next < 0 ? rest : rest.slice(0, next);
  const block = /```json\n([\s\S]*?)\n```/.exec(section);
  if (!block) return undefined;
  const parsed = JSON.parse(block[1]!) as { dataBars?: { setConsistency?: unknown } };
  const bar = parsed.dataBars?.setConsistency as Record<string, unknown> | undefined;
  if (bar === undefined) return undefined;
  for (const key of ["maxStdDev", "maxBelowMedian", "minSetSize"])
    if (typeof bar[key] !== "number" || !Number.isFinite(bar[key]))
      throw new Error(`dataBars.setConsistency.${key} must be a number`);
  return {
    maxStdDev: bar["maxStdDev"] as number,
    maxBelowMedian: bar["maxBelowMedian"] as number,
    minSetSize: bar["minSetSize"] as number,
  };
}

/** One score's spread across the set. */
export interface Spread {
  /** How many members have this score. */
  n: number;
  mean: number;
  median: number;
  /** The sample standard deviation (n - 1); 0 for one score. */
  stdDev: number;
  min: number;
  max: number;
  /** max - min. */
  range: number;
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The spread of a non-empty list of scores. */
export function spreadOf(values: readonly number[]): Spread {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) : 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    n,
    mean: round(mean),
    median: round(median(values)),
    stdDev: round(Math.sqrt(variance)),
    min: round(min),
    max: round(max),
    range: round(max - min),
  };
}

/** How the bar judged one score kind across the set. */
export interface ScoreJudgement {
  /** False when there is no bar or the set is under its `minSetSize`: nothing is judged. */
  judged: boolean;
  /** Whether the standard deviation is within the bar; absent when not judged. */
  consistent?: boolean;
  /** The members more than `maxBelowMedian` below the median, lowest first. */
  beyond: { address: string; score: number; belowMedian: number }[];
  /** Why nothing was judged. */
  reason?: string;
}

/**
 * Judges one score kind's scores (address to score) against the bar. The bar's size rule applies to
 * the set, so `setSize` is the number of the set's audited members, which may exceed the number of
 * scores (an identity score only where the subject has a lock, or a failed call). It defaults to
 * the number of scores.
 */
export function judgeScores(
  scores: readonly { address: string; score: number }[],
  bar: SetConsistencyBar | undefined,
  setSize: number = scores.length,
): ScoreJudgement {
  if (bar === undefined)
    return {
      judged: false,
      beyond: [],
      reason: "docs/decisions.md records no set-consistency bar",
    };
  if (setSize < bar.minSetSize)
    return {
      judged: false,
      beyond: [],
      reason: `a set of ${setSize}, under the bar's set size of ${bar.minSetSize}`,
    };
  if (scores.length === 0) return { judged: false, beyond: [], reason: "no member has this score" };
  const spread = spreadOf(scores.map((s) => s.score));
  const beyond = scores
    .map((s) => ({
      address: s.address,
      score: s.score,
      belowMedian: round(spread.median - s.score),
    }))
    .filter((s) => s.belowMedian > bar.maxBelowMedian)
    .sort((a, b) => a.score - b.score || a.address.localeCompare(b.address));
  return { judged: true, consistent: spread.stdDev <= bar.maxStdDev, beyond };
}
