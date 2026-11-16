/**
 * `node bench/search/run.ts [--fixture] [--manifest p] [--library csv] [--images dir]
 * [--embedder siglip2|scripted] [--models dir]`. By-look searches the full library (`--library`,
 * default inventory-full.csv). Every run indexes through the package's indexer into a `LanceStore`
 * in a temporary folder and searches through the package's find.
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { ScriptedEmbedder } from "../../packages/assetgrove-search/src/scripted.ts";
import { readBars } from "./bars.ts";
import { formatReport, runBench } from "./bench.ts";
import { writeCardTexts, ScriptedVision } from "./card-text.ts";
import { fetchImages } from "./fetch.ts";
import { FULL_INVENTORY, readLookLibrary, type LookLibrary } from "./library.ts";
import { buildFixtureManifest, fixtureSource } from "./fixture.ts";
import { checkManifest, readManifest, wordsLabelProblems } from "./manifest.ts";
import { judgeRelevance, poolCandidates, ScriptedJudge } from "./relevance.ts";

const { values } = parseArgs({
  options: {
    fixture: { type: "boolean", default: false },
    manifest: { type: "string", default: join(import.meta.dirname, "manifest.json") },
    images: { type: "string", default: join(import.meta.dirname, ".cache") },
    library: { type: "string", default: FULL_INVENTORY },
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
let lookLibrary: LookLibrary | undefined;
if (values.fixture) {
  manifest = buildFixtureManifest();
  source = fixtureSource();
  await writeCardTexts({ manifest, source, provider: new ScriptedVision() });
  // Relevance offline: pooled with the scripted embedder, judged by the scripted judge.
  await poolCandidates({ manifest, source, embedder });
  await judgeRelevance({ manifest, source, judge: new ScriptedJudge() });
} else {
  manifest = await readManifest(values.manifest as string);
  // Shipped mode needs a written card text per image: refuse rather than measure without them.
  // By words needs every pooled candidate judged, and no rule-made label left.
  const problems = [...checkManifest(manifest), ...wordsLabelProblems(manifest, { embedder })];
  if (problems.length > 0) {
    console.error(`the manifest is not ready to measure:\n${problems.slice(0, 10).join("\n")}`);
    process.exit(1);
  }
  lookLibrary = await readLookLibrary(values.library as string);
  // The labelled 300 and the full library together, each image once, each checked by sha256.
  source = await fetchImages(
    { images: [...manifest.images, ...lookLibrary.images] },
    values.images as string,
  );
}

const report = await runBench({
  manifest,
  source,
  embedder,
  bars,
  padTo,
  lookLibrary,
  // Only the offline fixture is judged by the scripted judge.
  scriptedJudgements: values.fixture === true,
});
for (const line of formatReport(report)) console.log(line);
