/**
 * Whether a provenance file is the record of the media it is named with (docs/decisions.md,
 * "Provenance is bound to its media"). The file cannot vouch for itself, so the evidence outside it
 * is read first: the sha256 of the record's calls in the media's own mark, the library review record
 * beside the media and the run record beside it. Each that speaks must agree, and one that names
 * this exact record accepts it. The record's own `binding` (the sha256 of the exact bytes it
 * describes and of its canonical content) must hold when present.
 *
 * A record that nothing outside the file names is accepted only when it is bound (and its calls
 * name each model the media's mark names), or when it records no call and the mark neither names a
 * model nor says a model made the media (its digital source type): media made outside Assetgrove. An unbound record with calls, such as one 0.1.0 wrote, is refused
 * with the one command that hands its media off again.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { InputError } from "./errors.ts";
import { canonicalJson, sha256Hex } from "./library/canonical.ts";
import { parseReview } from "./library/review.ts";
import { readRun } from "./loop.ts";
import type { RunRecord } from "./loop.ts";
import {
  DIGITAL_SOURCE_TYPES,
  readDigitalSourceType,
  readMarkedCallsSha256,
  readMarkedModels,
} from "./metadata.ts";
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

/** The sha256 of a record's calls, which the media's mark carries (MarkOptions.callsSha256). */
export function callsSha256(record: Pick<Provenance, "calls">): string {
  const calls = Array.isArray(record.calls) ? record.calls : [];
  return sha256Hex(canonicalJson(JSON.parse(JSON.stringify(calls))));
}

/**
 * The record, checked as the record of the media against the evidence outside the file (the
 * media's mark, and the library review record and run record beside the media) and against its
 * own binding. Returns the record (for a staged candidate given by its `--json` view, the run
 * record's own copy), with `madeOutsideAssetgrove: true` when it records no call and nothing says
 * a model made the media. Throws a ProvenanceError naming both files otherwise.
 */
export async function checkProvenance(named: NamedProvenance): Promise<Provenance> {
  const { media, provenance } = named;
  const record = provenance.value;
  const refuse = (why: string, next?: string) =>
    new ProvenanceError(
      `refused: ${provenance.path} is not the provenance of ${media.path}: ${why}. ` +
        (next ??
          "Give the media with the provenance file Assetgrove wrote beside it; for a staged " +
            "candidate, its record in the run.json beside it (or the stage --json document's)"),
    );
  const calls = Array.isArray(record.calls) ? record.calls : [];
  const callCount = `${calls.length} model call${calls.length === 1 ? "" : "s"}`;

  // The media's own mark: the calls sha256 a hand-off or fix-frame wrote.
  const markedCalls = markRead(() => readMarkedCallsSha256(media.bytes, media.mediaType));
  if (markedCalls !== undefined && markedCalls !== callsSha256(record)) {
    throw refuse(
      `its ${callCount} are not the calls the media's own mark records (its calls sha256 differs)`,
    );
  }

  // The library review record beside the media, when it lists these bytes with a provenance.
  const library = await libraryListing(media.path, media.bytes, provenance.bytes);
  if (library === "other") {
    throw refuse(
      "the library review record beside the media lists these bytes with another provenance file",
    );
  }
  // The run record beside the media, when it stages these bytes.
  const run = await runListing(media.path, media.bytes, record);
  if (run === "other") {
    throw refuse("the run record beside the media stages these bytes with another record");
  }

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
  }
  const own = run === undefined || run === "same" ? record : run.record;

  // Evidence outside the file that names this exact record: it answers first.
  if (markedCalls !== undefined || library === "same" || run !== undefined) return own;

  // Else the mark's model names (all a 0.1.0 mark carries) are each a call's model, or the tool
  // of the sheet an imported strip came from (src/sheet/import.ts).
  const marked = markRead(() => readMarkedModels(media.bytes, media.mediaType));
  const allowed = new Set<unknown>(calls.map((c) => (c as { model?: unknown })?.model));
  const tool = (record.sheet as { tool?: unknown } | undefined)?.tool;
  if (typeof tool === "string") allowed.add(tool);
  const names = (marked ?? "")
    .split(";")
    .map((m) => m.trim())
    .filter((m) => m !== "");
  const missing = names.filter((m) => !allowed.has(m));
  const plural = (n: string[]) => (n.length === 1 ? "" : "s");

  if (binding === undefined) {
    // The digital source type is all the mark of a 0.1.0 hand-off or a staged candidate carries.
    const source = markRead(() => readDigitalSourceType(media.bytes, media.mediaType));
    const modelMade = MODEL_MADE.has(source ?? "");
    // No call, no binding, and nothing outside the file says a model made the media.
    if (calls.length === 0 && names.length === 0 && !modelMade) {
      return { ...own, madeOutsideAssetgrove: true };
    }
    // Unbound, and nothing outside the file vouches for it: a record 0.1.0 wrote, or a staged
    // record moved out of its run. Its contents are not taken as written.
    throw refuse(
      calls.length === 0
        ? names.length > 0
          ? `it records no model call and no binding, but the media's own mark names the model${plural(names)} ${names.join(", ")}`
          : `it records no model call and no binding, but the media's own mark says a model made it (its digital source type is ${source})`
        : `it records ${callCount} but is not bound to the media, and nothing beside the media (its mark's calls sha256, a library review record or a run record) vouches for it`,
      `Hand the media off again so its record is written and bound: ${upToDateCommand(record)}`,
    );
  }
  if (missing.length > 0) {
    throw refuse(
      calls.length === 0
        ? `it records no model call, but the media's own mark names the model${plural(missing)} ${missing.join(", ")}`
        : `its calls do not name the model${plural(missing)} ${missing.join(", ")} that the media's own mark names`,
    );
  }
  return own;
}

/** The digital source types Assetgrove marks on media a model made, in whole or in part. */
const MODEL_MADE = new Set<string>([
  DIGITAL_SOURCE_TYPES.generated,
  DIGITAL_SOURCE_TYPES.composite,
]);

/**
 * The one command that hands the media of an unbound record off again, so its record is written
 * and bound (docs/decisions.md, "Provenance is bound to its media").
 */
export function upToDateCommand(record: Pick<Provenance, "generator">): string {
  if (record.generator === "sheet-import") {
    return "assetgrove write-families --import <import> --target <target>, from the import that made the strip";
  }
  if (record.generator === "frame-fix") {
    return "assetgrove fix-frame on the strip it fixed, with that strip's own provenance";
  }
  return "assetgrove pick --run <run> --candidate <id> --target <target>, from the run that made it";
}

function markRead(read: () => string | undefined): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * What the library review records in the media's folder say of these bytes: "same" when a version
 * lists them with this provenance file's sha256, "other" when versions list them only with other
 * provenance, undefined when none lists them with a provenance.
 */
async function libraryListing(
  mediaPath: string,
  mediaBytes: Uint8Array,
  provenanceBytes: Uint8Array | string,
): Promise<"same" | "other" | undefined> {
  const dir = dirname(mediaPath);
  const names = await readdir(dir).catch(() => [] as string[]);
  const media = sha256Hex(mediaBytes);
  const own = sha256Hex(provenanceBytes);
  let listed: "same" | "other" | undefined;
  for (const name of names.filter((n) => n.endsWith(".review.json"))) {
    const source = join(dir, name);
    try {
      const review = parseReview(await readFile(source, "utf8"), source);
      for (const v of review.versions) {
        if (v.sha256 !== media || v.provenanceSha256 === undefined) continue;
        if (v.provenanceSha256 === own) return "same";
        listed = "other";
      }
    } catch {
      // Not a review record this check can read: it says nothing.
    }
  }
  return listed;
}

/**
 * What the run record of the media's folder says of these bytes: "same" when a candidate stages
 * them with exactly this record, the candidate's own record when this is that record's `--json`
 * view (shared text masked as `[sharedText:<n>]`), "other" when candidates stage them only with
 * other records, undefined when none stages them.
 */
async function runListing(
  mediaPath: string,
  mediaBytes: Uint8Array,
  record: Provenance,
): Promise<"same" | "other" | { record: Provenance } | undefined> {
  let run: RunRecord;
  try {
    run = await readRun(dirname(mediaPath));
  } catch {
    return undefined;
  }
  const media = sha256Hex(mediaBytes);
  const given = plain(record);
  let listed: "other" | { record: Provenance } | undefined;
  for (const c of Array.isArray(run.candidates) ? run.candidates : []) {
    if (c?.sha256 !== media || c.provenance === undefined) continue;
    const staged = plain(c.provenance);
    if (canonicalJson(staged) === canonicalJson(given)) return "same";
    if (maskedView(given, staged, new Map())) listed = { record: c.provenance };
    else listed ??= "other";
  }
  return listed;
}

/** The record as its file holds it, without its binding. */
function plain(record: Provenance): unknown {
  const { binding: _binding, ...rest } = record;
  void _binding;
  return JSON.parse(JSON.stringify(rest));
}

const SHARED_SLOT = /\[sharedText:(\d+)\]/g;

/**
 * Whether `view` is `actual` with shared text masked (src/request.ts, withSharedText): equal but
 * that a string may hold `[sharedText:<n>]` where `actual` holds a text, the same text for each n.
 */
function maskedView(view: unknown, actual: unknown, slots: Map<string, string>): boolean {
  if (typeof view === "string" && typeof actual === "string") {
    if (view === actual) return true;
    const names: string[] = [];
    const pattern = view
      .split(SHARED_SLOT)
      .map((part, i) => {
        if (i % 2 === 0) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        names.push(part);
        return "([\\s\\S]+?)";
      })
      .join("");
    if (names.length === 0) return false;
    const match = new RegExp(`^${pattern}$`).exec(actual);
    if (!match) return false;
    return names.every((n, i) => {
      const text = match[i + 1]!;
      const known = slots.get(n);
      if (known !== undefined) return known === text;
      slots.set(n, text);
      return true;
    });
  }
  if (Array.isArray(view) && Array.isArray(actual)) {
    return view.length === actual.length && view.every((v, i) => maskedView(v, actual[i], slots));
  }
  if (view && actual && typeof view === "object" && typeof actual === "object") {
    if (Array.isArray(view) || Array.isArray(actual)) return false;
    const a = view as Record<string, unknown>;
    const b = actual as Record<string, unknown>;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => Object.hasOwn(b, k) && maskedView(a[k], b[k], slots));
  }
  return view === actual;
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
