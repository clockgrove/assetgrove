/**
 * Set outliers (design section 7.5): each member of a set gets its mean cosine distance to its
 * five nearest neighbours in the set, as a robust z-score (median and MAD); members with z > 3
 * are listed. Advisory and free.
 */
export const NEIGHBOURS = 5;
export const Z_LIMIT = 3;
/** Below this scale (cosine distance) every member counts as the same style. */
const SCALE_FLOOR = 1e-6;
/** A set smaller than this has no spread to measure. */
const MIN_MEMBERS = 3;

export interface Member {
  address: string;
  vector: Float32Array;
}

export interface Outlier {
  address: string;
  distance: number;
  z: number;
}

const median = (sorted: number[]): number => {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/** Cosine distance of two vectors, normalised here so a store's scaling never matters. */
function distance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 1 : Math.max(0, 1 - dot / denom);
}

/** Every member's score, then the ones with z above the limit, most distant first. */
export function findOutliers(members: readonly Member[]): Outlier[] {
  if (members.length < MIN_MEMBERS) return [];
  const k = Math.min(NEIGHBOURS, members.length - 1);
  const scores = members.map((m, i) => {
    const d: number[] = [];
    members.forEach((o, j) => {
      if (j !== i) d.push(distance(m.vector, o.vector));
    });
    d.sort((a, b) => a - b);
    return d.slice(0, k).reduce((sum, v) => sum + v, 0) / k;
  });
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = median(sorted);
  const mad = median(sorted.map((v) => Math.abs(v - mid)).sort((a, b) => a - b));
  const scale = Math.max(1.4826 * mad, SCALE_FLOOR);
  return members
    .map((m, i) => ({ address: m.address, distance: scores[i] as number, z: ((scores[i] as number) - mid) / scale }))
    .filter((o) => o.z > Z_LIMIT)
    .sort((a, b) => b.z - a.z);
}
