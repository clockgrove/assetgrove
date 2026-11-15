/**
 * The mark check of a hand-off (design section 6): each preset's check reads the AI mark back from
 * every written file whose format can carry it, the atlas images included, and names each file
 * that lacks it. The mark is the IPTC digital source type and, when provenance names models, the
 * models. Formats that cannot carry a mark are not checked; the record (provenance and the card)
 * still holds the source type for them.
 */
import { extname } from "node:path";
import { modelText, readDigitalSourceType, readMarkedModels } from "../metadata.ts";
import type { DigitalSourceType } from "../metadata.ts";

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".ktx2": "image/ktx2",
};

/** The media type of a path in a format that can carry the mark, by its extension. */
export function markableMediaType(path: string): string | undefined {
  return MEDIA_TYPES[extname(path).toLowerCase()];
}

/** Whether a media type names a format that can carry the mark. */
export function canCarryMark(mediaType: string): boolean {
  return Object.values(MEDIA_TYPES).includes(mediaType);
}

/** What a written file's mark must say. */
export interface ExpectedMark {
  digitalSourceType: DigitalSourceType;
  models: readonly string[];
}

/** The problems with one written file's mark; empty when it carries it. */
export function markProblems(
  path: string,
  bytes: Uint8Array | undefined,
  mediaType: string,
  expected: ExpectedMark,
): string[] {
  if (bytes === undefined || expected.digitalSourceType === "undeclared") return [];
  let source: DigitalSourceType | undefined;
  let models: string | undefined;
  try {
    source = readDigitalSourceType(bytes, mediaType);
    models = readMarkedModels(bytes, mediaType);
  } catch {
    return [`${path} is not a readable ${mediaType} file, so its AI mark cannot be read`];
  }
  if (source === undefined) return [`${path} lacks the AI mark (the IPTC digital source type)`];
  if (source !== expected.digitalSourceType)
    return [`${path} marks source type ${source}, expected ${expected.digitalSourceType}`];
  const wanted = modelText(expected.models);
  if (wanted !== undefined && models !== wanted)
    return [`${path} lacks the provenance's models in its AI mark`];
  return [];
}
