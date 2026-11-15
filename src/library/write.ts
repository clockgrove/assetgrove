/**
 * The library write of a hand-off (design sections 1 to 1.3): after the media and its provenance,
 * the version goes into `<assetId>.review.json` (the commit point), then the card `<assetId>.md`,
 * each `index.md` from the library root down, and the folder's `log.md`. Every file is written to
 * a temporary file in its own folder and renamed over the target, and the caller holds the library
 * write lock. Re-running a half-finished write completes it: a version already in the record is
 * not appended again, and the projections are rewritten from the records.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { InputError } from "../errors.ts";
import type { AssetSpec, ConfirmationRecord, Provenance, TargetProfile } from "../types.ts";
import { sha256Hex } from "./canonical.ts";
import {
  checkCardPaths,
  machineFields,
  newCard,
  parseCard,
  rewriteMachineFields,
  writeCard,
} from "./card.ts";
import type { Card } from "./card.ts";
import { renderIndex, renderLog, logEntriesFromReview } from "./folder.ts";
import type { LogEntry } from "./folder.ts";
import { libraryPath } from "./paths.ts";
import {
  annotationId,
  appendAnnotation,
  appendVersion,
  checkReviewPaths,
  emptyReview,
  parseReview,
  versionNumber,
  versionStatus,
  writeReview,
} from "./review.ts";
import type { Annotation, AnnotationInput, ReviewRecord, VersionStatus } from "./review.ts";

/** Asset ids the asset tree uses for its own files and views (design section 1). */
export const RESERVED_IDS = [
  "index",
  "log",
  "by-kind",
  "by-subject",
  "by-tag",
  "stale",
  "runs",
  "find",
  "like",
  "where",
] as const;

/** A refused asset id: reserved (`asset_id_reserved`) or carded at another path (`asset_conflict`). Exit 2. */
export class AssetIdError extends InputError {
  readonly code: "asset_id_reserved" | "asset_conflict";
  constructor(code: "asset_id_reserved" | "asset_conflict", message: string) {
    super(message);
    this.name = "AssetIdError";
    this.code = code;
  }
}

export interface LibraryConfig {
  /** The library root, absolute. */
  root: string;
  /** The library root relative to the target, with `/`; empty for the target root. */
  rootRel: string;
  game: string;
  log: boolean;
}

/** The directory segments of a layout template before the first one holding a placeholder. */
function staticPrefix(template: string): string {
  const segments = template.replaceAll("\\", "/").split("/").slice(0, -1);
  const fixed: string[] = [];
  for (const segment of segments) {
    if (segment.includes("{{")) break;
    fixed.push(segment);
  }
  return fixed.filter((s) => s !== "" && s !== ".").join("/");
}

/** A game id from a profile name: lower case, every run of other characters one `-`. */
export function gameSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "game" : slug;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The profile's `library` block with its defaults, for a target directory. */
export function libraryConfig(profile: TargetProfile, targetDir: string): LibraryConfig {
  const block = profile.library ?? {};
  const rootRel = (block.root ?? staticPrefix(profile.layout.media)).replaceAll("\\", "/");
  if (isAbsolute(rootRel) || posix.isAbsolute(rootRel)) {
    throw new InputError(`library.root "${rootRel}" must be a path inside the target`);
  }
  const root = resolve(targetDir, rootRel);
  if (!within(resolve(targetDir), root)) {
    throw new InputError(`library.root "${rootRel}" leaves the target directory`);
  }
  const game = block.game ?? gameSlug(profile.name);
  if (game === "" || /[/\\\s]/.test(game)) {
    throw new InputError(`library.game "${game}" must be one path segment without spaces`);
  }
  return {
    root,
    rootRel: relative(resolve(targetDir), root).split(sep).join("/"),
    game,
    log: block.log !== false,
  };
}

/** The library id of a hand-off's asset: the spec's id, and its animation family when it names one. */
export function assetIdOf(spec: AssetSpec): string {
  return spec.animationFamily ? `${spec.assetId}-${spec.animationFamily}` : spec.assetId;
}

/** A card found in the library. */
export interface FoundCard {
  /** The folder holding it, absolute. */
  dir: string;
  id: string;
  title: string;
  description?: string;
  bible?: string;
}

const SKIP_DIR = (name: string) =>
  name.startsWith(".") || name === "node_modules" || name.endsWith(".review");

/**
 * Every card under the library root: a Markdown file other than `index.md` and `log.md` whose
 * front matter says `type: Game Asset` and parses. Links are not followed, nor dot folders,
 * `node_modules` or `<id>.review` folders.
 */
export function scanCards(root: string): FoundCard[] {
  const found: FoundCard[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIR(entry.name)) walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (entry.name === "index.md" || entry.name === "log.md") continue;
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      if (!/^---\r?\n/.test(text) || !text.includes("Game Asset")) continue;
      try {
        const card = parseCard(text, path);
        const data = card.data as {
          title: string;
          description?: string;
          bible?: string;
          lock?: { bible?: string };
        };
        found.push({
          dir,
          id: entry.name.slice(0, -".md".length),
          title: data.title,
          ...(typeof data.description === "string" && { description: data.description }),
          ...((data.bible ?? data.lock?.bible) !== undefined && {
            bible: String(data.bible ?? data.lock?.bible),
          }),
        });
      } catch {
        // Not a card this build reads; `library check` reports it.
      }
    }
  };
  walk(root);
  return found;
}

/** What a hand-off's library write needs, checked before anything is written. */
export interface LibraryPlan {
  config: LibraryConfig;
  assetId: string;
  /** The folder of the media, card and review record. */
  dir: string;
  mediaPath: string;
  cardPath: string;
  reviewPath: string;
  /** The provenance file, or the manifest that embeds it, when inside the library root. */
  provenanceSource?: string;
  /** The cards in the library before this write. */
  cards: FoundCard[];
}

/**
 * Checks a hand-off's library write before anything is written: the asset id is not reserved
 * (exit 2 `asset_id_reserved`) and not carded at another path (exit 2 `asset_conflict`), the
 * media lies inside the library root, and the asset's own card and review record, when present,
 * parse and name only paths inside the root.
 */
export async function prepareLibraryWrite(input: {
  profile: TargetProfile;
  spec: AssetSpec;
  targetDir: string;
  mediaPath: string;
  provenancePath?: string;
  manifestPath: string;
}): Promise<LibraryPlan> {
  const config = libraryConfig(input.profile, input.targetDir);
  const assetId = assetIdOf(input.spec);
  if (assetId === "" || assetId === "." || assetId === ".." || /[/\\\0]/.test(assetId)) {
    throw new InputError(`asset id "${assetId}" is not a plain name`);
  }
  if ((RESERVED_IDS as readonly string[]).includes(assetId.toLowerCase())) {
    throw new AssetIdError(
      "asset_id_reserved",
      `asset id "${assetId}" is reserved by the library (${RESERVED_IDS.join(", ")}); choose another`,
    );
  }
  const dir = dirname(resolve(input.mediaPath));
  if (!within(config.root, dir)) {
    throw new InputError(
      `the media ${input.mediaPath} lies outside the library root ${config.root} (library.root)`,
    );
  }
  const cards = scanCards(config.root);
  const elsewhere = cards.find((card) => card.id === assetId && card.dir !== dir);
  if (elsewhere) {
    throw new AssetIdError(
      "asset_conflict",
      `asset id "${assetId}" is already carded at ${join(elsewhere.dir, `${assetId}.md`)}; asset ids are unique per game`,
    );
  }
  const cardPath = join(dir, `${assetId}.md`);
  const reviewPath = join(dir, `${assetId}.review.json`);
  await readOwnCard(cardPath, config.root, dir);
  await readOwnReview(reviewPath, config.root, dir, undefined);
  const source = [input.provenancePath, input.manifestPath].find(
    (path) => path !== undefined && within(config.root, resolve(path)),
  );
  return {
    config,
    assetId,
    dir,
    mediaPath: resolve(input.mediaPath),
    cardPath,
    reviewPath,
    ...(source !== undefined && { provenanceSource: resolve(source) }),
    cards,
  };
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readOwnCard(path: string, root: string, dir: string): Promise<Card | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  const card = parseCard(text, path);
  checkCardPaths(card, root, dir, path);
  return card;
}

async function readOwnReview(
  path: string,
  root: string,
  dir: string,
  address: string | undefined,
): Promise<ReviewRecord | undefined> {
  const text = await readText(path);
  if (text === undefined) return address === undefined ? undefined : emptyReview(address);
  const record = parseReview(text, path);
  checkReviewPaths(record, root, dir, path);
  return record;
}

/** Writes `content` to a temporary file in the target's folder, then renames it over the target. */
export async function writeAtomic(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, content);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Writes `text` atomically unless the file already holds it; whether it wrote. */
async function writeIfChanged(path: string, text: string): Promise<boolean> {
  if ((await readText(path)) === text) return false;
  await writeAtomic(path, text);
  return true;
}

function relPosix(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

/** A candidate's review record and the run folder its paths must stay inside. */
export interface CandidateReview {
  path: string;
  root: string;
}

/**
 * The candidate's annotations, retargeted at the asset: an object target's source becomes the
 * media file and its version the new one, a reply or resolution follows the ids it names, and
 * each mask or linked file is copied to `<assetId>.review/<sha256>.<ext>`.
 */
async function carryAnnotations(
  record: ReviewRecord,
  candidate: CandidateReview,
  plan: LibraryPlan,
  resource: string,
  sha256: string,
  copies: Array<[string, Uint8Array]>,
): Promise<ReviewRecord> {
  const text = await readText(candidate.path);
  if (text === undefined) return record;
  const source = parseReview(text, candidate.path);
  const from = dirname(candidate.path);
  const ids = new Map<string, string>();
  const copy = async (rel: string): Promise<string> => {
    const path = libraryPath(candidate.root, from, rel, candidate.path);
    const bytes = new Uint8Array(await readFile(path));
    const name = `${plan.assetId}.review/${sha256Hex(bytes)}${extname(path).toLowerCase()}`;
    copies.push([join(plan.dir, name), bytes]);
    return name;
  };
  let next = record;
  for (const annotation of source.annotations) {
    const { id: oldId, ...content } = annotation as Annotation;
    const target = content.target;
    if (typeof target === "string") {
      content.target = ids.get(target) ?? (target.startsWith("#") ? target : resource);
    } else {
      const retargeted = { ...target, source: resource, "ag:version": sha256 };
      if (target["ag:mask"] !== undefined) retargeted["ag:mask"] = await copy(target["ag:mask"]);
      content.target = retargeted;
    }
    const resolves = content["ag:resolves"];
    if (resolves !== undefined) content["ag:resolves"] = ids.get(resolves) ?? resolves;
    if (content.body !== undefined) {
      const parts = [content.body].flat();
      const copied = [];
      for (const part of parts) {
        copied.push(
          part.type === "SpecificResource" ? { ...part, source: await copy(part.source) } : part,
        );
      }
      content.body = Array.isArray(content.body) ? copied : copied[0];
    }
    ids.set(oldId, annotationId(content as Record<string, unknown>));
    next = appendAnnotation(next, content as AnnotationInput);
  }
  return next;
}

const BIBLE_LINE = /^- (\d{2}:\d{2}:\d{2})Z bible (.*) → (.*)$/;

function unescapeText(text: string): string {
  return text.replace(/\\([\\[\]<>|])/g, "$1");
}

/** The `bible` lines of a log, oldest first. */
function bibleLines(text: string | undefined): Extract<LogEntry, { action: "bible" }>[] {
  const lines: Extract<LogEntry, { action: "bible" }>[] = [];
  let date: string | undefined;
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^## (\d{4}-\d{2}-\d{2})$/.exec(line);
    if (heading) {
      date = heading[1];
      continue;
    }
    const match = date === undefined ? null : BIBLE_LINE.exec(line);
    if (!match) continue;
    lines.push({
      at: `${date}T${match[1]}Z`,
      action: "bible",
      from: unescapeText(match[2]!),
      to: unescapeText(match[3]!),
    });
  }
  return lines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function newer(a: string, b: string): boolean {
  return a.localeCompare(b, "en", { numeric: true }) > 0;
}

export interface LibraryVersionInput {
  /** The media bytes as written. */
  mediaBytes: Uint8Array;
  provenance: Pick<Provenance, "route" | "bibleVersion" | "license" | "finishedAt">;
  /** The provenance file's bytes, when it is a file of its own. */
  provenanceBytes?: Uint8Array | string;
  spec: AssetSpec;
  run: string;
  candidate: string;
  confirmation?: ConfirmationRecord;
  candidateReview?: CandidateReview;
  now: Date;
  /** The Assetgrove version, e.g. "0.2.0". */
  assetgrove: string;
}

export interface LibraryWriteResult {
  assetId: string;
  /** The current version's position in the stack. */
  version: number;
  sha256: string;
  state: VersionStatus;
  /** Whether this write appended the version (false when the record already had it). */
  appended: boolean;
  /** Every library file this write changed, absolute, in write order. */
  files: string[];
}

/**
 * Appends the version to the review record (the commit point), then writes the card, each
 * `index.md` from the library root down, and the folder's `log.md` unless the profile turns logs
 * off. The caller holds the library write lock and has written the media and provenance.
 */
export async function commitLibraryWrite(
  plan: LibraryPlan,
  input: LibraryVersionInput,
): Promise<LibraryWriteResult> {
  const { config, assetId, dir } = plan;
  const files: string[] = [];
  const at = input.now.toISOString();
  const sha256 = sha256Hex(input.mediaBytes);
  const resource = basename(plan.mediaPath);
  const address = `asset://${config.game}/${assetId}/review`;

  // 3. The review record: the commit point.
  let record = (await readOwnReview(plan.reviewPath, config.root, dir, address))!;
  const copies: Array<[string, Uint8Array]> = [];
  if (input.candidateReview) {
    record = await carryAnnotations(record, input.candidateReview, plan, resource, sha256, copies);
  }
  const appended = !record.versions.some((v) => v.sha256 === sha256);
  if (appended) {
    const first = record.versions.length === 0;
    const confirmation = input.confirmation && {
      method: input.confirmation.method,
      digest: input.confirmation.digest,
      ...(input.confirmation.operator !== undefined && {
        operator: input.confirmation.operator,
      }),
    };
    record = appendVersion(record, {
      sha256,
      ...(input.provenanceBytes !== undefined && {
        provenanceSha256: sha256Hex(input.provenanceBytes),
      }),
      run: input.run,
      candidate: input.candidate,
      at,
      ...(confirmation && { confirmation }),
    });
    record = appendAnnotation(record, {
      type: "Annotation",
      motivation: "moderating",
      created: at,
      target: { source: resource, "ag:version": sha256 },
      "ag:action": first ? "pick" : "replace",
    });
  }
  for (const [path, bytes] of copies) {
    if (!existsSync(path)) {
      await writeAtomic(path, bytes);
      files.push(path);
    }
  }
  if (await writeIfChanged(plan.reviewPath, writeReview(record))) files.push(plan.reviewPath);

  // 4. The card: machine fields from the records; person fields set once, then kept.
  const fields = machineFields({
    resource,
    provenance: input.provenance,
    ...(plan.provenanceSource !== undefined && {
      provenanceResource: relPosix(dir, plan.provenanceSource),
    }),
    review: record,
    reviewResource: `${assetId}.review.json`,
    kind: input.spec.kind,
    subject: input.spec.subject ?? input.spec.assetId,
    assetgrove: input.assetgrove,
  });
  const existing = await readOwnCard(plan.cardPath, config.root, dir);
  const extra = input.spec.fields ?? {};
  const tags = extra["tags"];
  const card = existing
    ? rewriteMachineFields(existing, fields, plan.cardPath)
    : newCard(
        {
          title: typeof extra["title"] === "string" ? extra["title"] : assetId,
          ...(typeof extra["description"] === "string" && { description: extra["description"] }),
          ...(Array.isArray(tags) &&
            tags.every((tag) => typeof tag === "string") && { tags: tags as string[] }),
        },
        fields,
      );
  if (await writeIfChanged(plan.cardPath, writeCard(card))) files.push(plan.cardPath);
  const title = (card.data as { title: string }).title;

  // 5. Each index.md from the library root down.
  const cards = scanCards(config.root);
  const folders = new Set<string>([config.root]);
  for (const found of cards) {
    for (let folder = found.dir; within(config.root, folder); folder = dirname(folder)) {
      folders.add(folder);
      if (folder === config.root) break;
    }
  }
  for (const folder of [...folders].sort()) {
    const isRoot = folder === config.root;
    const text = renderIndex({
      name: isRoot ? config.game : basename(folder),
      ...(isRoot && { root: { game: config.game } }),
      folders: [...folders]
        .filter((f) => f !== folder && dirname(f) === folder)
        .map((f) => basename(f)),
      assets: cards
        .filter((c) => c.dir === folder)
        .map((c) => ({
          id: c.id,
          title: c.title,
          ...(c.description !== undefined && { description: c.description }),
        })),
    });
    const path = join(folder, "index.md");
    if (await writeIfChanged(path, text)) files.push(path);
  }

  // 6. log.md, projected from the review records, unless logs are off.
  if (config.log) {
    const rootLog = join(config.root, "log.md");
    const bible = bibleLines(await readText(rootLog));
    const baseline =
      bible.at(-1)?.to ??
      plan.cards
        .map((c) => c.bible)
        .filter((v): v is string => v !== undefined)
        .reduce<string | undefined>(
          (max, v) => (max === undefined || newer(v, max) ? v : max),
          undefined,
        );
    const current = input.provenance.bibleVersion;
    const bibleChanged =
      baseline !== undefined && current !== undefined && newer(current, baseline);
    if (bibleChanged) bible.push({ at, action: "bible", from: baseline, to: current });
    const logFolders = new Set([dir]);
    if (bibleChanged) logFolders.add(config.root);
    for (const folder of logFolders) {
      const entries: LogEntry[] = folder === config.root ? [...bible] : [];
      for (const found of cards.filter((c) => c.dir === folder)) {
        const own = found.id === assetId && folder === dir;
        let review: ReviewRecord | undefined = own ? record : undefined;
        if (!review) {
          const reviewPath = join(folder, `${found.id}.review.json`);
          try {
            review = await readOwnReview(reviewPath, config.root, folder, undefined);
          } catch {
            review = undefined;
          }
        }
        if (review) {
          entries.push(
            ...logEntriesFromReview(review, { id: found.id, title: own ? title : found.title }),
          );
        }
      }
      const path = join(folder, "log.md");
      if (await writeIfChanged(path, renderLog(entries))) files.push(path);
    }
  }

  return {
    assetId,
    version: versionNumber(record, record.versions.at(-1)!.sha256)!,
    sha256: record.versions.at(-1)!.sha256,
    state: versionStatus(record, record.versions.at(-1)!.sha256),
    appended,
    files,
  };
}

/** This build's package version, for the card's `generated.by`. */
export function assetgroveVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}
