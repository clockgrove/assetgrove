/** Quality measures. Pure functions over rankings and labels; the rankings are the package's own. */

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
