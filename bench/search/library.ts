/**
 * The full library the by-look bars were set on: every image of `inventory-full.csv` (1,728 of
 * the spike's 1,733, five byte-identical duplicates dropped), with its by-look label. Images are
 * fetched like the labelled 300 (pack zip `#` path, sha256 checked) and never committed.
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { PACK_ZIPS, parseInventory } from "./build-manifest.ts";
import type { Label, ManifestImage } from "./manifest.ts";

export interface LookLibrary {
  images: ManifestImage[];
  /** By-look labels only: pack, category and 16-px pixel art. */
  labels: Label[];
}

export const FULL_INVENTORY = join(import.meta.dirname, "inventory-full.csv");

export function lookLibrary(csv: string): LookLibrary {
  const rows = parseInventory(csv).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const r of rows) if (!PACK_ZIPS[r.pack]) throw new Error(`${r.id}: unknown pack ${r.pack}`);
  return {
    images: rows.map((r) => ({
      id: r.id,
      file: basename(r.path),
      url: `${PACK_ZIPS[r.pack]}#${r.path}`,
      sha256: r.sha256,
      width: r.width,
      height: r.height,
    })),
    labels: rows.map((r) => ({
      image: r.id,
      category: r.category,
      pack: r.pack,
      ...(r.pixel ? { pixel: 16 } : {}),
    })),
  };
}

export async function readLookLibrary(path: string = FULL_INVENTORY): Promise<LookLibrary> {
  return lookLibrary(await readFile(path, "utf8"));
}
