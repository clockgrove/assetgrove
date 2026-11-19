/**
 * `card describe` (#432): which cards get a model-written summary, the image view each is shown,
 * and the write of one summary. A card with a person's description or tags is never overwritten:
 * the state is checked when the work is planned and again under the library write lock.
 */
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { turntableViews } from "../compare.ts";
import { InputError } from "../errors.ts";
import { thumbnail } from "../tree/thumbs.ts";
import type { LoadedReference } from "../types.ts";
import { loadAsset, locateAsset, withLibraryLock, writeAsset } from "./actions.ts";
import type { AssetLocation, LoadedAsset } from "./actions.ts";
import { sha256Hex } from "./canonical.ts";
import { applySummary } from "./card.ts";
import { stalenessThumbnail } from "./stale.ts";
import { summaryEntry, summaryState } from "./summary.ts";
import type { CardSummary } from "./summary.ts";
import { scanCards } from "./write.ts";

/** One card to describe, with the image views its call is shown. */
export interface DescribeSubject {
  asset: string;
  location: AssetLocation;
  kind?: string;
  subject?: string;
  mediaSha256: string | null;
  images: LoadedReference[];
  baseline?: { description: string | null; labels: string[] };
  version?: string;
  mediaDigest?: string;
}

export interface Skipped {
  asset: string;
  reason: string;
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

/** The image views of an asset: an image's thumbnail, a `.glb`'s turntable renders. Empty when none. */
export async function describeViews(
  asset: LoadedAsset,
  traits?: Parameters<typeof stalenessThumbnail>[1],
): Promise<LoadedReference[]> {
  const data = asset.card.data;
  const sources = (Array.isArray(data["sources"]) ? data["sources"] : []) as {
    id?: string;
    resource?: string;
  }[];
  const provenance = sources.find((s) => s.id === "provenance")?.resource;
  if (extname(asset.mediaPath).toLowerCase() === ".glb") {
    let frames: string[];
    try {
      frames = turntableViews(asset.mediaPath);
    } catch {
      frames = [];
    }
    const views: LoadedReference[] = [];
    for (const frame of frames) {
      try {
        const png = thumbnail([new Uint8Array(readFileSync(frame))], "image", 1024 * 1024);
        if (png !== undefined)
          views.push({
            role: "view",
            path: frame,
            mediaType: "image/png",
            bytes: png,
            sha256: sha256Hex(png),
          });
      } catch {
        // An unreadable render is no view.
      }
    }
    return views;
  }
  const lock = data["lock"] as { sha256?: unknown } | undefined;
  return stalenessThumbnail(
    {
      asset: asset.assetId,
      media: asset.mediaPath,
      ...(provenance !== undefined && {
        provenance: resolve(asset.dir, provenance),
      }),
      sha256: String(lock?.sha256 ?? ""),
      from: "",
      tags: [],
      ...(text(data["kind"]) && { kind: text(data["kind"])! }),
    },
    traits,
  );
}

/** The cards that need a summary, and those skipped with the reason. */
export async function selectDescribed(
  input: { address?: string; missingIn?: string; propose?: boolean },
  traits?: Parameters<typeof stalenessThumbnail>[1],
): Promise<{ pending: DescribeSubject[]; skipped: Skipped[] }> {
  const pending: DescribeSubject[] = [];
  const skipped: Skipped[] = [];
  const consider = async (location: AssetLocation, missing: boolean) => {
    const asset = await loadAsset(location);
    if (missing && text(asset.card.data["description"]) !== undefined) return;
    const state = summaryState(asset.card.data);
    if (state.state === "person" && !input.propose) {
      skipped.push({ asset: asset.assetId, reason: state.reason });
      return;
    }
    let mediaDigest: string | undefined;
    if (input.propose) {
      try {
        mediaDigest = sha256Hex(readFileSync(asset.mediaPath));
      } catch {
        skipped.push({ asset: asset.assetId, reason: "no image view" });
        return;
      }
    }
    const images = await describeViews(asset, traits);
    if (input.propose) {
      try {
        if (sha256Hex(readFileSync(asset.mediaPath)) !== mediaDigest) {
          skipped.push({ asset: asset.assetId, reason: "media changed while preparing its views" });
          return;
        }
      } catch {
        skipped.push({ asset: asset.assetId, reason: "no image view" });
        return;
      }
    }
    if (images.length === 0) {
      skipped.push({ asset: asset.assetId, reason: "no image view" });
      return;
    }
    const lock = asset.card.data["lock"] as { sha256?: unknown } | undefined;
    pending.push({
      asset: asset.assetId,
      location,
      ...(text(asset.card.data["kind"]) && { kind: text(asset.card.data["kind"])! }),
      ...(text(asset.card.data["subject"]) && { subject: text(asset.card.data["subject"])! }),
      mediaSha256: typeof lock?.sha256 === "string" ? lock.sha256 : null,
      images,
      baseline: {
        description:
          typeof asset.card.data["description"] === "string"
            ? asset.card.data["description"]
            : null,
        labels: Array.isArray(asset.card.data["tags"]) ? (asset.card.data["tags"] as string[]) : [],
      },
      version: asset.record.versions.at(-1)!.sha256,
      mediaDigest: mediaDigest ?? "",
    });
  };
  if (input.address !== undefined) {
    await consider(locateAsset(input.address), false);
  } else if (input.missingIn !== undefined) {
    for (const found of scanCards(input.missingIn).sort((a, b) => a.id.localeCompare(b.id))) {
      let location: AssetLocation;
      try {
        location = locateAsset(`${found.dir}/${found.id}.md`);
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        skipped.push({ asset: found.id, reason: error.message });
        continue;
      }
      try {
        await consider(location, true);
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        skipped.push({ asset: found.id, reason: error.message });
      }
    }
  }
  return { pending, skipped };
}

/**
 * Writes one summary into the card under the library write lock, re-reading the card first: a
 * person's words written meanwhile (or, for `--missing`, any description) still win.
 */
export async function writeDescribed(
  subject: DescribeSubject,
  summary: CardSummary,
  model: string,
  stateDir: string,
  missing: boolean,
  now: () => Date = () => new Date(),
): Promise<{ files: string[] } | { skipped: string }> {
  return withLibraryLock(subject.location, stateDir, async () => {
    const asset = await loadAsset(subject.location);
    const state = summaryState(asset.card.data);
    if (state.state === "person") return { skipped: state.reason };
    if (missing && state.state !== "none") return { skipped: "it was described while this ran" };
    const entry = summaryEntry(summary, "vision", model, now().toISOString());
    const card = applySummary(asset.card, summary, entry, asset.cardPath);
    const written = await writeAsset({ ...asset, card }, asset.record, { card });
    return { files: written.files };
  });
}
