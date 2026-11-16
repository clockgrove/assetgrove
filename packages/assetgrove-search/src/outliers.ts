/**
 * Set outliers (design section 7.5, #366): every member of a set gets its mean cosine distance to
 * every other member, and the whole set comes back ranked most distant first, uncut. The distance
 * is a free ranking, never a verdict: it tracks subject and pose as much as style, so core asks a
 * decision call which of the most distant members are drawn in a different style. Free.
 */
/** A set smaller than this has no spread to rank. */
const MIN_MEMBERS = 3;

export interface Member {
  address: string;
  vector: Float32Array;
}

export interface RankedMember {
  address: string;
  /** Mean cosine distance to every other member of the set. */
  distance: number;
}

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

/**
 * Every member's mean distance to the rest of the set, most distant first (ties by address), with
 * no cut. A set under three members has no spread and ranks nothing.
 */
export function findOutliers(members: readonly Member[]): RankedMember[] {
  if (members.length < MIN_MEMBERS) return [];
  const sums = members.map(() => 0);
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) {
      const d = distance((members[i] as Member).vector, (members[j] as Member).vector);
      sums[i] = (sums[i] as number) + d;
      sums[j] = (sums[j] as number) + d;
    }
  return members
    .map((m, i) => ({ address: m.address, distance: (sums[i] as number) / (members.length - 1) }))
    .sort((a, b) => b.distance - a.distance || (a.address < b.address ? -1 : 1));
}
