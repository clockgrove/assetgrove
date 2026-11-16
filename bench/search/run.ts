/**
 * `node bench/search/run.ts [--fixture] [--manifest p] [--library csv] [--images dir]
 * [--embedder siglip2|scripted] [--store lance|memory]`. By-look searches the full library
 * (`--library`, default inventory-full.csv); with siglip2 the store defaults to the shipped LanceStore.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { LanceStore } from "../../packages/assetgrove-search/src/lance-store.ts";
import { MemoryStore } from "../../packages/assetgrove-search/src/memory-store.ts";
import type { Store } from "../../packages/assetgrove-search/src/store.ts";
import { ScriptedEmbedder } from "../../packages/assetgrove-search/src/scripted.ts";
import { readBars } from "./bars.ts";
import { formatReport, runBench } from "./bench.ts";
import { writeCardTexts, ScriptedVision } from "./card-text.ts";
import { fetchImages } from "./fetch.ts";
import { FULL_INVENTORY, readLookLibrary, type LookLibrary } from "./library.ts";
import { buildFixtureManifest, fixtureSource } from "./fixture.ts";
import { checkManifest, readManifest } from "./manifest.ts";

const { values } = parseArgs({
  options: {
    fixture: { type: "boolean", default: false },
    manifest: { type: "string", default: join(import.meta.dirname, "manifest.json") },
    images: { type: "string", default: join(import.meta.dirname, ".cache") },
    library: { type: "string", default: FULL_INVENTORY },
    embedder: { type: "string", default: "scripted" },
    store: { type: "string" },
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

const storeKind = values.store ?? (values.embedder === "siglip2" ? "lance" : "memory");
if (storeKind !== "lance" && storeKind !== "memory") {
  console.error(`--store must be lance or memory, not ${storeKind}`);
  process.exit(1);
}

let manifest;
let source;
let lookLibrary: LookLibrary | undefined;
if (values.fixture) {
  manifest = buildFixtureManifest();
  source = fixtureSource();
  await writeCardTexts({ manifest, source, provider: new ScriptedVision() });
} else {
  manifest = await readManifest(values.manifest as string);
  // Shipped mode needs a written card text per image: refuse rather than measure without them.
  const problems = checkManifest(manifest);
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

// Each store the bench asks for is a fresh LanceStore in its own folder, removed afterwards.
const stores: LanceStore[] = [];
const storeDir = storeKind === "lance" ? await mkdtemp(join(tmpdir(), "bench-store-")) : "";
const newStore = async (): Promise<Store> => {
  if (storeKind === "memory") return new MemoryStore();
  const s = await LanceStore.open(join(storeDir, `store-${stores.length}`), { embedder });
  stores.push(s);
  return s;
};
try {
  const report = await runBench({ manifest, source, embedder, bars, padTo, lookLibrary, newStore });
  for (const line of formatReport(report)) console.log(line);
} finally {
  for (const s of stores) s.close();
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
}
