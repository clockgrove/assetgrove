/**
 * Orchestrator step o-6 runs this once: it writes the card texts into the manifest with a vision
 * model. `node bench/search/write-card-texts.ts --provider gateway --model <id>`.
 * `--sample <n> [--seed s]` prints the image ids a person should spot-check;
 * `--mark <id,id> --by <name>` records that they did.
 */
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CARD_PROMPT,
  gatewayVision,
  markSpotChecked,
  ScriptedVision,
  spotCheckSample,
  writeCardTexts,
} from "./card-text.ts";
import { fetchImages } from "./fetch.ts";
import { checkManifest, type Manifest } from "./manifest.ts";

const { values } = parseArgs({
  options: {
    manifest: { type: "string", default: join(import.meta.dirname, "manifest.json") },
    images: { type: "string", default: join(import.meta.dirname, ".cache") },
    provider: { type: "string", default: "gateway" },
    model: { type: "string", default: "anthropic/claude-sonnet-5-5" },
    force: { type: "boolean", default: false },
    sample: { type: "string" },
    seed: { type: "string", default: "spot-check" },
    mark: { type: "string" },
    by: { type: "string" },
  },
});

const path = values.manifest as string;
const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest;
const save = () => writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);

if (values.sample) {
  console.log(spotCheckSample(manifest, Number(values.sample), values.seed as string).join("\n"));
} else if (values.mark) {
  if (!values.by) throw new Error("--by names the person who checked");
  markSpotChecked(manifest, values.mark.split(","), values.by, new Date().toISOString());
  await save();
} else {
  const source = await fetchImages(manifest, values.images as string);
  const provider =
    values.provider === "scripted"
      ? new ScriptedVision()
      : await gatewayVision(values.model as string);
  const n = await writeCardTexts({
    manifest,
    source,
    provider,
    prompt: CARD_PROMPT,
    force: values.force,
  });
  await save();
  console.log(`wrote ${n} card texts; problems: ${JSON.stringify(checkManifest(manifest))}`);
}
