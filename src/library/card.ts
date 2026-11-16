/**
 * Cards: `<assetId>.md` beside the media, YAML front matter plus a Markdown body. Assetgrove owns
 * the machine fields and rewrites them from the provenance and review records; the person fields,
 * unknown fields, comments and the body are kept. A parsed card holds the front matter as raw
 * top-level entries, so writing it again is byte-identical and a rewrite touches only the entries
 * it replaces.
 */
import { Document, isMap, isSeq, parse as parseYaml, parseDocument, type Node } from "yaml";
import { z } from "zod";
import { splitFrontMatter } from "../bible.ts";
import { InputError } from "../errors.ts";
import { readFormat } from "../formats.ts";
import type { Provenance } from "../types.ts";
import { LIBRARY_FORMATS, currentVersion, versionNumber, versionStatus } from "./review.ts";
import type { ReviewRecord } from "./review.ts";
import { libraryPath } from "./paths.ts";

/** The fields Assetgrove writes, in the order a card lists them. */
export const MACHINE_FIELDS = [
  "type",
  "format",
  "resource",
  "generated",
  "verified",
  "sources",
  "kind",
  "subject",
  "state",
  "version",
  "bible",
  "license",
  "lock",
] as const;

/** The fields a person edits; any other key is kept as written. */
export const PERSON_FIELDS = ["title", "description", "tags"] as const;

const MACHINE = new Set<string>(MACHINE_FIELDS);

export interface CardEntry {
  key: string;
  /** The entry's raw lines; every entry but the last ends with the newline. */
  text: string;
}

export interface Card {
  /** Comment and blank lines before the first key. */
  preamble: string;
  entries: CardEntry[];
  body: string;
  /** The parsed front matter. */
  data: Record<string, unknown>;
  newline: string;
  /** The opening `---` line, with its newline. */
  open: string;
  /** The closing `---` line, with the newline before it and any after it. */
  close: string;
}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "must be a 64-hex sha256");
const nonEmpty = z.string().min(1);

const cardSchema = z.looseObject({
  type: z.literal("Game Asset"),
  format: z.string(),
  title: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  resource: nonEmpty,
  generated: z.looseObject({ by: z.string(), at: z.string() }).optional(),
  verified: z
    .array(z.looseObject({ by: z.string(), at: z.string(), method: z.string().optional() }))
    .optional(),
  sources: z.array(z.looseObject({ id: z.string(), resource: nonEmpty })).optional(),
  kind: z.string().optional(),
  subject: z.string().optional(),
  state: z.enum(["approved", "rejected", "changes-requested", "pending"]).optional(),
  version: z.number().int().positive().optional(),
  bible: z.string().optional(),
  license: z.string().optional(),
  lock: z.looseObject({ sha256: hex64, bible: z.string().optional() }).optional(),
});

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function splitEntries(
  front: string,
  source: string,
): { preamble: string; entries: CardEntry[]; data: Record<string, unknown> } {
  const doc = parseDocument(front);
  if (doc.errors.length > 0) {
    throw new InputError(`${source}: invalid front matter YAML: ${doc.errors[0]?.message}`);
  }
  if (!isMap(doc.contents)) throw new InputError(`${source}: front matter must be a YAML mapping.`);
  const starts: { key: string; at: number }[] = [];
  for (const pair of doc.contents.items) {
    const key = pair.key as { value?: unknown; range?: [number, number, number] | null };
    if (typeof key.value !== "string" || !key.range) {
      throw new InputError(`${source}: front matter keys must be plain strings.`);
    }
    starts.push({ key: key.value, at: lineStart(front, key.range[0]) });
  }
  const first = starts[0];
  if (!first) throw new InputError(`${source}: front matter has no fields.`);
  const entries = starts.map((start, index) => ({
    key: start.key,
    text: front.slice(start.at, starts[index + 1]?.at ?? front.length),
  }));
  return {
    preamble: front.slice(0, first.at),
    entries,
    data: doc.toJS() as Record<string, unknown>,
  };
}

/** Whether `text` is an asset card: parseable front matter whose `type` is "Game Asset". */
export function isCardText(text: string): boolean {
  try {
    const data: unknown = parseYaml(splitFrontMatter(text).front);
    return (
      typeof data === "object" &&
      data !== null &&
      (data as { type?: unknown }).type === "Game Asset"
    );
  } catch {
    return false;
  }
}

/** Reads a card; refuses (InputError) malformed front matter, a bad field or an unsupported format. */
export function parseCard(text: string, source: string): Card {
  let split: { front: string; prose: string };
  try {
    split = splitFrontMatter(text);
  } catch {
    throw new InputError(`${source}: a card is Markdown with YAML front matter.`);
  }
  const { preamble, entries, data } = splitEntries(split.front, source);
  readFormat("card", data, source, LIBRARY_FORMATS.card);
  const checked = cardSchema.safeParse(data);
  if (!checked.success) {
    const detail = checked.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ");
    throw new InputError(`${source}: ${detail}`);
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const openEnd = text.indexOf("\n") + 1;
  return {
    preamble,
    entries,
    body: split.prose,
    data,
    newline,
    open: text.slice(0, openEnd),
    close: text.slice(openEnd + split.front.length, text.length - split.prose.length),
  };
}

/** The card's text, its parts verbatim. */
export function writeCard(card: Card): string {
  return `${card.open}${card.preamble}${card.entries.map((e) => e.text).join("")}${card.close}${card.body}`;
}

export interface MachineInput {
  /** The media file name. */
  resource: string;
  provenance: Pick<Provenance, "route" | "bibleVersion" | "license" | "finishedAt">;
  /** The provenance record's path from the card; left out of `sources` when absent. */
  provenanceResource?: string;
  review: ReviewRecord;
  reviewResource: string;
  bibleResource?: string;
  kind: string;
  subject: string;
  /** The Assetgrove version, e.g. "0.2.0". */
  assetgrove: string;
}

/**
 * The card's `verified` entries for the record's current version: Assetgrove's QA at `qaAt`, the
 * pick (a person with its confirmation method, or the headless operator), and each approval.
 */
export function verifiedOf(
  review: ReviewRecord,
  qaAt: string,
  source: string,
): Record<string, string>[] {
  const current = currentVersion(review);
  if (!current) throw new InputError(`${source}: no version has been picked.`);
  const verified: Record<string, string>[] = [{ by: "process:assetgrove-qa", at: qaAt }];
  const confirmation = current.confirmation;
  if (confirmation) {
    if (confirmation.method === "headless") {
      if (!confirmation.operator) {
        throw new InputError(`${source}: a headless pick names its operator.`);
      }
      verified.push({ by: `process:headless:${confirmation.operator}`, at: current.at });
    } else {
      verified.push({ by: "human:developer", at: current.at, method: confirmation.method });
    }
  }
  for (const annotation of review.annotations) {
    const target = annotation.target;
    const version = typeof target === "string" ? undefined : target["ag:version"];
    if (
      annotation.motivation !== "assessing" ||
      annotation["ag:action"] !== "approve" ||
      version !== current.sha256
    ) {
      continue;
    }
    const method = annotation["ag:confirmation"]?.method;
    verified.push({
      by: "human:developer",
      at: annotation.created,
      ...(method === undefined ? {} : { method }),
    });
  }
  return verified;
}

/** The machine fields a card carries for these records, in card order. */
export function machineFields(input: MachineInput): Record<string, unknown> {
  const { provenance, review } = input;
  const current = currentVersion(review);
  if (!current) throw new InputError(`${input.reviewResource}: no version has been picked.`);
  const verified = verifiedOf(review, provenance.finishedAt, input.reviewResource);
  const sources = [
    ...(input.provenanceResource === undefined
      ? []
      : [{ id: "provenance", resource: input.provenanceResource }]),
    { id: "review", resource: input.reviewResource },
    ...(input.bibleResource === undefined ? [] : [{ id: "bible", resource: input.bibleResource }]),
  ];
  return {
    type: "Game Asset",
    format: `assetgrove-card/${LIBRARY_FORMATS.card}`,
    resource: input.resource,
    generated: {
      by: `assetgrove/${input.assetgrove} via ${provenance.route}`,
      at: provenance.finishedAt,
    },
    verified,
    sources,
    kind: input.kind,
    subject: input.subject,
    state: versionStatus(review, current.sha256),
    version: versionNumber(review, current.sha256),
    bible: provenance.bibleVersion,
    license: provenance.license,
    lock: { sha256: current.sha256, bible: provenance.bibleVersion },
  };
}

function flowMaps(node: unknown): void {
  if (isMap(node)) {
    node.flow = true;
    for (const pair of node.items) flowMaps(pair.value);
  } else if (isSeq(node)) {
    for (const item of node.items) flowMaps(item);
  }
}

function renderEntry(key: string, value: unknown, newline: string): string {
  const doc = new Document({ [key]: value });
  const top = doc.contents as Node & { items: { value: unknown }[] };
  for (const pair of top.items) flowMaps(pair.value);
  return doc.toString({ lineWidth: 0 }).replace(/\n/g, newline);
}

function fromEntries(card: Card, entries: CardEntry[], source: string): Card {
  const last = entries.length - 1;
  const normal = entries.map((entry, index) => ({
    key: entry.key,
    text: index === last ? entry.text.replace(/\r?\n$/, "") : entry.text,
  }));
  return parseCard(writeCard({ ...card, entries: normal }), source);
}

/** The card with its machine fields rewritten from `fields`; everything else is kept byte for byte. */
export function rewriteMachineFields(
  card: Card,
  fields: Record<string, unknown>,
  source: string,
): Card {
  const withNewline = card.entries.map((entry, index) => ({
    key: entry.key,
    text: index === card.entries.length - 1 ? entry.text + card.newline : entry.text,
  }));
  const entries: CardEntry[] = [];
  for (const entry of withNewline) {
    if (!MACHINE.has(entry.key)) entries.push(entry);
    else if (entry.key in fields) {
      const text = renderEntry(entry.key, fields[entry.key], card.newline);
      entries.push(text === entry.text ? entry : { key: entry.key, text });
    }
  }
  const present = new Set(entries.map((entry) => entry.key));
  for (const key of MACHINE_FIELDS) {
    if (key in fields && !present.has(key)) {
      entries.push({ key, text: renderEntry(key, fields[key], card.newline) });
    }
  }
  return fromEntries(card, entries, source);
}

export interface Person {
  title: string;
  description?: string;
  tags?: string[];
  body?: string;
}

/** A card for the first pick: the machine fields with the person's fields after `format`. */
export function newCard(person: Person, fields: Record<string, unknown>): Card {
  const newline = "\n";
  const values: Record<string, unknown> = {};
  for (const key of MACHINE_FIELDS) {
    if (key in fields) values[key] = fields[key];
    if (key === "format") {
      values["title"] = person.title;
      if (person.description !== undefined) values["description"] = person.description;
    }
    if (key === "resource" && person.tags !== undefined) values["tags"] = person.tags;
  }
  const entries = Object.entries(values).map(([key, value]) => ({
    key,
    text: renderEntry(key, value, newline),
  }));
  const card: Card = {
    preamble: "",
    entries: [],
    body: person.body ?? "",
    data: {},
    newline,
    open: "---\n",
    close: "\n---\n",
  };
  return fromEntries(card, entries, "new card");
}

/** The paths a card names that are read: its resource and each source but the bible. */
export function cardPaths(card: Card): string[] {
  const data = card.data as { resource: string; sources?: { id: string; resource: string }[] };
  return [
    data.resource,
    ...(data.sources ?? []).filter((s) => s.id !== "bible").map((s) => s.resource),
  ];
}

/** Refuses (InputError) any path the card names that leaves the library root. */
export function checkCardPaths(
  card: Card,
  libraryRoot: string,
  cardDir: string,
  source: string,
): void {
  for (const path of cardPaths(card)) libraryPath(libraryRoot, cardDir, path, source);
}

/**
 * The card with the machine fields its review record decides (`verified`, `state`, `version` and
 * `lock`) rewritten from `review`; the other machine fields keep their values. `qaAt` is the time of
 * Assetgrove's QA, by default the one the card already records.
 */
export function refreshFromReview(
  card: Card,
  review: ReviewRecord,
  source: string,
  options: { qaAt?: string } = {},
): Card {
  const current = currentVersion(review);
  if (!current) throw new InputError(`${source}: the review record holds no version.`);
  const data = card.data as {
    verified?: { by: string; at: string }[];
    generated?: { at?: string };
    bible?: string;
    lock?: { bible?: string };
  };
  const qaAt =
    options.qaAt ??
    data.verified?.find((v) => v.by === "process:assetgrove-qa")?.at ??
    data.generated?.at ??
    current.at;
  const fields: Record<string, unknown> = {};
  for (const key of MACHINE_FIELDS) if (key in card.data) fields[key] = card.data[key];
  const bible = data.lock?.bible ?? data.bible;
  fields["verified"] = verifiedOf(review, qaAt, source);
  fields["state"] = versionStatus(review, current.sha256);
  fields["version"] = versionNumber(review, current.sha256);
  fields["lock"] = { sha256: current.sha256, ...(bible !== undefined && { bible }) };
  return rewriteMachineFields(card, fields, source);
}

/** A card edit naming a field Assetgrove owns: exit 2 `card_field_owned`. */
export class CardFieldOwnedError extends InputError {
  readonly code = "card_field_owned";
  constructor(field: string) {
    super(
      `"${field}" is a machine field Assetgrove rebuilds from the records (${MACHINE_FIELDS.join(", ")}); a card edit changes person fields only`,
    );
    this.name = "CardFieldOwnedError";
  }
}

/**
 * The card with person fields set and, when given, its body replaced. An existing entry is
 * replaced in place; a new `description` goes after `title`, other new fields at the end. Naming a
 * machine field throws `CardFieldOwnedError` (exit 2 `card_field_owned`).
 */
export function setPersonFields(
  card: Card,
  values: Record<string, unknown>,
  body: string | undefined,
  source: string,
): Card {
  for (const key of Object.keys(values)) if (MACHINE.has(key)) throw new CardFieldOwnedError(key);
  const entries = card.entries.map((entry, index) => ({
    key: entry.key,
    text: index === card.entries.length - 1 ? entry.text + card.newline : entry.text,
  }));
  for (const [key, value] of Object.entries(values)) {
    const text = renderEntry(key, value, card.newline);
    const at = entries.findIndex((entry) => entry.key === key);
    if (at >= 0) {
      entries[at] = { key, text };
      continue;
    }
    const after = key === "description" ? entries.findIndex((e) => e.key === "title") : -1;
    entries.splice(after >= 0 ? after + 1 : entries.length, 0, { key, text });
  }
  const next =
    body === undefined ? card : { ...card, body: body.endsWith("\n") ? body : `${body}\n` };
  return fromEntries(next, entries, source);
}
