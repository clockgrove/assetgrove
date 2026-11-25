/**
 * Review records: `<assetId>.review.json`, a W3C Web Annotation `AnnotationCollection` beside a
 * picked asset. Each version and annotation sits on its own line, so two branches' appends
 * union-merge; the reader tolerates the missing or extra commas that leaves, and the canonical
 * writer restores strict JSON. Past lines are never rewritten: a resolution is a new annotation.
 */
import { z } from "zod";
import { InputError } from "../errors.ts";
import { readFormat, registerMigration } from "../formats.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { libraryPath } from "./paths.ts";

/** Every library file kind that carries a format line, with the version this build reads. */
export const LIBRARY_FORMATS = { card: 1, review: 2 } as const;

// A /1 review record is valid as /2: the anchors /2 adds (`ag:frames`, `ag:cell`, a `t=` selector)
// are optional, so every version, note and resolution of a /1 record reads unchanged.
registerMigration("review", 1, (value) => value);

const CONTEXT = [
  "http://www.w3.org/ns/anno.jsonld",
  { ag: "https://github.com/clockgrove/assetgrove/ns/review#" },
];
const FORMAT_LINE = `assetgrove-review/${LIBRARY_FORMATS.review}`;
const CORE_KEYS = new Set(["@context", "id", "type", "ag:format", "ag:versions", "first"]);

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "must be a 64-hex sha256");
const annotationRef = z.string().regex(/^#[0-9a-f]{16}$/, 'must look like "#<16 hex>"');
const isoUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "must be ISO-8601 UTC");

export const ACTIONS = [
  "pick",
  "replace",
  "approve",
  "reject",
  "answer",
  "card-edit",
  "adopt",
  "resolve",
] as const;

export const MOTIVATIONS = [
  "commenting",
  "replying",
  "assessing",
  "editing",
  "describing",
  "tagging",
  "moderating",
] as const;

const MEDIA_FRAGMENTS = "http://www.w3.org/TR/media-frags/";

const selectorSchema = z
  .looseObject({
    type: z.literal("FragmentSelector"),
    conformsTo: z.literal(MEDIA_FRAGMENTS),
    value: z.string(),
  })
  .superRefine((selector, ctx) => {
    const problem = fragmentProblem(selector.value);
    if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["value"] });
  });

const NUMBER = "(\\d+(?:\\.\\d+)?)";

function fragmentProblem(value: string): string | undefined {
  return value.startsWith("t=") ? timeProblem(value) : boxProblem(value);
}

function boxProblem(value: string): string | undefined {
  const match = new RegExp(`^xywh=(pixel:|percent:)?${NUMBER},${NUMBER},${NUMBER},${NUMBER}$`).exec(
    value,
  );
  if (!match) return `"${value}" is not a media-fragment box (xywh=[pixel:|percent:]x,y,w,h)`;
  const [x, y, w, h] = match.slice(2, 6).map(Number) as [number, number, number, number];
  if (w <= 0 || h <= 0) return "a box needs a width and a height above zero";
  if (match[1] === "percent:" && (x + w > 100 || y + h > 100)) {
    return "a percent box must stay within 0 to 100";
  }
  return undefined;
}

/** A Media Fragments temporal range in seconds: `t=start,end` or `t=npt:start,end`. */
export interface TimeRange {
  start: number;
  end: number;
}

/** The time range a `t=` fragment names, or undefined when the value is not one. */
export function parseTimeFragment(value: string): TimeRange | undefined {
  const match = new RegExp(`^t=(?:npt:)?${NUMBER},${NUMBER}$`).exec(value);
  if (!match) return undefined;
  return { start: Number(match[1]), end: Number(match[2]) };
}

function timeProblem(value: string): string | undefined {
  const range = parseTimeFragment(value);
  if (range === undefined) {
    return `selector "${value}" is not a media-fragment time range (t=[npt:]start,end in seconds)`;
  }
  if (range.end <= range.start) {
    return `selector "${value}": a time range needs its end after its start`;
  }
  return undefined;
}

const frameIndex = z.number().int().nonnegative();

const framesSchema = z
  .looseObject({ from: frameIndex, to: frameIndex })
  .refine((frames) => frames.from <= frames.to, {
    message: "ag:frames needs from at or before to",
  });

const cellSchema = z.looseObject({ column: frameIndex, row: frameIndex });

const targetObject = z.looseObject({
  source: z.string().min(1),
  "ag:version": hex64.optional(),
  "ag:frame": z.number().int().nonnegative().optional(),
  "ag:view": z.number().int().nonnegative().optional(),
  "ag:mask": z.string().min(1).optional(),
  "ag:frames": framesSchema.optional(),
  "ag:cell": cellSchema.optional(),
  selector: selectorSchema.optional(),
});

const bodyItem = z.union([
  z.looseObject({
    type: z.literal("TextualBody"),
    value: z.string(),
    purpose: z.string().optional(),
    format: z.string().optional(),
    language: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("SpecificResource"),
    source: z.string().min(1),
    purpose: z.string().optional(),
  }),
]);

const confirmationSchema = z.looseObject({
  method: z.string().min(1),
  digest: z.string().optional(),
  operator: z.string().optional(),
});

const annotationSchema = z.looseObject({
  id: z
    .string()
    .regex(/^#[0-9a-f]{16}$/, 'must look like "#<16 hex>"')
    .optional(),
  type: z.literal("Annotation"),
  motivation: z.enum(MOTIVATIONS),
  created: isoUtc,
  body: z.union([bodyItem, z.array(bodyItem)]).optional(),
  target: z.union([z.string().min(1), targetObject]),
  "ag:action": z.enum(ACTIONS).optional(),
  "ag:resolves": annotationRef.optional(),
  "ag:confirmation": confirmationSchema.optional(),
});

const versionSchema = z.looseObject({
  sha256: hex64,
  provenanceSha256: hex64.optional(),
  contentSha256: hex64.optional(),
  run: z.string().optional(),
  candidate: z.string().optional(),
  at: isoUtc,
  answers: z.array(annotationRef).optional(),
  confirmation: confirmationSchema.optional(),
});

const collectionSchema = z.looseObject({
  id: z.string().min(1),
  type: z.literal("AnnotationCollection"),
});

export type Annotation = z.output<typeof annotationSchema> & { id: string };
/** An annotation before its id is computed. */
export type AnnotationInput = z.input<typeof annotationSchema>;
export type Version = z.output<typeof versionSchema>;
const versionPositions = new WeakMap<Version, number>();

export function versionSourceIndex(version: Version, fallback: number): number {
  return versionPositions.get(version) ?? fallback;
}

export type VersionInput = z.input<typeof versionSchema>;

export interface ReviewRecord {
  id: string;
  context: unknown;
  /** Top-level members other than the ones Assetgrove writes itself. */
  extra: Record<string, unknown>;
  /** In stack order, one per media sha256. */
  versions: Version[];
  /** Ordered by `created`, then id. */
  annotations: Annotation[];
}

export type VersionStatus = "approved" | "rejected" | "changes-requested" | "pending";

/** The id an annotation's content earns: `#` and the first 16 hex of the hash of it without `id`. */
export function annotationId(annotation: Record<string, unknown>): string {
  const content = { ...annotation };
  delete content["id"];
  return `#${sha256Hex(canonicalJson(content)).slice(0, 16)}`;
}

/** A copy of the annotation with its id set, first. */
export function withId<T extends Record<string, unknown>>(annotation: T): T & { id: string } {
  const content = { ...annotation };
  delete content["id"];
  return { id: annotationId(annotation), ...content } as unknown as T & { id: string };
}

type Issue = z.core.$ZodIssue;

/**
 * A union's issues come from the branch of the input's own type (a target object, not a target
 * path), so a bad anchor is reported by its member rather than as "Invalid input".
 */
function flatten(issue: Issue, prefix: PropertyKey[]): Issue[] {
  const path = [...prefix, ...issue.path];
  if (issue.code !== "invalid_union") return [{ ...issue, path }];
  const branches = issue.errors.filter(
    (branch) => !branch.every((i) => i.code === "invalid_type" && i.path.length === 0),
  );
  if (branches.length !== 1) return [{ ...issue, path }];
  return branches[0]!.flatMap((inner) => flatten(inner, path));
}

function issues(error: z.ZodError): string {
  return error.issues
    .flatMap((issue) => flatten(issue, []))
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new InputError(`${where}: ${issues(result.error)}`);
  return result.data;
}

function checkAnnotation(annotation: Annotation, where: string): void {
  const action = annotation["ag:action"];
  const fail = (message: string): never => {
    throw new InputError(`${where}: ${message}`);
  };
  switch (annotation.motivation) {
    case "assessing":
      if (action !== "approve" && action !== "reject") {
        fail('an assessing annotation needs "ag:action" of "approve" or "reject"');
      }
      break;
    case "moderating":
      if (action === undefined || action === "approve" || action === "reject") {
        fail('a moderating annotation needs an "ag:action" other than approve or reject');
      }
      break;
    case "describing":
    case "tagging":
      if (action !== undefined && action !== "card-edit") {
        fail('a describing or tagging annotation may only carry "ag:action": "card-edit"');
      }
      break;
    default:
  }
  if (action === "resolve" && annotation["ag:resolves"] === undefined) {
    fail('a resolve annotation names the request in "ag:resolves"');
  }
  const expected = annotationId(annotation);
  if (annotation.id !== expected) {
    fail(`id ${annotation.id} does not match its content (expected ${expected})`);
  }
}

function time(at: string): number {
  return Date.parse(at);
}

function byTime<T extends { at?: string; created?: string }>(
  key: "at" | "created",
  tie: (item: T) => string,
) {
  return (a: T, b: T): number => {
    const delta = time(a[key] as string) - time(b[key] as string);
    if (delta !== 0) return delta;
    const left = tie(a);
    const right = tie(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
}

function build(
  head: Pick<ReviewRecord, "id" | "context" | "extra">,
  versions: Version[],
  annotations: Annotation[],
  source: string,
): ReviewRecord {
  const seenAnnotations = new Map<string, Annotation>();
  for (const annotation of annotations) {
    if (!seenAnnotations.has(annotation.id)) seenAnnotations.set(annotation.id, annotation);
  }
  const sortedAnnotations = [...seenAnnotations.values()].sort(
    byTime("created", (a: Annotation) => a.id),
  );

  const seenVersions = new Map<string, Version>();
  for (const version of [...versions].sort(byTime("at", (v: Version) => v.sha256))) {
    if (!seenVersions.has(version.sha256)) seenVersions.set(version.sha256, version);
  }
  const sortedVersions = [...seenVersions.values()].sort(byTime("at", (v: Version) => v.sha256));

  const editing = new Set(
    sortedAnnotations.filter((a) => a.motivation === "editing").map((a) => a.id),
  );
  for (const version of sortedVersions) {
    for (const answered of version.answers ?? []) {
      if (!editing.has(answered)) {
        throw new InputError(
          `${source}: version ${version.sha256} answers ${answered}, which is not an editing annotation in this record.`,
        );
      }
    }
  }
  return { ...head, versions: sortedVersions, annotations: sortedAnnotations };
}

/** Validates an already-parsed review record; refuses with InputError naming `source`. */
export function validateReview(value: unknown, source: string): ReviewRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError(`${source}: a review record is a JSON object.`);
  }
  const raw = value as Record<string, unknown>;
  const collection = parseWith(collectionSchema, raw, source);
  readFormat("review", { format: raw["ag:format"] }, source, LIBRARY_FORMATS.review);

  const rawVersions = raw["ag:versions"] ?? [];
  if (!Array.isArray(rawVersions))
    throw new InputError(`${source}: "ag:versions" must be an array.`);
  const first = raw["first"];
  const items = first === undefined ? [] : ((first as { items?: unknown } | null)?.items ?? []);
  if (!Array.isArray(items)) throw new InputError(`${source}: "first.items" must be an array.`);

  const versions = rawVersions.map((entry, index) => {
    const version = parseWith(versionSchema, entry, `${source}: ag:versions[${index}]`);
    versionPositions.set(version, index);
    return version;
  });
  const annotations = items.map((entry, index) => {
    const where = `${source}: first.items[${index}]`;
    const parsed = parseWith(annotationSchema, entry, where);
    if (parsed.id === undefined) throw new InputError(`${where}: id is required.`);
    const annotation = parsed as Annotation;
    checkAnnotation(annotation, where);
    return annotation;
  });

  const extra: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(raw)) if (!CORE_KEYS.has(key)) extra[key] = member;
  return build(
    { id: collection.id, context: raw["@context"] ?? CONTEXT, extra },
    versions,
    annotations,
    source,
  );
}

function lineFailure(source: string, line: number, detail: string): InputError {
  return new InputError(`${source}: line ${line} is not valid review JSON (${detail}).`);
}

/**
 * Reads a review record. Strict JSON parses as is; otherwise each line inside the versions and
 * items sections is read as one object, tolerating a missing, extra or doubled comma. A union
 * merge of two branches that each appended a version and an annotation interleaves the sections
 * and repeats the lines between them; the reader reads that as the union too.
 */
export function parseReview(text: string, source: string): ReviewRecord {
  try {
    return validateReview(JSON.parse(text), source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const lines = text.split(/\r?\n/);
  const skeleton: string[] = [];
  const seen = new Set<string>();
  const versions: unknown[] = [];
  const items: unknown[] = [];
  let section: unknown[] | undefined;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (section) {
      if (trimmed.startsWith("]")) {
        section = undefined;
        if (!seen.has(trimmed)) skeleton.push(line);
        seen.add(trimmed);
        return;
      }
      const body = trimmed.replace(/^,+/, "").replace(/,+$/, "").trim();
      if (body === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        throw lineFailure(source, index + 1, (error as Error).message);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw lineFailure(source, index + 1, "expected an object");
      }
      const object = parsed as Record<string, unknown>;
      // A union merge can leave a line in the other section: its own shape says which it is.
      if (object["type"] === "Annotation") items.push(parsed);
      else if (object["type"] === undefined && typeof object["sha256"] === "string") {
        versions.push(parsed);
      } else section.push(parsed);
      return;
    }
    // A union merge can repeat a header or footer line; each is read once.
    if (trimmed === "" || !seen.has(trimmed)) skeleton.push(line);
    seen.add(trimmed);
    if (trimmed.endsWith('"ag:versions": [')) section = versions;
    else if (trimmed.endsWith('"items": [')) section = items;
  });
  const skeletonText = skeleton.join("\n");
  let head: unknown;
  try {
    head = JSON.parse(skeletonText);
  } catch {
    try {
      head = JSON.parse(skeletonText.replace(/,(\s*[}\]])/g, "$1"));
    } catch (error) {
      throw new InputError(
        `${source}: the header and footer lines are not valid JSON (${(error as Error).message}).`,
      );
    }
  }
  if (typeof head !== "object" || head === null || Array.isArray(head)) {
    throw new InputError(`${source}: a review record is a JSON object.`);
  }
  const object = head as Record<string, unknown>;
  const first = (object["first"] ?? {}) as Record<string, unknown>;
  return validateReview({ ...object, "ag:versions": versions, first: { ...first, items } }, source);
}

function leadingKeyLine(object: Record<string, unknown>, key: string): string {
  const { [key]: lead, ...rest } = object;
  const tail = canonicalJson(rest);
  return `{${JSON.stringify(key)}:${canonicalJson(lead)}${tail === "{}" ? "}" : `,${tail.slice(1)}`}`;
}

function itemLines(items: string[]): string[] {
  return items.map((line, index) => (index < items.length - 1 ? `${line},` : line));
}

/** The canonical text: fixed header and footer, one line per version and annotation. */
export function writeReview(record: ReviewRecord): string {
  const lines = [
    "{",
    `"@context": ${canonicalJson(record.context)},`,
    `"id": ${JSON.stringify(record.id)},`,
    `"type": "AnnotationCollection",`,
    `"ag:format": ${JSON.stringify(FORMAT_LINE)},`,
  ];
  for (const key of Object.keys(record.extra).sort()) {
    if (record.extra[key] === undefined) continue;
    lines.push(`${JSON.stringify(key)}: ${canonicalJson(record.extra[key])},`);
  }
  lines.push(
    '"ag:versions": [',
    ...itemLines(record.versions.map((v) => leadingKeyLine(v, "sha256"))),
    "],",
    '"first": { "type": "AnnotationPage", "items": [',
    ...itemLines(record.annotations.map((a) => leadingKeyLine(a, "id"))),
    "] }",
    "}",
  );
  const text = `${lines.join("\n")}\n`;
  JSON.parse(text);
  return text;
}

/** A record with no versions and no annotations; `address` is its collection id. */
export function emptyReview(address: string): ReviewRecord {
  return { id: address, context: CONTEXT, extra: {}, versions: [], annotations: [] };
}

/** A new record with the version added (the same media sha256 keeps its earliest entry). */
export function appendVersion(record: ReviewRecord, version: VersionInput): ReviewRecord {
  const parsed = parseWith(versionSchema, version, `${record.id}: version`);
  return build(record, [...record.versions, parsed], record.annotations, record.id);
}

/**
 * A new record whose version `sha256` derives from `lineage`: each new file entry replaces that
 * file's earlier entry on the version, other entries are kept. Used when a source edit renders the
 * same media again, so the version records the source bytes it now derives from.
 */
export function updateVersionLineage(
  record: ReviewRecord,
  sha256: string,
  lineage: Array<{ relation: "derived-from"; file: string; sha256: string }>,
): ReviewRecord {
  const versions = record.versions.map((version) => {
    if (version.sha256 !== sha256) return version;
    const files = new Set(lineage.map((entry) => entry.file));
    const earlier = Array.isArray(version["lineage"]) ? (version["lineage"] as unknown[]) : [];
    const kept = earlier.filter(
      (entry) =>
        !(
          typeof entry === "object" &&
          entry !== null &&
          files.has((entry as { file?: unknown }).file as string)
        ),
    );
    return { ...version, lineage: [...kept, ...lineage] };
  });
  return build(record, versions, record.annotations, record.id);
}

/** A new record with the annotation added, its id computed; the same content is added once. */
export function appendAnnotation(record: ReviewRecord, annotation: AnnotationInput): ReviewRecord {
  const parsed = parseWith(annotationSchema, annotation, `${record.id}: annotation`);
  const content = { ...parsed } as Record<string, unknown>;
  const stamped = { ...content, id: annotationId(content) } as Annotation;
  checkAnnotation(stamped, `${record.id}: annotation`);
  return build(record, record.versions, [...record.annotations, stamped], record.id);
}

/**
 * The stamp for the next version or annotation written into `record`: `now`, or 1 ms after the
 * latest stamp already in the record when that is later. Stamps order the record, so what a writer
 * appends sorts after everything already there even when another machine's clock was ahead.
 */
export function nextStamp(record: ReviewRecord, now: Date = new Date()): string {
  let latest = Number.NEGATIVE_INFINITY;
  for (const version of record.versions) latest = Math.max(latest, time(version.at));
  for (const annotation of record.annotations) latest = Math.max(latest, time(annotation.created));
  return new Date(Math.max(now.getTime(), latest + 1)).toISOString();
}

/** The 1-based position of a version in the stack, or undefined when it is not there. */
export function versionNumber(record: ReviewRecord, sha256: string): number | undefined {
  const index = record.versions.findIndex((v) => v.sha256 === sha256);
  return index < 0 ? undefined : index + 1;
}

/** The latest version in the stack. */
export function currentVersion(record: ReviewRecord): Version | undefined {
  return record.versions.at(-1);
}

/** The version an annotation targets, by sha256. */
export function targetVersion(annotation: Annotation): string | undefined {
  const target = annotation.target;
  return typeof target === "string" ? undefined : target["ag:version"];
}

/** The latest assessment decides; else an unanswered, unresolved change request; else pending. */
export function versionStatus(record: ReviewRecord, sha256: string): VersionStatus {
  const assessments = record.annotations.filter(
    (a) => a.motivation === "assessing" && targetVersion(a) === sha256,
  );
  const latest = assessments.at(-1);
  if (latest) return latest["ag:action"] === "approve" ? "approved" : "rejected";
  const answered = new Set(record.versions.flatMap((v) => v.answers ?? []));
  const resolved = new Set(
    record.annotations.filter((a) => a["ag:action"] === "resolve").map((a) => a["ag:resolves"]),
  );
  const open = record.annotations.some(
    (a) =>
      a.motivation === "editing" &&
      targetVersion(a) === sha256 &&
      !answered.has(a.id) &&
      !resolved.has(a.id),
  );
  return open ? "changes-requested" : "pending";
}

/** The tag a person's `tagging` annotation gives a version to mark it as a placeholder. */
export const PLACEHOLDER_TAG = "placeholder";

/** The body of a placeholder mark: a W3C tag. */
export function placeholderBody() {
  return { type: "TextualBody" as const, purpose: "tagging", value: PLACEHOLDER_TAG };
}

/**
 * The annotations that mark version `sha256` as a placeholder, oldest first: each `tagging`
 * annotation targeting that version with a tag body whose value is `placeholder`.
 */
export function placeholderMarks(record: ReviewRecord, sha256: string): Annotation[] {
  return record.annotations.filter((a) => {
    if (a.motivation !== "tagging" || targetVersion(a) !== sha256) return false;
    const bodies = a.body === undefined ? [] : Array.isArray(a.body) ? a.body : [a.body];
    return bodies.some(
      (b) =>
        b.type === "TextualBody" &&
        (b.purpose === undefined || b.purpose === "tagging") &&
        typeof b.value === "string" &&
        b.value.trim().toLowerCase() === PLACEHOLDER_TAG,
    );
  });
}

/** Every path the record names: target sources, masks and linked reference files. */
export function reviewPaths(record: ReviewRecord): string[] {
  const paths = new Set<string>();
  for (const annotation of record.annotations) {
    const target = annotation.target;
    if (typeof target === "string") paths.add(target);
    else {
      paths.add(target.source);
      if (target["ag:mask"] !== undefined) paths.add(target["ag:mask"]);
    }
    const body = annotation.body === undefined ? [] : [annotation.body].flat();
    for (const part of body) if (part.type === "SpecificResource") paths.add(part.source);
  }
  return [...paths];
}

/** Refuses (InputError) any named path that leaves the library root. */
export function checkReviewPaths(
  record: ReviewRecord,
  libraryRoot: string,
  recordDir: string,
  source: string,
): void {
  for (const path of reviewPaths(record)) libraryPath(libraryRoot, recordDir, path, source);
}

/** The head of a record: its last annotation's id and a hash of every item line. */
export interface RecordHead {
  /** The last annotation's id (by `created`, then id), or null when there is none. */
  last: string | null;
  /** The sha256 of the canonical version and annotation lines, joined by newlines. */
  items: string;
}

/**
 * The record's head (design section 3.3): a digest that holds it changes once any line is added,
 * whether by a review action, a pull or a union merge, so a stored confirmation cannot be replayed.
 */
export function recordHead(record: ReviewRecord): RecordHead {
  const lines = [
    ...record.versions.map((v) => leadingKeyLine(v, "sha256")),
    ...record.annotations.map((a) => leadingKeyLine(a, "id")),
  ];
  return { last: record.annotations.at(-1)?.id ?? null, items: sha256Hex(lines.join("\n")) };
}
