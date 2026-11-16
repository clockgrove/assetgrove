/**
 * Labels the bench's by-words relevance from the images, in two runs, each saving the manifest:
 *
 * - `node bench/search/judge-relevance.ts --pool --embedder siglip2 --models <dir>` sets each
 *   written query's candidates: the union of the top POOL_DEPTH of every ranking the bench scores,
 *   ranked on the shipped LanceStore. No model call; `--embedder scripted` runs offline.
 * - `node bench/search/judge-relevance.ts --provider gateway [--model <id>] --max-calls <n>` judges
 *   each candidate not yet judged, one decision call each, saving after every answer. It prints how
 *   many calls it will make before the first and stops at `--max-calls` (default 2000). Without
 *   `--provider` it only prints that count; `--provider scripted` judges offline.
 *
 * `--sample <n> [--seed s]` prints a seeded sample of judgements to check against the images;
 * `--mark <query:image,...> --by <name>` records that a person did. The gateway endpoint and key come
 * from the developer settings as for write-card-texts.ts.
 */
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LanceStore } from "../../packages/assetgrove-search/src/lance-store.ts";
import { MemoryStore } from "../../packages/assetgrove-search/src/memory-store.ts";
import { ScriptedEmbedder } from "../../packages/assetgrove-search/src/scripted.ts";
import { keyValue } from "../../src/env.ts";
import { fetchImages, type ImageSource } from "./fetch.ts";
import { gatewaySettings } from "./gateway.ts";
import { checkManifest, droppedQueries, relevantOf, unjudged, type Manifest } from "./manifest.ts";
import {
  gatewayJudge,
  judgementSample,
  judgeRelevance,
  markJudgementsChecked,
  poolCandidates,
  ScriptedJudge,
  type RelevanceJudge,
} from "./relevance.ts";

const { values } = parseArgs({
  options: {
    manifest: { type: "string", default: join(import.meta.dirname, "manifest.json") },
    images: { type: "string", default: join(import.meta.dirname, ".cache") },
    pool: { type: "boolean", default: false },
    embedder: { type: "string", default: "scripted" },
    models: { type: "string" },
    store: { type: "string" },
    force: { type: "boolean", default: false },
    provider: { type: "string" },
    model: { type: "string", default: "perplexity/pplx-decider-v1.2" },
    "max-calls": { type: "string", default: "2000" },
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

/** Offline: no download; an image's "bytes" are its label's own words, as write-card-texts.ts does. */
function labelSource(m: Manifest): ImageSource {
  const labels = new Map(m.labels.map((l) => [l.image, l]));
  return {
    bytes: async (i) =>
      new TextEncoder().encode(
        `a ${labels.get(i.id)?.category ?? "game asset"} from the ${labels.get(i.id)?.pack ?? "library"} pack`,
      ),
  };
}

const byId = new Map(manifest.images.map((i) => [i.id, i]));

if (values.sample) {
  for (const k of judgementSample(manifest, Number(values.sample), values.seed as string)) {
    const [qid, image] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    const q = manifest.writtenQueries.find((x) => x.id === qid);
    const j = q?.judgements?.find((x) => x.image === image);
    console.log([k, JSON.stringify(q?.text), byId.get(image)?.url, j?.probability].join("\t"));
  }
} else if (values.mark) {
  if (!values.by) throw new Error("--by names the person who checked");
  markJudgementsChecked(manifest, values.mark.split(","), values.by, new Date().toISOString());
  await save();
} else if (values.pool) {
  const siglip = values.embedder === "siglip2";
  const embedder = siglip
    ? await (
        await import("../../packages/assetgrove-search/src/siglip2.ts")
      ).loadSiglip2(values.models as string)
    : new ScriptedEmbedder();
  const storeKind = values.store ?? (siglip ? "lance" : "memory");
  const source = siglip
    ? await fetchImages(manifest, values.images as string)
    : labelSource(manifest);
  const dir = storeKind === "lance" ? await mkdtemp(join(tmpdir(), "bench-pool-")) : "";
  const store =
    storeKind === "lance"
      ? await LanceStore.open(join(dir, "store"), { embedder })
      : new MemoryStore();
  try {
    const n = await poolCandidates({ manifest, source, embedder, store, force: values.force });
    await save();
    const sizes = manifest.writtenQueries.map((q) => q.candidates?.length ?? 0);
    console.log(
      `pooled ${n} queries with ${embedder.id}; ${sizes.reduce((a, b) => a + b, 0)} candidates in all`,
    );
  } finally {
    if (store instanceof LanceStore) store.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
} else {
  const provider = values.provider;
  const maxCalls = Number(values["max-calls"]);
  let judge: RelevanceJudge | undefined;
  let source: ImageSource | undefined;
  if (provider === "scripted") {
    judge = new ScriptedJudge();
    source = labelSource(manifest);
  } else if (provider === "gateway") {
    const gateway = gatewaySettings();
    const apiKey = keyValue(gateway.keyEnv);
    console.error(
      `gateway endpoint: ${gateway.baseURL !== undefined ? new URL(gateway.baseURL).host : "the fixed endpoint"} (key from ${gateway.keyEnv})`,
    );
    judge = gatewayJudge(values.model as string, {
      keyEnv: gateway.keyEnv,
      ...(gateway.baseURL !== undefined && { baseURL: gateway.baseURL }),
      ...(apiKey !== undefined && { apiKey }),
    });
    source = await fetchImages(manifest, values.images as string);
  } else if (provider !== undefined) {
    throw new Error(`--provider must be gateway or scripted, not ${provider}`);
  }
  if (!judge || !source) {
    // No provider: count only, no call.
    const left = manifest.writtenQueries.reduce((n, q) => n + unjudged(q).length, 0);
    const unpooled = manifest.writtenQueries.filter((q) => q.candidates === undefined).length;
    if (unpooled > 0)
      console.log(`${unpooled} written queries are not pooled yet: run --pool first`);
    console.log(
      `${Math.min(left, maxCalls)} judge calls would be made (${left} candidates not judged, cap ${maxCalls}); pass --provider gateway to make them`,
    );
  } else {
    const { judged, left } = await judgeRelevance({
      manifest,
      source,
      judge,
      maxCalls,
      onPlan: (calls, toJudge) =>
        console.log(
          `making ${calls} judge calls (${toJudge} candidates not judged, cap ${maxCalls})`,
        ),
      // Save after every answer: a failure late in the run loses nothing already paid for.
      onJudged: save,
    });
    await save();
    console.log(
      left > 0
        ? `judged ${judged}; stopped at the cap with ${left} left: run again to go on`
        : `judged ${judged}; every candidate is judged`,
    );
    for (const q of droppedQueries(manifest))
      console.log(`dropped ${q.id} ${JSON.stringify(q.text)}: ${relevantOf(q).length} relevant`);
    console.log(`problems: ${JSON.stringify(checkManifest(manifest, { cardsPending: true }))}`);
  }
}
