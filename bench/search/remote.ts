import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { searchSlot } from "../../packages/assetgrove-search/src/extension.ts";
import { setupModel } from "../../packages/assetgrove-search/src/setup.ts";
import type {
  SearchContext,
  SearchLibraryItem,
  SearchQuery,
  SearchStoreSettings,
} from "../../src/extension/api.ts";
import { pinnedDownload } from "../../src/extension/setup.ts";
import { ScriptedVision, writeCardTexts } from "./card-text.ts";
import { fetchImages, type ImageSource } from "./fetch.ts";
import { buildFixtureManifest, fixtureSource } from "./fixture.ts";
import { checkManifest, readManifest, type Manifest } from "./manifest.ts";

function storeFor(writer: boolean, fixturePath: string | undefined): SearchStoreSettings {
  if (fixturePath !== undefined) {
    return {
      uri: pathToFileURL(resolve(fixturePath)).href,
      options: {},
      credentialsEnv: {},
      writer,
    };
  }
  const { ASSETGROVE_R2_BUCKET: bucket, ASSETGROVE_R2_ENDPOINT: endpoint } = process.env;
  const prefix = process.env.ASSETGROVE_R2_PREFIX;
  assert(bucket && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket), "Set ASSETGROVE_R2_BUCKET");
  assert(
    endpoint &&
      /^https:\/\/[a-f0-9]{32}(?:\.(?:eu|fedramp|us))?\.r2\.cloudflarestorage\.com$/.test(endpoint),
    "Set ASSETGROVE_R2_ENDPOINT to the bucket's R2 S3 endpoint",
  );
  assert(prefix && /^assetgrove-gate\/\d+\/\d+$/.test(prefix), "Set the workflow run's R2 prefix");
  assert(process.env.AWS_ACCESS_KEY_ID, "Set ASSETGROVE_R2_ACCESS_KEY_ID");
  assert(process.env.AWS_SECRET_ACCESS_KEY, "Set ASSETGROVE_R2_SECRET_ACCESS_KEY");
  return {
    uri: `s3://${bucket}/${prefix}`,
    options: { endpoint, region: "auto" },
    credentialsEnv: { accessKeyId: "AWS_ACCESS_KEY_ID", secretAccessKey: "AWS_SECRET_ACCESS_KEY" },
    writer,
  };
}

function fixtureLibrary(manifest: Manifest, head: string, origin: string, source?: ImageSource) {
  const game = "search-remote-gate";
  const images = new Map(manifest.images.map((image) => [image.id, image]));
  const items = manifest.labels.map((label, i): SearchLibraryItem => {
    const image = images.get(label.image);
    assert(image, `No manifest image for label ${label.image}`);
    const type = i === manifest.labels.length - 1 ? "reference" : "pick";
    return {
      id: image.id,
      address: `asset://${game}/${type}/${image.id}`,
      game,
      path: `${type}/${image.id}${extname(image.file)}`,
      source: type,
      kind: label.category,
      subject: label.pack,
      tags: [label.category, label.pack],
      size: 0,
      mtimeMs: 0,
      text: image.card?.text,
    };
  });
  const library: SearchContext["library"] = {
    async list(sources) {
      return sources ? items.filter((item) => sources.includes(item.source)) : items;
    },
    async load(item) {
      assert(source, "The reader should only read media vectors already in the shared index");
      const image = images.get(item.id);
      assert(image, `No manifest image for ${item.id}`);
      const bytes = await source.bytes(image);
      return { bytes, views: [{ view: "", image: bytes }] };
    },
    clean: async () => git("status", "--porcelain", "--untracked-files=normal") === "",
    head: async () => head,
    origin: async () => origin,
  };
  return { game, items, library };
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function verifyQueries(
  ctx: SearchContext,
  items: SearchLibraryItem[],
  words: string,
  head: string,
) {
  async function find(query: SearchQuery) {
    const result = await searchSlot.find(query, ctx);
    assert(result.fresh, "The remote index must be fresh in the reader job");
    assert.equal(result.builtFrom?.head, head, "The remote index must come from this commit");
    assert(result.hits.length > 0, "The reader query must find shared results");
    return result.hits;
  }

  const pick = items.find((item) => item.source === "pick");
  const reference = items.find((item) => item.source === "reference");
  assert(pick && reference?.kind, "The labelled library must contain both kinds of shared rows");
  const textHits = await find({ words, sources: ["pick"], limit: 10 });
  assert(textHits.every((hit) => hit.source === "pick" && hit.sharedText.text));
  const imageHits = await find({ like: { address: pick.address }, sources: ["pick"], limit: 10 });
  assert(
    imageHits.some((hit) => hit.address === pick.address),
    "The stored vector must be searchable",
  );
  const filterHits = await find({
    where: [`kind=${reference.kind}`],
    sources: ["reference"],
    limit: 10,
  });
  assert(
    filterHits.every((hit) => hit.source === "reference" && hit.fields.kind === reference.kind),
  );
  assert(filterHits.some((hit) => hit.address === reference.address));
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "fixture-store": { type: "string" } },
});
const [phase] = positionals;
assert(positionals.length === 1 && (phase === "write" || phase === "read"), "Use write or read");
const writer = phase === "write";
const fixturePath = values["fixture-store"];
const store = storeFor(writer, fixturePath);
const offline = fixturePath !== undefined;
assert.equal(git("rev-parse", "--is-shallow-repository"), "false", "Use a complete Git checkout");
const head = git("rev-parse", "HEAD");
const origin = git("rev-list", "--max-parents=0", head).split("\n").sort().join(" ");
const worktree = git("rev-parse", "--show-toplevel");
const stateDir = await mkdtemp(
  join(process.env.RUNNER_TEMP ?? tmpdir(), "assetgrove-search-remote-"),
);
try {
  const manifest = offline
    ? buildFixtureManifest()
    : await readManifest(new URL("manifest.json", import.meta.url));
  const source = offline ? fixtureSource() : undefined;
  if (source) await writeCardTexts({ manifest, source, provider: new ScriptedVision() });
  else {
    const problems = checkManifest(manifest);
    assert.equal(problems.length, 0, problems.slice(0, 5).join("\n"));
    const modelsDir = join(stateDir, "models");
    await setupModel({ modelsDir, download: (file) => pinnedDownload(modelsDir, file) });
  }
  const media = writer
    ? (source ?? (await fetchImages(manifest, join(stateDir, "images"))))
    : undefined;
  const { game, items, library } = fixtureLibrary(manifest, head, origin, media);
  const ctx: SearchContext = {
    worktree,
    stateDir,
    game,
    library,
    settings: {
      embedder: offline ? "scripted" : "local",
      model: "siglip2-base",
      candidates: false,
      nearMatch: false,
      folders: [],
      store,
    },
    env: process.env,
    log: () => undefined,
  };
  if (writer) {
    for (const rebuild of [false, true]) {
      const { remote } = await searchSlot.index({ rebuild }, ctx);
      const built = remote as { written: boolean; builtFrom: { head: string } } | undefined;
      assert(built?.written, "The writer must update the remote index");
      assert.equal(built.builtFrom.head, head);
    }
    console.log(`Indexed and rebuilt ${items.length} labelled images from clean HEAD ${head}.`);
  } else {
    const words = manifest.writtenQueries[0]?.text;
    assert(words, "The labelled manifest must contain a text query");
    await verifyQueries(ctx, items, words, head);
    console.log(
      `A fresh reader verified shared text, image similarity, and exact filters at ${head}.`,
    );
  }
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
