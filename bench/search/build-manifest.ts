/**
 * Builds bench/search/manifest.json (without card texts) from inventory.csv, the ~300-image subset
 * of the spike's 1,733 CC0 images. `node bench/search/build-manifest.ts`. Card texts come later
 * from write-card-texts.ts (orchestrator step o-6); this script keeps any already written.
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MANIFEST_FORMAT, type Manifest, type ManifestImage } from "./manifest.ts";
import { CARD_PROMPT } from "./card-text.ts";

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
  /** The spike's `r.id`: pack and path, lower case, spaces as underscores, without extension. */
  rid: string;
  folder: string;
  /** The spike's `f(r)`: the file name, lower case. */
  f: string;
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
      rid: `${pack}/${path}`
        .toLowerCase()
        .replace(/\.[^./]+$/, "")
        .replaceAll(" ", "_"),
      folder: dirname(path!),
      f: basename(path!).toLowerCase(),
    });
  }
  return rows;
}

/** The spike's label rules for its 30 written queries (the relevance judges only). */
export const QUERY_RULES: [string, (r: Row) => boolean][] = [
  ["race car seen from above", (r) => r.pack === "racing-pack" && r.folder.endsWith("Cars")],
  ["motorcycle", (r) => /motorcycle/.test(r.f)],
  ["spaceship", (r) => r.pack === "space-shooter-redux" && r.category === "vehicle"],
  ["alien ufo", (r) => /ufo|enemy/.test(r.f)],
  ["brown meteor", (r) => r.category === "meteor"],
  ["laser beam", (r) => /laser/.test(r.f)],
  ["fire flame effect", (r) => /fire/.test(r.f)],
  ["power-up pickup", (r) => r.category === "pickup"],
  ["gold coin", (r) => /coin/.test(r.f)],
  ["key", (r) => /key/.test(r.f)],
  ["heart health icon", (r) => /heart/.test(r.f)],
  ["zombie", (r) => /zombie|zoimbie/.test(r.rid)],
  ["robot", (r) => /robot/.test(r.rid)],
  ["female adventurer character", (r) => /female_adventurer/.test(r.rid)],
  [
    "top-down soldier with a gun",
    (r) => r.pack === "topdown-shooter" && r.category === "character",
  ],
  ["cute animal face", (r) => r.pack === "animal-pack-redux"],
  ["elephant", (r) => /elephant/.test(r.f)],
  ["penguin", (r) => /penguin/.test(r.f)],
  ["slime monster enemy", (r) => r.pack === "platformer-art-deluxe" && r.category === "creature"],
  ["grass ground tile", (r) => r.category === "tile" && /grass/.test(r.rid)],
  ["road tile", (r) => r.category === "tile" && /road/.test(r.rid)],
  ["pixel art dungeon tile", (r) => r.pack === "tiny-dungeon"],
  ["pixel art town tile", (r) => r.pack === "tiny-town"],
  ["brick wall", (r) => /brick|castle|stone/.test(r.f)],
  ["water", (r) => /water/.test(r.f)],
  ["arrow button icon", (r) => /arrow|left|right|up|down/.test(r.f) && r.category === "ui-icon"],
  ["settings gear icon", (r) => /gear|wrench/.test(r.f)],
  ["traffic cone", (r) => /cone/.test(r.f)],
  ["barrel", (r) => /barrel/.test(r.f)],
  ["wooden crate box", (r) => /box|crate/.test(r.f)],
];

const COLOURS = new Set([
  "black",
  "blue",
  "green",
  "red",
  "orange",
  "yellow",
  "white",
  "brown",
  "blonde",
  "grey",
  "silver",
  "gold",
  "bronze",
  "purple",
  "pink",
]);

/** A file name with its colour variant removed: one trailing colour part, "race", and a camelCase colour. */
export function assetKey(file: string): string {
  const parts = file
    .replace(/\.[^./]+$/, "")
    .split("_")
    .filter((p) => p.toLowerCase() !== "race");
  if (parts.length > 1 && COLOURS.has(parts[parts.length - 1]!.toLowerCase())) parts.pop();
  return parts
    .map((p) =>
      p
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .split(" ")
        .filter((t) => !COLOURS.has(t.toLowerCase()) || t === p)
        .join(""),
    )
    .join("_")
    .toLowerCase();
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
  // Same asset: one asset in the same pack that differs only by folder (a restyle) or by colour
  // (a recolour: playerLife3_green/_red, character_black_blue/_green, barrier_red/_red_race).
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const key = `${r.pack}\0${assetKey(basename(r.path))}`;
    groups.set(key, [...(groups.get(key) ?? []), r.id]);
  }
  const pairs: [string, string][] = [];
  for (const ids of groups.values())
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i]!, ids[j]!]);
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    format: MANIFEST_FORMAT,
    description:
      "About 300 of the search spike's 1,733 CC0 Kenney images, stratified across every category and pack. Images are fetched from the pack zips (url#path_in_pack) and never committed. By-look relevance is same pack and same category.",
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
    writtenQueries: QUERY_RULES.map(([text, rule], i) => ({
      id: `q${String(i + 1).padStart(2, "0")}`,
      text,
      relevant: sorted.filter(rule).map((r) => r.id),
    })),
    pairs,
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
  for (const q of m.writtenQueries) console.log(q.id, q.text, q.relevant.length);
  console.log("pairs", m.pairs.length, "pixel16", m.labels.filter((l) => l.pixel === 16).length);
}
