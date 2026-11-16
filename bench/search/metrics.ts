/** Ranking helpers and quality measures. Pure functions over vectors and labels. */

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

/**
 * Precision at 5, capped by what exists: a query with fewer than five relevant images in the
 * subset divides by its relevant count, so a perfect ranking scores 1 for every query.
 */
export function precisionAt5(top: string[], relevant: string[]): number {
  if (relevant.length === 0) return 0;
  const hit = top.slice(0, 5).filter((k) => relevant.includes(k)).length;
  return hit / Math.min(5, relevant.length);
}
