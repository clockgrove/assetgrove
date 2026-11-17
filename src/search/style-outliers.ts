/**
 * Which members of a set are drawn in a different style (#366, design section 7.5). The search
 * slot ranks every member by its image's mean distance to the rest, free and uncut; that distance
 * tracks subject and pose as much as style, so it is never the verdict. For the most distant
 * members core makes one Boolean `style-outlier` decision each, shown the member's image, a
 * contact sheet of the set's typical (least distant) members and the bible's style text: is this
 * image drawn in a different art style from the rest? `find --outliers` lists the yes answers.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { doDontSection, splitFrontMatter } from "../bible.ts";
import type { Caller } from "../calls.ts";
import { renderContact } from "../contact.ts";
import { ProviderError } from "../errors.ts";
import type { SearchRankedMember } from "../extension/api.ts";
import { decodeImage, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { sha256Hex } from "../library/canonical.ts";
import { STYLE_OUTLIER_OPERATION } from "../routes.ts";
import { thumbnail } from "../tree/thumbs.ts";
import type { LoadedReference } from "../types.ts";

/** The most members of a ranking that are asked about. */
export const JUDGED = 5;
/** The most typical members the contact sheet shows. */
export const TYPICAL = 8;
/** A ranking shorter than this is not judged. */
const MIN_RANKED = 3;

/**
 * The members asked about and the typical members shown beside them: the first min(5, n − 1) of
 * the ranking, and the last min(8, n − asked), so at least one typical member is always shown.
 * Nothing for a ranking under three members.
 */
export function selectMembers(ranking: readonly SearchRankedMember[]): {
  judged: SearchRankedMember[];
  typical: SearchRankedMember[];
} {
  if (ranking.length < MIN_RANKED) return { judged: [], typical: [] };
  const asked = Math.min(JUDGED, ranking.length - 1);
  const shown = Math.min(TYPICAL, ranking.length - asked);
  return {
    judged: ranking.slice(0, asked),
    typical: ranking.slice(ranking.length - shown).reverse(),
  };
}

/**
 * The bible's style text: its world, its style axes and its Do's and Don'ts, read leniently from
 * a Markdown (front matter) or JSON bible. Empty when there is no bible or it cannot be read.
 */
export function bibleStyleText(path: string): string {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  let data: Record<string, unknown>;
  let prose = "";
  try {
    if (extname(path).toLowerCase() === ".json")
      data = JSON.parse(source) as Record<string, unknown>;
    else {
      const split = splitFrontMatter(source);
      data = (parseYaml(split.front) as Record<string, unknown> | null) ?? {};
      prose = split.prose;
    }
  } catch {
    data = {};
  }
  const lines: string[] = [];
  if (typeof data["world"] === "string" && data["world"].trim() !== "")
    lines.push(`World: ${data["world"].trim()}`);
  const axes = data["axes"];
  if (axes !== null && typeof axes === "object")
    for (const [key, value] of Object.entries(axes as Record<string, unknown>))
      lines.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  const rules = doDontSection(prose);
  if (rules !== "") lines.push(`Do's and Don'ts:\n${rules}`);
  return lines.join("\n");
}

/** The member's image as the call is shown it: a PNG of at most 512 px; undefined when it does not decode. */
export function memberImage(bytes: Uint8Array, path: string): LoadedReference | undefined {
  const png = thumbnail([bytes], "image", 4 * 1024 * 1024);
  if (png === undefined) return undefined;
  return { role: "candidate", path, mediaType: "image/png", bytes: png, sha256: sha256Hex(png) };
}

/**
 * The contact sheet of the typical members: one numbered row of their images, least distant first,
 * and how many it shows. Undefined when none decodes.
 */
export function typicalSheet(
  images: readonly Uint8Array[],
): { sheet: LoadedReference; count: number } | undefined {
  const rasters: Raster[] = [];
  for (const bytes of images) {
    try {
      rasters.push(decodeImage(bytes));
    } catch {
      // A typical member whose image does not decode is left off the sheet.
    }
  }
  if (rasters.length === 0) return undefined;
  const png = encodePng(renderContact([{ number: 1, images: rasters }], []).raster);
  return {
    sheet: {
      role: "reference",
      path: "typical-members.png",
      mediaType: "image/png",
      bytes: png,
      sha256: sha256Hex(png),
    },
    count: rasters.length,
  };
}

/** What one judgement of a ranking needs: the calls to make, the sheet they share, what is skipped. */
export interface StyleOutlierWork {
  /** The members asked about, each with the image the call is shown. */
  pending: { member: SearchRankedMember; image: LoadedReference }[];
  /** The typical members' addresses, least distant first. */
  typical: string[];
  /** The contact sheet of the typical members, and how many it shows. */
  sheet?: { sheet: LoadedReference; count: number };
  /** Members asked about whose image is not on this machine, or with no typical member to show. */
  notJudged: string[];
}

/**
 * The calls a ranking takes (`selectMembers`), given each member's image bytes by address. A
 * member with no decodable image here (a Git LFS pointer, not an image), or a set whose typical
 * members show nothing, is not judged.
 */
export function styleOutlierWork(
  ranking: readonly SearchRankedMember[],
  imageOf: (address: string) => { bytes: Uint8Array; path: string } | undefined,
): StyleOutlierWork {
  const { judged, typical } = selectMembers(ranking);
  const sheet = typicalSheet(
    typical.flatMap((m) => {
      const image = imageOf(m.address);
      return image ? [image.bytes] : [];
    }),
  );
  const pending: StyleOutlierWork["pending"] = [];
  const notJudged: string[] = [];
  for (const member of judged) {
    const image = imageOf(member.address);
    const shown = image && memberImage(image.bytes, image.path);
    if (shown === undefined || sheet === undefined) notJudged.push(member.address);
    else pending.push({ member, image: shown });
  }
  return {
    pending,
    typical: typical.map((m) => m.address),
    ...(sheet && { sheet }),
    notJudged,
  };
}

/** The text the style-outlier call is given. */
export function styleOutlierPrompt(style: string, typical: number): string {
  return [
    "A game's asset library holds a set of images meant to share one art style.",
    `The first image is one member of the set. The second image is a contact sheet of ${typical} typical members of the same set, in one row.`,
    style.trim() === ""
      ? "The game has no style bible text to go by: judge against the typical members alone."
      : `The game's style bible describes its art style:\n${style}`,
  ].join("\n");
}

/** The Boolean question the style-outlier call answers. */
export const STYLE_OUTLIER_QUESTION = {
  type: "boolean",
  instructions: `Is the first image drawn in a different art style from the rest of the set? Judge only the drawing style: rendering, line and outline, shading, palette treatment, texture and detail density. A different subject, pose, frame or colour of the same style is not a different style. Answer true only when the first image would not pass as drawn by the same hand and process as the typical members.`,
  whenTrue: "the image is drawn in a different art style from the rest of the set",
  whenFalse: "the image is drawn in the same art style as the rest of the set",
} as const;

/** One member's answer. */
export interface StyleAnswer {
  address: string;
  distance: number;
  /** True when the call answered that the member is drawn in another style. */
  differentStyle: boolean;
  probability: number;
  model: string;
}

/** One `style-outlier` decision through the caller: inside the run's budget and journal. */
export async function judgeStyleOutlier(
  caller: Caller,
  member: SearchRankedMember,
  image: LoadedReference,
  sheet: LoadedReference,
  typical: number,
  style: string,
): Promise<StyleAnswer> {
  const { result, record } = await caller.decide(
    STYLE_OUTLIER_OPERATION,
    styleOutlierPrompt(style, typical),
    [image, sheet],
    { ...STYLE_OUTLIER_QUESTION },
  );
  if (result.answer.type !== "boolean")
    throw new ProviderError(`the ${STYLE_OUTLIER_OPERATION} decision gave no Boolean answer`);
  const probability = result.answer.probability;
  return {
    address: member.address,
    distance: member.distance,
    differentStyle: probability >= 0.5,
    probability: Math.round(probability * 1e4) / 1e4,
    model: record.model,
  };
}
