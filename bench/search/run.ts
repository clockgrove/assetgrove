/** `node bench/search/run.ts [--fixture] [--manifest p] [--images dir] [--embedder siglip2|scripted]` */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { ScriptedEmbedder } from "../../packages/assetgrove-search/src/scripted.ts";
import { readBars } from "./bars.ts";
import { formatReport, runBench } from "./bench.ts";
import { writeCardTexts, ScriptedVision } from "./card-text.ts";
import { fetchImages } from "./fetch.ts";
import { buildFixtureManifest, fixtureSource } from "./fixture.ts";
import { readManifest } from "./manifest.ts";

const { values } = parseArgs({
  options: {
    fixture: { type: "boolean", default: false },
    manifest: { type: "string", default: join(import.meta.dirname, "manifest.json") },
    images: { type: "string", default: join(import.meta.dirname, ".cache") },
    embedder: { type: "string", default: "scripted" },
    models: { type: "string" },
    pad: { type: "string", default: "10000" },
  },
});

const bars = await readBars();
const padTo = Number(values.pad);
let embedder;
if (values.embedder === "siglip2") {
  const { loadSiglip2 } = await import("../../packages/assetgrove-search/src/siglip2.ts");
  embedder = await loadSiglip2(values.models as string);
} else embedder = new ScriptedEmbedder();

let manifest;
let source;
if (values.fixture) {
  manifest = buildFixtureManifest();
  source = fixtureSource();
  await writeCardTexts({ manifest, source, provider: new ScriptedVision() });
} else {
  manifest = await readManifest(values.manifest as string);
  source = await fetchImages(manifest, values.images as string);
}
for (const line of formatReport(await runBench({ manifest, source, embedder, bars, padTo })))
  console.log(line);
