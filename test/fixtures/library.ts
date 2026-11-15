/**
 * A synthetic asset library for the asset tree tests (issue #234): a Git repository with the
 * profile `init` writes, a library root `assets/` holding cards, review records, provenance and
 * media, and a runs directory. Every image is drawn here; nothing is private.
 *
 * - `lantern`: a still with two versions, the first's bytes only in a run folder, tags prop and light.
 * - `fern` (in `assets/props/`): a still made under an older bible, so stale.
 * - `walk`: a sprite strip of four 32 px frames.
 * - `boat`: a 3D asset (`boat.glb`) with turntable renders in `boat-views/`.
 * - `rock`: three versions: the first's bytes nowhere, the second's only in the local LFS store.
 * - `big`: a 1024 px noise still whose file is over the 64 KB read limit.
 * - `escape`: a card whose resource leaves the library root.
 * - `bulk-000`…: `bulk` small stills for paging, tagged bulk.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import type { Raster } from "../../src/image/raster.ts";
import { machineFields, newCard, writeCard } from "../../src/library/card.ts";
import {
  appendAnnotation,
  appendVersion,
  emptyReview,
  writeReview,
} from "../../src/library/review.ts";
import type { ReviewRecord } from "../../src/library/review.ts";
import { lfsObjectPath } from "../../src/library/lfs.ts";
import type { TargetProfile } from "../../src/types.ts";
import { drawSubject, syntheticProfile } from "./synthetic.ts";

export const GAME = "test-grove";
export const LIBRARY_ROOT = "assets";
export const RUN_ID = "r-0123456789abcdef";

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * The profile of the fixture project: the synthetic profile with a library block, a still's media
 * at `assets/<id>.<ext>` (the lantern's own path) and no validator, so a pick into it needs none.
 */
export function libraryProfile(): TargetProfile {
  const profile = syntheticProfile({
    layout: {
      media: `${LIBRARY_ROOT}/{{spec.assetId}}.{{output.extension}}`,
      manifest: "manifests/{{spec.assetId}}.json",
    },
    manifest: {
      assetId: "{{spec.assetId}}",
      review: { status: "pending" },
      contentHash: "{{output.sha256}}",
    },
    library: { root: LIBRARY_ROOT, game: GAME },
  });
  delete profile.validator;
  return profile;
}

export interface FixtureLibrary {
  dir: string;
  root: string;
  runsDir: string;
  /** The sha256 of each version, by asset id, in stack order. */
  versions: Record<string, string[]>;
}

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A raster of noise, which PNG cannot compress. */
function noise(size: number): Raster {
  const r = createRaster(size, size);
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) setPixel(r, x, y, [next(), next(), next(), 255]);
  return r;
}

function strip(frames: number, size: number): Raster {
  const r = createRaster(frames * size, size);
  for (let f = 0; f < frames; f++) {
    const frame = drawSubject(size, f);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        setPixel(r, f * size + x, y, [
          frame.data[i]!,
          frame.data[i + 1]!,
          frame.data[i + 2]!,
          frame.data[i + 3]!,
        ]);
      }
  }
  return r;
}

interface AssetInput {
  id: string;
  folder?: string;
  kind: string;
  subject: string;
  bible: string;
  tags: string[];
  title: string;
  description?: string;
  body?: string;
  /** The working media's file name and bytes (the current version). */
  media: { name: string; bytes: Uint8Array };
  /** Earlier versions' sha256, oldest first. */
  earlier?: string[];
  /** The card's resource, when it differs from the media name. */
  resource?: string;
  /** Annotations to add after the versions. */
  annotate?: (record: ReviewRecord) => ReviewRecord;
}

const AT = (n: number) => `2026-11-${String(10 + n).padStart(2, "0")}T10:00:00Z`;

function writeAsset(root: string, input: AssetInput): string[] {
  const dir = join(root, input.folder ?? "");
  const mediaSha = sha256(input.media.bytes);
  write(join(dir, input.media.name), input.media.bytes);
  const provenance = {
    generator: input.kind,
    route: "scripted:test",
    models: ["test"],
    prompt: "a synthetic test asset",
    parameters: {},
    requestIds: [],
    referenceHashes: [],
    bibleVersion: input.bible,
    license: "MIT",
    providerTerms: [],
    startedAt: AT(0),
    finishedAt: AT(0),
    costUsd: 0.04,
    calls: [],
  };
  const provenanceName = `${input.media.name}.provenance.json`;
  write(join(dir, provenanceName), `${JSON.stringify(provenance, null, 2)}\n`);
  let review = emptyReview(`asset://${GAME}/${input.id}/review`);
  const shas = [...(input.earlier ?? []), mediaSha];
  shas.forEach((sha, i) => {
    review = appendVersion(review, {
      sha256: sha,
      at: AT(i + 1),
      run: RUN_ID,
      candidate: `c${i + 1}`,
      confirmation: { method: "headless", operator: "test:fixture" },
    });
    review = appendAnnotation(review, {
      type: "Annotation",
      created: AT(i + 1),
      motivation: "moderating",
      "ag:action": i === 0 ? "pick" : "replace",
      target: { source: input.media.name, "ag:version": sha },
    });
  });
  if (input.annotate) review = input.annotate(review);
  write(join(dir, `${input.id}.review.json`), writeReview(review));
  const fields = machineFields({
    resource: input.resource ?? input.media.name,
    provenance,
    provenanceResource: provenanceName,
    review,
    reviewResource: `${input.id}.review.json`,
    kind: input.kind,
    subject: input.subject,
    assetgrove: "0.2.0",
  });
  const card = newCard(
    {
      title: input.title,
      ...(input.description !== undefined && { description: input.description }),
      tags: input.tags,
      ...(input.body !== undefined && { body: input.body }),
    },
    fields,
  );
  write(join(dir, `${input.id}.md`), writeCard(card));
  return shas;
}

/** Builds the fixture library in a new temporary Git repository. */
export function fixtureLibrary(options: { bulk?: number } = {}): FixtureLibrary {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-tree-")));
  execFileSync("git", ["init", "-q", dir]);
  write(join(dir, ".assetgrove", "profile.json"), `${JSON.stringify(libraryProfile(), null, 2)}\n`);
  const root = join(dir, LIBRARY_ROOT);
  const runsDir = join(dir, ".assetgrove", "runs");
  const versions: Record<string, string[]> = {};

  // lantern: version 1's bytes only in a run folder.
  const lanternOld = encodePng(drawSubject(48, 3));
  const runDir = join(runsDir, RUN_ID);
  write(join(runDir, "c1.png"), lanternOld);
  write(
    join(runDir, "run.json"),
    `${JSON.stringify(
      {
        runId: RUN_ID,
        spec: { kind: "still", assetId: "lantern" },
        requested: 2,
        filtered: 1,
        spentUsd: 0.08,
        capUsd: 1,
        candidates: [
          {
            id: "c1",
            file: "c1.png",
            mediaType: "image/png",
            extension: "png",
            sha256: sha256(lanternOld),
            reasons: [
              { check: "alpha", passed: true, reason: "clean edges", source: "deterministic" },
            ],
            fields: {},
            provenance: { costUsd: 0.04 },
          },
        ],
        rejections: [
          {
            candidate: 2,
            reasons: [{ check: "alpha", passed: false, reason: "halo", source: "deterministic" }],
            costUsd: 0.04,
          },
        ],
        picked: { candidateId: "c1", at: AT(1), target: dir, files: [] },
      },
      null,
      2,
    )}\n`,
  );
  versions["lantern"] = writeAsset(root, {
    id: "lantern",
    kind: "still",
    subject: "lantern",
    bible: "3",
    tags: ["prop", "light"],
    title: "Porch lantern",
    description: "A brass lantern for the porch, lit.",
    body: "Used beside the front door.\n",
    media: { name: "lantern.png", bytes: encodePng(drawSubject(48)) },
    earlier: [sha256(lanternOld)],
  });
  versions["fern"] = writeAsset(root, {
    id: "fern",
    folder: "props",
    kind: "still",
    subject: "fern",
    bible: "2",
    tags: ["plant"],
    title: "Fern",
    media: { name: "fern.png", bytes: encodePng(drawSubject(32, 1)) },
  });
  versions["walk"] = writeAsset(root, {
    id: "walk",
    kind: "sprite-strip",
    subject: "fox",
    bible: "3",
    tags: ["character"],
    title: "Fox walk",
    media: { name: "walk.png", bytes: encodePng(strip(4, 32)) },
  });
  const glb = new TextEncoder().encode("glTF-synthetic-model");
  for (let v = 1; v <= 3; v++) {
    write(join(root, "boat-views", `view-${v}.png`), encodePng(drawSubject(64, v)));
  }
  versions["boat"] = writeAsset(root, {
    id: "boat",
    kind: "model-3d",
    subject: "boat",
    bible: "3",
    tags: ["prop"],
    title: "Boat",
    media: { name: "boat.glb", bytes: glb },
  });
  // rock: version 1 nowhere, version 2 only in the local LFS store, version 3 the working file.
  const rockLfs = encodePng(drawSubject(40, 2));
  const gitDir = join(dir, ".git");
  write(lfsObjectPath(gitDir, sha256(rockLfs)), rockLfs);
  versions["rock"] = writeAsset(root, {
    id: "rock",
    kind: "still",
    subject: "rock",
    bible: "3",
    tags: [],
    title: "Rock",
    media: { name: "rock.png", bytes: encodePng(drawSubject(40)) },
    earlier: [sha256("a version whose bytes are nowhere"), sha256(rockLfs)],
  });
  versions["big"] = writeAsset(root, {
    id: "big",
    kind: "still",
    subject: "noise",
    bible: "3",
    tags: [],
    title: "Big",
    media: { name: "big.png", bytes: encodePng(noise(1024)) },
  });
  versions["escape"] = writeAsset(root, {
    id: "escape",
    kind: "still",
    subject: "rock",
    bible: "3",
    tags: [],
    title: "Escape",
    media: { name: "escape.png", bytes: encodePng(drawSubject(16)) },
    resource: "../../outside.png",
  });
  write(join(dir, "outside.png"), encodePng(drawSubject(16)));
  for (let i = 0; i < (options.bulk ?? 0); i++) {
    const id = `bulk-${String(i).padStart(3, "0")}`;
    versions[id] = writeAsset(join(root, "bulk"), {
      id,
      kind: "still",
      subject: "pebble",
      bible: "3",
      tags: ["bulk"],
      title: `Pebble ${i}`,
      media: { name: `${id}.png`, bytes: encodePng(drawSubject(8, i % 4)) },
    });
  }
  write(
    join(root, "index.md"),
    `---\nokf_version: 0.2\ntype: Asset Library\ngame: ${GAME}\n---\n\n# ${GAME}\n\n## Assets\n\n- [Porch lantern](lantern.md): A brass lantern for the porch, lit.\n`,
  );
  return { dir, root, runsDir, versions };
}
