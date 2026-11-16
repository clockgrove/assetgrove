/**
 * Builds bench/search/manifest.json (without card texts) from inventory.csv, the ~300-image subset
 * of the spike's 1,733 CC0 images, and the written queries of queries.ts. `node
 * bench/search/build-manifest.ts`. Card texts come later from write-card-texts.ts, relevance from
 * judge-relevance.ts; this script keeps any already written (a reworded query loses its judgements).
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  MANIFEST_FORMAT,
  relevantOf,
  type Manifest,
  type ManifestImage,
  type WrittenQuery,
} from "./manifest.ts";
import { CARD_PROMPT } from "./card-text.ts";
import { WRITTEN_QUERIES } from "./queries.ts";

/** Each pack's zip, from Kenney's own OpenGameArt uploads (CC0 1.0). Extract with `unzip -d <pack>`. */
export const PACK_ZIPS: Record<string, string> = {
  "tiny-dungeon": "https://opengameart.org/sites/default/files/kenney_tinydungeon.zip",
  "tiny-town": "https://opengameart.org/sites/default/files/kenney_tiny-town.zip",
  "game-icons": "https://opengameart.org/sites/default/files/Kenney_gameIcons.zip",
  "racing-pack": "https://opengameart.org/sites/default/files/racing-pack.zip",
  "space-shooter-redux": "https://opengameart.org/sites/default/files/SpaceShooterRedux.zip",
  "animal-pack-redux": "https://opengameart.org/sites/default/files/kenney_animalPackRedux.zip",
  "platformer-art-deluxe":
    "https://opengameart.org/sites/default/files/platformerGraphicsDeluxe_Updated.zip",
  "toon-characters-1": "https://opengameart.org/sites/default/files/kenney_toonCharacters1.zip",
  "generic-items":
    "https://opengameart.org/sites/default/files/kenney_genericItems_updatedCross.zip",
  "topdown-shooter": "https://opengameart.org/sites/default/files/topdown-shooter.zip",
  "rpg-urban-pack": "https://opengameart.org/sites/default/files/kenney_RPGurbanPack.zip",
};

interface Row {
  id: string;
  sha256: string;
  pack: string;
  path: string;
  category: string;
  width: number;
  height: number;
  pixel: boolean;
}

export function parseInventory(csv: string): Row[] {
  const rows: Row[] = [];
  for (const line of csv.trim().split("\n").slice(1)) {
    const m = /^([0-9a-f]{64}),([^,]+),"?([^",]+)"?,([^,]+),(\d+),(\d+),([01])$/.exec(line);
    if (!m) throw new Error(`bad inventory line: ${line}`);
    const [, sha256, pack, path, category, w, h, px] = m as unknown as string[];
    rows.push({
      id: `kn-${sha256!.slice(0, 10)}`,
      sha256: sha256!,
      pack: pack!,
      path: path!,
      category: category!,
      width: Number(w),
      height: Number(h),
      pixel: px === "1",
    });
  }
  return rows;
}

export function buildManifest(rows: Row[], previous?: Manifest): Manifest {
  const old = new Map((previous?.images ?? []).map((i) => [i.id, i]));
  const images: ManifestImage[] = rows.map((r) => ({
    id: r.id,
    file: basename(r.path),
    url: `${PACK_ZIPS[r.pack]}#${r.path}`,
    sha256: r.sha256,
    width: r.width,
    height: r.height,
    ...(old.get(r.id)?.card ? { card: old.get(r.id)!.card! } : {}),
  }));
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    format: MANIFEST_FORMAT,
    description:
      "About 300 of the search spike's 1,733 CC0 Kenney images, stratified across every category and pack. Images are fetched from the pack zips (url#path_in_pack) and never committed. By-look relevance is same pack and same category; by-words relevance is a decision model's judgement of each pooled candidate image against the query.",
    strata: {
      categories: [...new Set(rows.map((r) => r.category))].sort(),
      packs: Object.keys(PACK_ZIPS).sort(),
      minPixel16: 30,
    },
    prompts:
      previous?.prompts && Object.keys(previous.prompts).length
        ? previous.prompts
        : { "card-v1": CARD_PROMPT },
    images: images.sort((a, b) => (a.id < b.id ? -1 : 1)),
    labels: sorted.map((r) => ({
      image: r.id,
      category: r.category,
      pack: r.pack,
      ...(r.pixel ? { pixel: 16 } : {}),
    })),
    lookQueries: sorted.map((r) => r.id),
    writtenQueries: WRITTEN_QUERIES.map((text, i) => {
      const id = `q${String(i + 1).padStart(2, "0")}`;
      // A query whose words are unchanged keeps its pool and judgements; a reworded one starts over.
      const was = previous?.writtenQueries.find((q) => q.id === id && q.text === text);
      const q: WrittenQuery = { id, text };
      if (was?.candidates) q.candidates = was.candidates;
      if (was?.pooledBy) q.pooledBy = was.pooledBy;
      if (was?.judgements) q.judgements = was.judgements;
      return q;
    }),
  };
}

if (import.meta.main) {
  const dir = import.meta.dirname;
  const rows = parseInventory(await readFile(join(dir, "inventory.csv"), "utf8"));
  const prev = await readFile(join(dir, "manifest.json"), "utf8").then(
    (s) => JSON.parse(s) as Manifest,
    () => undefined,
  );
  const m = buildManifest(rows, prev);
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
  for (const q of m.writtenQueries)
    console.log(q.id, q.text, q.judgements ? relevantOf(q).length : "not judged");
  console.log("pixel16", m.labels.filter((l) => l.pixel === 16).length);
}
