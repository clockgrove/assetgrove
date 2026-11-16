/**
 * Orchestrator step o-6 runs this once: it writes the card texts into the manifest with a vision
 * model. `node bench/search/write-card-texts.ts --provider gateway --model <id>`.
 * `--provider scripted` runs offline. `--max-calls` caps the vision calls of one run (default 700).
 * The endpoint and key come from the developer settings, as for core: the first provider entry (by id)
 * of the `vercel-ai-gateway` adapter gives `baseURL` (the full base URL, path included) and `keyEnv`;
 * with no such entry, the gateway's fixed endpoint and `AI_GATEWAY_API_KEY`. The endpoint's host is
 * printed before the first call.
 * `--sample <n> [--seed s]` prints the image ids a person should spot-check;
 * `--mark <id,id> --by <name>` records that they did.
 */
import { parseArgs } from "node:util";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BACKGROUND_NOTE,
  CARD_PROMPT,
  gatewayVision,
  markSpotChecked,
  ScriptedVision,
  spotCheckSample,
  writeCardTexts,
} from "./card-text.ts";
import { fetchImages } from "./fetch.ts";
import { checkManifest, type Manifest } from "./manifest.ts";
import { keyValue } from "../../src/env.ts";
import { gatewaySettings } from "./gateway.ts";

const { values } = parseArgs({
  options: {
    manifest: { type: "string", default: join(import.meta.dirname, "manifest.json") },
    images: { type: "string", default: join(import.meta.dirname, ".cache") },
    provider: { type: "string", default: "gateway" },
    model: { type: "string", default: "anthropic/claude-sonnet-5-5" },
    force: { type: "boolean", default: false },
    "max-calls": { type: "string", default: "700" },
    sample: { type: "string" },
    seed: { type: "string", default: "spot-check" },
    mark: { type: "string" },
    by: { type: "string" },
  },
});

const path = values.manifest as string;
const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest;
const save = async () => {
  // Write beside, then rename: an interrupted save never leaves a half-written manifest.
  await writeFile(`${path}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
};

if (values.sample) {
  console.log(spotCheckSample(manifest, Number(values.sample), values.seed as string).join("\n"));
} else if (values.mark) {
  if (!values.by) throw new Error("--by names the person who checked");
  markSpotChecked(manifest, values.mark.split(","), values.by, new Date().toISOString());
  await save();
} else {
  const scripted = values.provider === "scripted";
  // Offline on the scripted provider: no download; its "image" is the label's own words.
  const labels = new Map(manifest.labels.map((l) => [l.image, l]));
  const source = scripted
    ? {
        bytes: async (i: { id: string }) =>
          new TextEncoder().encode(
            `a ${labels.get(i.id)?.category ?? "game asset"} from the ${labels.get(i.id)?.pack ?? "library"} pack`,
          ),
      }
    : await fetchImages(manifest, values.images as string);
  let provider;
  if (scripted) {
    provider = new ScriptedVision();
  } else {
    const gateway = gatewaySettings();
    const apiKey = keyValue(gateway.keyEnv);
    console.error(
      `gateway endpoint: ${gateway.baseURL !== undefined ? new URL(gateway.baseURL).host : "the fixed endpoint"} (key from ${gateway.keyEnv})`,
    );
    provider = await gatewayVision(values.model as string, {
      ...(gateway.baseURL !== undefined && { baseURL: gateway.baseURL }),
      ...(apiKey !== undefined && { apiKey }),
    });
  }
  const n = await writeCardTexts({
    manifest,
    source,
    provider,
    // The scripted provider keeps the bare prompt its fixture records.
    prompt: scripted ? CARD_PROMPT : `${CARD_PROMPT} ${BACKGROUND_NOTE}`,
    force: values.force,
    maxCalls: Number(values["max-calls"]),
    // Save after every text: a failure late in the run loses nothing already paid for.
    onWritten: save,
  });
  await save();
  console.log(`wrote ${n} card texts; problems: ${JSON.stringify(checkManifest(manifest))}`);
}
