/** A 20-image synthetic fixture: captions stand in for pixels, so the scripted embedder reads them. */
import { createHash } from "node:crypto";
import type { ImageSource } from "./fetch.ts";
import { MANIFEST_FORMAT, type Manifest } from "./manifest.ts";

const SUBJECTS: Record<string, [string, string[]]> = {
  characters: [
    "knight",
    [
      "armored knight with sword",
      "hooded mage with staff",
      "green goblin warrior",
      "armored knight with sword in blue",
    ],
  ],
  tiles: [
    "terrain",
    [
      "grass tile with flowers",
      "cobblestone road tile",
      "sand dune tile",
      "grass tile with flowers in autumn",
    ],
  ],
  icons: ["ui", ["health potion icon red", "gold coin icon", "iron key icon", "magic scroll icon"]],
  props: [
    "furniture",
    ["wooden treasure chest", "stone altar with candles", "barrel of ale", "iron lantern hanging"],
  ],
  pixel: [
    "pixel",
    ["pixel heart sprite", "pixel sword sprite", "pixel mushroom sprite", "pixel skull sprite"],
  ],
};
const PACKS: Record<string, string> = {
  characters: "pack-a",
  tiles: "pack-a",
  icons: "pack-b",
  props: "pack-b",
  pixel: "pack-c",
};

export const FIXTURE_LOOKS: Record<string, string> = {};

export function buildFixtureManifest(): Manifest {
  const images: Manifest["images"] = [];
  const labels: Manifest["labels"] = [];
  let n = 0;
  for (const [category, [, looks]] of Object.entries(SUBJECTS)) {
    for (const look of looks) {
      const id = `fx-${String(++n).padStart(2, "0")}`;
      FIXTURE_LOOKS[id] = look;
      images.push({
        id,
        file: `${category}_${n}.png`,
        url: `https://fixtures.invalid/bench/${id}.png`,
        sha256: createHash("sha256").update(look).digest("hex"),
        width: category === "pixel" ? 16 : 64,
        height: category === "pixel" ? 16 : 64,
      });
      labels.push({
        image: id,
        category,
        pack: PACKS[category] as string,
        ...(category === "pixel" ? { pixel: 16 } : {}),
      });
    }
  }
  return {
    format: MANIFEST_FORMAT,
    description: "Synthetic 20-image fixture for the offline bench test. Not the labelled library.",
    strata: {
      categories: Object.keys(SUBJECTS),
      packs: ["pack-a", "pack-b", "pack-c"],
      minPixel16: 4,
    },
    prompts: {},
    images,
    labels,
    lookQueries: images.map((i) => i.id),
    // Not pooled or judged: `poolCandidates` and `judgeRelevance` with the scripted providers do
    // that. "armored knight with sword" is answered by two images only, so it is dropped.
    writtenQueries: [
      { id: "wq-1", text: "ground tile" },
      { id: "wq-2", text: "pixel sprite" },
      { id: "wq-3", text: "game icon" },
      { id: "wq-4", text: "armored knight with sword" },
    ],
  };
}

/** Image bytes are the caption, which `ScriptedEmbedder` embeds as text. */
export function fixtureSource(): ImageSource {
  buildFixtureManifest();
  return { bytes: async (image) => Buffer.from(FIXTURE_LOOKS[image.id] ?? "") };
}
