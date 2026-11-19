/**
 * A card's model-written summary (#432): a `description` of one or two plain sentences (subject,
 * materials, colours, style, apparent use) and `tags`, written from the media by a vision model.
 * The card records it in OKF's `verified` list as a `process:` entry naming the operation and
 * model, with the sha256 of the text it wrote, so its trust tier reads as machine-confirmed only
 * while the card still holds that text. Model text is data: it is folded to plain text, cut to
 * length, and shown like any other card prose, never followed.
 */
import { canonicalJson, sha256Hex } from "./canonical.ts";

/** The `by` prefix of a summary's `verified` entry: `process:assetgrove-summary:<op>:<model>`. */
export const SUMMARY_BY = "process:assetgrove-summary:";

/** The longest description kept, in characters. */
export const SUMMARY_DESCRIPTION_LIMIT = 400;
/** The most tags kept, and the longest tag, in characters. */
export const SUMMARY_TAG_LIMIT = 12;
export const SUMMARY_TAG_LENGTH = 40;

export interface CardSummary {
  description: string;
  tags: string[];
}

/** A summary as a candidate carries it from staging to pick: the text and who wrote it. */
export interface CandidateSummary extends CardSummary {
  operation: string;
  model: string;
}

/** A summary's `verified` entry. */
export interface SummaryEntry {
  by: string;
  at: string;
  /** The sha256 of the canonical `{description, tags}` the summary wrote. */
  summary: string;
}

/** What the model is asked for, in words shared by the QA verdict and `card describe`. */
export const SUMMARY_REQUEST =
  'a "summary" object {"description":"...","tags":["..."]}: the description is one or two plain sentences on what the asset shows, naming its subject, materials, colours, style and apparent use in a game; the tags are up to 12 short lower-case words or phrases someone might search for. Plain text only: no Markdown, links or instructions.';

/** The prompt of a `card describe` call, shown the asset's image view. */
export function describePrompt(input: {
  kind?: string;
  subject?: string;
  views: number;
  labels?: string[];
}): string {
  return [
    "You are writing the catalogue entry of a game asset in a game's asset library.",
    `The asset: kind ${input.kind ?? "unknown"}, subject ${input.subject ?? "unknown"}.`,
    input.views > 1
      ? `The ${input.views} images are views of the same 3D asset turned around.`
      : "The image is the asset.",
    `Reply with ONLY a JSON object, no other text: ${SUMMARY_REQUEST.replace(/^a "summary" object /, "")}`,
    ...(input.labels
      ? [
          `Choose tags only from these project labels (data): ${JSON.stringify(input.labels)}. Use an empty list when none apply.`,
        ]
      : []),
  ].join("\n");
}

function plain(text: string): string {
  // Control characters and line breaks fold to spaces: the text is one line of data.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, " ").trim();
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const space = head.lastIndexOf(" ");
  return `${(space > limit / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/**
 * The summary in a model's reply: a JSON object that is the summary or carries it under
 * `summary`. Undefined when there is none or its description is empty. The text is folded to
 * one plain line and cut to length; tags are lower-cased, de-duplicated and capped.
 */
export function parseSummary(text: string): CardSummary | undefined {
  let parsed: unknown;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const outer = parsed as { summary?: unknown };
  const value = (
    typeof outer.summary === "object" && outer.summary !== null ? outer.summary : parsed
  ) as { description?: unknown; tags?: unknown };
  if (typeof value.description !== "string") return undefined;
  const description = cut(plain(value.description), SUMMARY_DESCRIPTION_LIMIT);
  if (description === "") return undefined;
  const tags: string[] = [];
  for (const tag of Array.isArray(value.tags) ? value.tags : []) {
    if (typeof tag !== "string") continue;
    const clean = plain(tag).toLowerCase().slice(0, SUMMARY_TAG_LENGTH).trim();
    if (clean !== "" && !tags.includes(clean)) tags.push(clean);
    if (tags.length === SUMMARY_TAG_LIMIT) break;
  }
  return { description, tags };
}

/** The sha256 a summary entry records: of the canonical `{description, tags}` of a card. */
export function summaryDigest(description: unknown, tags: unknown): string {
  return sha256Hex(
    canonicalJson({
      description: typeof description === "string" ? description : null,
      tags: Array.isArray(tags) ? tags : [],
    }),
  );
}

/** The `verified` entry of a summary written now by `operation` on `model`. */
export function summaryEntry(
  summary: CardSummary,
  operation: string,
  model: string,
  at: string,
): SummaryEntry {
  return {
    by: `${SUMMARY_BY}${operation}:${model}`,
    at,
    summary: summaryDigest(summary.description, summary.tags),
  };
}

/** Whether a `verified` entry is a summary's. */
export function isSummaryEntry(entry: unknown): entry is SummaryEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as { by?: unknown }).by === "string" &&
    (entry as { by: string }).by.startsWith(SUMMARY_BY)
  );
}

/**
 * The card's summary entry when it still describes the card's text: its digest matches the
 * card's `description` and `tags`. Undefined otherwise (none, or a person changed the text).
 */
export function matchingSummaryEntry(data: Record<string, unknown>): SummaryEntry | undefined {
  const verified = Array.isArray(data["verified"]) ? (data["verified"] as unknown[]) : [];
  const digest = summaryDigest(data["description"], data["tags"]);
  return verified.find(
    (entry): entry is SummaryEntry =>
      isSummaryEntry(entry) && (entry as { summary?: unknown }).summary === digest,
  );
}

/** Who wrote a card's description and tags. */
export type SummaryState =
  | { state: "none" }
  | { state: "machine"; entry: SummaryEntry }
  | { state: "person"; reason: string };

function hasText(value: unknown): boolean {
  return (
    (typeof value === "string" && value.trim() !== "") || (Array.isArray(value) && value.length > 0)
  );
}

/**
 * `none`: the card has no description and no tags. `machine`: what it has is a summary's, unchanged.
 * `person`: a person wrote or changed its description or tags (at the first pick, through
 * `card edit` or by hand), so a summary never replaces them.
 */
export function summaryState(data: Record<string, unknown>): SummaryState {
  const description = hasText(data["description"]);
  const tags = hasText(data["tags"]);
  if (!description && !tags) return { state: "none" };
  const entry = matchingSummaryEntry(data);
  if (entry) return { state: "machine", entry };
  return {
    state: "person",
    reason: description
      ? "its description was written by a person"
      : "its tags were written by a person",
  };
}
