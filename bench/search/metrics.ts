/** Ranking helpers and quality measures. Pure functions over vectors and labels. */
import { cosine } from "../../packages/assetgrove-search/src/embedder.ts";

/** Reciprocal Rank Fusion over ranked key lists (k = 60), best first. */
export function rrf(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists)
    list.forEach((key, i) => score.set(key, (score.get(key) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map((e) => e[0]);
}

export const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Nearest-rank percentile. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] as number;
}

export interface PairSim {
  sim: number;
  same: boolean;
}

/** Every unordered pair of vectors, with whether the pair is a labelled same-asset pair. */
export function allPairs(
  ids: string[],
  vecs: Map<string, Float32Array>,
  same: [string, string][],
): PairSim[] {
  const key = (a: string, b: string) => (a < b ? `${a}\0${b}` : `${b}\0${a}`);
  const positives = new Set(same.map(([a, b]) => key(a, b)));
  const out: PairSim[] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i] as string;
      const b = ids[j] as string;
      out.push({
        sim: cosine(vecs.get(a) as Float32Array, vecs.get(b) as Float32Array),
        same: positives.has(key(a, b)),
      });
    }
  return out;
}

/**
 * The image-similarity threshold rule: the lowest similarity t such that, among all pairs with
 * similarity >= t, at least `precision` are labelled same-asset pairs. Null when none reaches it.
 */
export function similarityThreshold(pairs: PairSim[], precision = 0.9): number | null {
  const sorted = [...pairs].sort((a, b) => b.sim - a.sim);
  let hits = 0;
  let best: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    if ((sorted[i] as PairSim).same) hits++;
    const next = sorted[i + 1];
    // Only cut between distinct similarities.
    if (next && next.sim === (sorted[i] as PairSim).sim) continue;
    if (hits > 0 && hits / (i + 1) >= precision) best = (sorted[i] as PairSim).sim;
  }
  return best;
}
