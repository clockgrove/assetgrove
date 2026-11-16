/**
 * Whether a provenance file is the record of the media it is named with (docs/decisions.md,
 * "Provenance is bound to its media"). Every record Assetgrove writes beside media carries
 * `binding`: the sha256 of the exact bytes it describes and the sha256 of its own canonical content
 * without `binding`. Each writer binds again after it writes the bytes (hand-off after the mark and
 * the content credentials), so the binding holds across that rewrite and a later hand-off.
 *
 * A record without a binding is accepted only when the asset's library review record beside the
 * media lists these bytes with this file's sha256 (a 0.1.0 hand-off), when the run record beside
 * the media stages these bytes with this record (a staged candidate), or as media made outside
 * Assetgrove: no calls, and no model named in the media's own mark. Anything else is refused.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { InputError } from "./errors.ts";
import { canonicalJson, sha256Hex } from "./library/canonical.ts";
import { parseReview } from "./library/review.ts";
import { readRun } from "./loop.ts";
import type { RunRecord } from "./loop.ts";
import { readMarkedModels } from "./metadata.ts";
import type { Provenance, ProvenanceBinding } from "./types.ts";

/** A provenance file that is not the record of the media it is named with: exit 2. */
export class ProvenanceError extends InputError {
  readonly code = "provenance_mismatch";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProvenanceError";
  }
}

/** The sha256 of a record's canonical JSON without its `binding`. */
export function recordSha256(record: Provenance): string {
  const { binding: _binding, ...rest } = record;
  void _binding;
  // Through JSON first, so the digest is of what the file holds.
  return sha256Hex(canonicalJson(JSON.parse(JSON.stringify(rest))));
}

/** The binding of a record to the media bytes it describes. */
export function bindingOf(record: Provenance, bytes: Uint8Array): ProvenanceBinding {
  return { mediaSha256: sha256Hex(bytes), recordSha256: recordSha256(record) };
}

/** The record bound to `bytes`, with any earlier binding replaced. */
export function bindProvenance<T extends Provenance>(record: T, bytes: Uint8Array): T {
  const { binding: _stale, ...rest } = record;
  void _stale;
  return { ...rest, binding: bindingOf(rest as T, bytes) } as T;
}

export interface NamedProvenance {
  /** The media as given: its path, bytes and media type. */
  media: { path: string; bytes: Uint8Array; mediaType: string };
  /** The provenance file as given: its path, bytes and parsed value. */
  provenance: { path: string; bytes: Uint8Array | string; value: Provenance };
}

/**
 * The record, checked as the record of the media: a bound record whose digests hold, a 0.1.0
 * record the library vouches for, or media made outside Assetgrove (returned with
 * `madeOutsideAssetgrove: true`). Throws a ProvenanceError naming both files otherwise.
 */
export async function checkProvenance(named: NamedProvenance): Promise<Provenance> {
  const { media, provenance } = named;
  const record = provenance.value;
  const refuse = (why: string) =>
    new ProvenanceError(
      `refused: ${provenance.path} is not the provenance of ${media.path}: ${why}. ` +
        "Give the media with the provenance file Assetgrove wrote beside it",
    );
  const binding = record.binding as Partial<ProvenanceBinding> | undefined;
  if (binding !== undefined) {
    if (
      typeof binding !== "object" ||
      binding === null ||
      typeof binding.mediaSha256 !== "string" ||
      typeof binding.recordSha256 !== "string"
    ) {
      throw refuse("its binding is not a media and a record sha256");
    }
    if (binding.recordSha256 !== recordSha256(record)) {
      throw refuse("the record was changed after it was written (its recordSha256 does not hold)");
    }
    if (binding.mediaSha256 !== sha256Hex(media.bytes)) {
      throw refuse("it records other bytes (its mediaSha256 is not the media's sha256)");
    }
    return record;
  }
  if (await libraryVouches(media.path, media.bytes, provenance.bytes)) return record;
  if (await runVouches(media.path, media.bytes, record)) return record;
  const calls = Array.isArray(record.calls) ? record.calls : [];
  if (calls.length > 0) {
    throw refuse(
      `it records ${calls.length} model call${calls.length === 1 ? "" : "s"} but is not bound to the media, ` +
        "and neither a library review record nor a run record beside the media lists these bytes with this record",
    );
  }
  const marked = markedModels(media.bytes, media.mediaType);
  if (marked !== undefined) {
    throw refuse(
      `it records no model call, but the media's own mark names the model${marked.includes(",") ? "s" : ""} ${marked}`,
    );
  }
  return { ...record, madeOutsideAssetgrove: true };
}

function markedModels(bytes: Uint8Array, mediaType: string): string | undefined {
  try {
    return readMarkedModels(bytes, mediaType);
  } catch {
    return undefined;
  }
}

/**
 * Whether a library review record in the media's folder lists a version with exactly these media
 * bytes and this provenance file's bytes: what a 0.1.0 hand-off recorded.
 */
async function libraryVouches(
  mediaPath: string,
  mediaBytes: Uint8Array,
  provenanceBytes: Uint8Array | string,
): Promise<boolean> {
  const dir = dirname(mediaPath);
  const names = await readdir(dir).catch(() => [] as string[]);
  const media = sha256Hex(mediaBytes);
  const own = sha256Hex(provenanceBytes);
  for (const name of names.filter((n) => n.endsWith(".review.json"))) {
    const source = join(dir, name);
    try {
      const review = parseReview(await readFile(source, "utf8"), source);
      if (review.versions.some((v) => v.sha256 === media && v.provenanceSha256 === own)) {
        return true;
      }
    } catch {
      // Not a review record this check can read: it vouches for nothing.
    }
  }
  return false;
}

/**
 * Whether the run record of the media's folder stages a candidate with exactly these bytes and
 * exactly this record: a staged candidate given by its file, with its provenance copied out.
 */
async function runVouches(
  mediaPath: string,
  mediaBytes: Uint8Array,
  record: Provenance,
): Promise<boolean> {
  let run: RunRecord;
  try {
    run = await readRun(dirname(mediaPath));
  } catch {
    return false;
  }
  const media = sha256Hex(mediaBytes);
  const own = canonicalJson(JSON.parse(JSON.stringify(record)));
  return (Array.isArray(run.candidates) ? run.candidates : []).some(
    (c) =>
      c?.sha256 === media &&
      c.provenance !== undefined &&
      canonicalJson(JSON.parse(JSON.stringify(c.provenance))) === own,
  );
}

/**
 * Reads a provenance file named with media and checks it is that media's record
 * (`checkProvenance`). Throws an InputError when it is not JSON.
 */
export async function readNamedProvenance(
  provenancePath: string,
  media: NamedProvenance["media"],
): Promise<Provenance> {
  let bytes: Buffer;
  let value: unknown;
  try {
    bytes = await readFile(provenancePath);
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new InputError(`the provenance file ${provenancePath} cannot be read as JSON`);
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as Provenance).calls)) {
    throw new InputError(
      `the provenance file ${provenancePath} is not an Assetgrove provenance record`,
    );
  }
  return checkProvenance({
    media,
    provenance: { path: provenancePath, bytes, value: value as Provenance },
  });
}
