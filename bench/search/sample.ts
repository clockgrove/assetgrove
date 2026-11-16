/** Draws the labelled library from the spike's inventory: stratified across every category and pack. */
import { createHash } from "node:crypto";

export interface InventoryImage {
  id: string;
  file: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  category: string;
  pack: string;
  /** 16 for 16-px pixel art. */
  pixel?: number;
  /** Set when this image is a variant of another asset (same asset, different file). */
  variantOf?: string;
}

const rank = (seed: string, id: string): string =>
  createHash("sha256").update(`${seed}\0${id}`).digest("hex");

/**
 * Takes about `target` images: the best-ranked image of every (category, pack) cell first (so no
 * stratum is missed, even if that exceeds `target`), then 16-px images up to `minPixel16`, then
 * the rest in seeded order. A variant's source is added too.
 * Deterministic for a seed.
 */
export function stratifiedSample(
  inventory: InventoryImage[],
  target: number,
  minPixel16: number,
  seed: string,
): InventoryImage[] {
  const ordered = [...inventory].sort((a, b) => (rank(seed, a.id) < rank(seed, b.id) ? -1 : 1));
  const chosen = new Map<string, InventoryImage>();
  const cells = new Set<string>();
  for (const i of ordered) {
    const cell = `${i.category}\0${i.pack}`;
    if (cells.has(cell)) continue;
    cells.add(cell);
    chosen.set(i.id, i);
  }
  const pixel = () => [...chosen.values()].filter((i) => i.pixel === 16).length;
  for (const i of ordered) if (i.pixel === 16 && pixel() < minPixel16) chosen.set(i.id, i);
  for (const i of ordered) if (chosen.size < target) chosen.set(i.id, i);
  const byId = new Map(inventory.map((i) => [i.id, i]));
  for (const i of [...chosen.values()]) {
    const v = i.variantOf ? byId.get(i.variantOf) : undefined;
    if (v) chosen.set(v.id, v);
  }
  return [...chosen.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}
