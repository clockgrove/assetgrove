/**
 * Library maintenance (design sections 1.2, 1.4 and 4): `library check` compares the records
 * (provenance and review records) with their projections (card machine fields, `index.md`,
 * `log.md`, the canonical layout of review records); `library rebuild` rewrites the projections;
 * `library stats` and `library drift` are reports computed from the cards. The expected state is
 * built once, so what rebuild writes is what check compares.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { splitFrontMatter } from "../bible.ts";
import { InputError } from "../errors.ts";
import type { Provenance, TargetProfile } from "../types.ts";
import {
  MACHINE_FIELDS,
  machineFields,
  parseCard,
  rewriteMachineFields,
  writeCard,
} from "./card.ts";
import type { Card } from "./card.ts";
import {
  checkIndexPaths,
  checkLogPaths,
  logEntriesFromReview,
  normalizeLog,
  parseIndex,
  renderIndex,
  renderLog,
} from "./folder.ts";
import type { LogEntry } from "./folder.ts";
import { readMedia } from "./lfs.ts";
import { libraryPath } from "./paths.ts";
import {
  checkReviewPaths,
  currentVersion,
  parseReview,
  versionNumber,
  versionStatus,
  writeReview,
} from "./review.ts";
import type { ReviewRecord, VersionStatus } from "./review.ts";
import {
  assetgroveVersion,
  bibleLines,
  libraryConfig,
  newer,
  readText,
  within,
  writeAtomic,
} from "./write.ts";
import type { LibraryConfig } from "./write.ts";

/** A file the check found wrong, relative to the library root with `/`, and why. */
export interface LibraryProblem {
  file: string;
  code: string;
}

interface Asset {
  dir: string;
  id: string;
  cardPath: string;
  reviewPath: string;
  card?: { parsed: Card; text: string };
  review?: { record: ReviewRecord; text: string };
}

/** One library file whose text should be what `text` says. */
interface Expected {
  path: string;
  kind: "review" | "card" | "index" | "log";
  text: string;
  /** Whether the file with this text differing only in layout is fine (it is compared normalised). */
  normalise?: (actual: string) => string;
}

export interface LibraryState {
  config: LibraryConfig;
  assets: Asset[];
  problems: LibraryProblem[];
  /** Files that hold the records' content in another layout (a union merge, a hand edit of layout). */
  needsRebuild: string[];
  /** Every file whose text is not what rebuild would write, in write order. */
  writes: Array<{ path: string; text: string }>;
}

const SKIP_DIR = (name: string) =>
  name.startsWith(".") || name === "node_modules" || name.endsWith(".review");

const rel = (config: LibraryConfig, path: string) =>
  relative(config.root, path).split(sep).join("/");

function walk(root: string): Map<string, string[]> {
  const folders = new Map<string, string[]>();
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIR(entry.name)) visit(join(dir, entry.name));
      } else if (entry.isFile()) names.push(entry.name);
    }
    folders.set(dir, names);
  };
  visit(root);
  return folders;
}

/** Whether `git` maps this file to Git LFS; undefined outside a Git repository. */
function lfsMapped(path: string): boolean | undefined {
  try {
    const out = execFileSync(
      "git",
      ["-C", dirname(path), "check-attr", "filter", "--", basename(path)],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return /: filter: lfs\s*$/m.test(out);
  } catch {
    return undefined;
  }
}

function cardData(card: Card): Record<string, unknown> {
  return card.data;
}

/** The provenance fields the card's machine fields come from, read from its provenance source. */
async function readProvenance(
  card: Card,
  config: LibraryConfig,
  dir: string,
  source: string,
): Promise<Pick<Provenance, "route" | "bibleVersion" | "license" | "finishedAt"> | undefined> {
  const data = cardData(card);
  const sources = (data["sources"] ?? []) as { id: string; resource: string }[];
  const entry = sources.find((s) => s.id === "provenance");
  if (!entry) return undefined;
  try {
    const path = libraryPath(config.root, dir, entry.resource, source);
    const found = findProvenance(JSON.parse(await readFile(path, "utf8")), 0);
    return found;
  } catch {
    return undefined;
  }
}

function findProvenance(
  value: unknown,
  depth: number,
): Pick<Provenance, "route" | "bibleVersion" | "license" | "finishedAt"> | undefined {
  if (value === null || typeof value !== "object" || depth > 4) return undefined;
  const o = value as Record<string, unknown>;
  const { route, bibleVersion, license, finishedAt } = o;
  if (
    typeof route === "string" &&
    typeof bibleVersion === "string" &&
    typeof license === "string" &&
    typeof finishedAt === "string"
  ) {
    return { route, bibleVersion, license, finishedAt };
  }
  for (const child of Object.values(o)) {
    const found = findProvenance(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** The machine fields the records say this asset's card has; undefined when they cannot say. */
async function expectedFields(
  asset: Asset,
  config: LibraryConfig,
): Promise<Record<string, unknown> | undefined> {
  const { card, review } = asset;
  if (!card || !review || !currentVersion(review.record)) return undefined;
  const data = cardData(card.parsed);
  // The media the records name: the pick annotation's target source, else what the card says.
  const recorded = review.record.annotations
    .filter((a) => a["ag:action"] === "pick" || a["ag:action"] === "replace")
    .map((a) => (typeof a.target === "string" ? undefined : a.target.source))
    .filter((s): s is string => s !== undefined)
    .at(-1);
  const resourceName = recorded ?? String(data["resource"]);
  const generated = data["generated"] as { by?: string; at?: string } | undefined;
  const byMatch = /^assetgrove\/(\S+) via (.*)$/.exec(generated?.by ?? "");
  const lock = data["lock"] as { bible?: string } | undefined;
  const provenance = (await readProvenance(card.parsed, config, asset.dir, asset.cardPath)) ?? {
    route: byMatch?.[2] ?? "",
    bibleVersion: String(data["bible"] ?? lock?.bible ?? ""),
    license: String(data["license"] ?? ""),
    finishedAt: generated?.at ?? "",
  };
  const sources = (data["sources"] ?? []) as { id: string; resource: string }[];
  const resource = (id: string) => sources.find((s) => s.id === id)?.resource;
  // The provenance file sits beside the media as `<resource>.provenance.json` when it was copied there.
  const beside = `${resourceName}.provenance.json`;
  const provenanceResource =
    (await readText(join(asset.dir, beside))) !== undefined ? beside : resource("provenance");
  const bibleResource = resource("bible");
  const fields = machineFields({
    resource: resourceName,
    provenance,
    ...(provenanceResource !== undefined && { provenanceResource }),
    review: review.record,
    reviewResource: `${asset.id}.review.json`,
    ...(bibleResource !== undefined && { bibleResource }),
    kind: typeof data["kind"] === "string" ? data["kind"] : "",
    subject: typeof data["subject"] === "string" ? data["subject"] : "",
    assetgrove: byMatch?.[1] ?? assetgroveVersion(),
  });
  // kind and subject have no record besides the card: they stay as the card has them.
  for (const key of ["kind", "subject"]) if (typeof data[key] !== "string") delete fields[key];
  return fields;
}

/** Reads every card and review record under the library root, with what is wrong with each. */
async function gather(config: LibraryConfig, problems: LibraryProblem[]): Promise<Asset[]> {
  const folders = walk(config.root);
  const assets: Asset[] = [];
  const problem = (path: string, code: string) => problems.push({ file: rel(config, path), code });
  for (const [dir, names] of [...folders].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const ids = new Map<string, Asset>();
    const asset = (id: string): Asset => {
      let found = ids.get(id);
      if (!found) {
        found = {
          dir,
          id,
          cardPath: join(dir, `${id}.md`),
          reviewPath: join(dir, `${id}.review.json`),
        };
        ids.set(id, found);
      }
      return found;
    };
    for (const name of [...names].sort()) {
      if (name.endsWith(".review.json")) asset(name.slice(0, -".review.json".length));
      else if (name.endsWith(".md") && name !== "index.md" && name !== "log.md") {
        let text: string;
        try {
          text = readFileSync(join(dir, name), "utf8");
        } catch {
          continue;
        }
        if (/^---\r?\n/.test(text) && text.includes("Game Asset")) asset(name.slice(0, -3));
      }
    }
    for (const found of [...ids.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const reviewText = await readText(found.reviewPath);
      if (reviewText === undefined) problem(found.reviewPath, "review_missing");
      else {
        try {
          const record = parseReview(reviewText, found.reviewPath);
          checkReviewPaths(record, config.root, dir, found.reviewPath);
          found.review = { record, text: reviewText };
        } catch {
          problem(found.reviewPath, "review_invalid");
        }
      }
      const cardText = await readText(found.cardPath);
      if (cardText === undefined) problem(found.cardPath, "card_missing");
      else {
        try {
          const parsed = parseCard(cardText, found.cardPath);
          const paths = [
            String(parsed.data["resource"]),
            ...((parsed.data["sources"] ?? []) as { id: string; resource: string }[])
              .filter((s) => s.id !== "bible")
              .map((s) => s.resource),
          ];
          for (const path of paths) libraryPath(config.root, dir, path, found.cardPath);
          found.card = { parsed, text: cardText };
        } catch {
          problem(found.cardPath, "card_invalid");
        }
      }
      assets.push(found);
    }
  }
  return assets;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Compares the records with their projections; collects the problems, layout-only differences and writes. */
export async function readLibrary(
  profile: TargetProfile,
  targetDir: string,
): Promise<LibraryState> {
  const config = libraryConfig(profile, targetDir);
  const problems: LibraryProblem[] = [];
  const needsRebuild: string[] = [];
  const writes: LibraryState["writes"] = [];
  const assets = await gather(config, problems);
  // A card or record that cannot be read leaves its folders' projections underivable: that problem
  // is reported once, not again as a mismatch of the index and log it would have fed.
  const broken = new Set(problems.map((p) => dirname(join(config.root, p.file))));
  const problem = (path: string, code: string) => problems.push({ file: rel(config, path), code });

  // Records: review records in canonical layout; cards' machine fields; media in LFS.
  const expected: Expected[] = [];
  for (const asset of assets) {
    if (asset.review) {
      expected.push({
        path: asset.reviewPath,
        kind: "review",
        text: writeReview(asset.review.record),
      });
    }
    if (asset.card) {
      const fields = await expectedFields(asset, config);
      if (fields) {
        const next = rewriteMachineFields(asset.card.parsed, fields, asset.cardPath);
        expected.push({ path: asset.cardPath, kind: "card", text: writeCard(next) });
        const differs = MACHINE_FIELDS.some(
          (key) => !isDeepStrictEqual(asset.card!.parsed.data[key], next.data[key]),
        );
        if (differs) problem(asset.cardPath, "machine_field_mismatch");
      }
      const resource = String(asset.card.parsed.data["resource"]);
      const media = join(asset.dir, resource);
      if (!within(config.root, media)) continue;
      try {
        await readMedia(media);
        if (lfsMapped(media) === false) problem(media, "media_not_lfs");
      } catch (error) {
        if (error instanceof InputError && /does not exist/.test(error.message)) {
          problem(media, "media_missing");
        } else problem(media, "media_invalid");
      }
    }
  }

  // Projections: every folder from the root to each card, from the cards found.
  const cards = assets.filter((a) => a.card);
  // An empty library has no projections to keep: no cards, no index.
  const folderSet = new Set<string>(cards.length > 0 ? [config.root] : []);
  for (const found of cards) {
    for (let folder = found.dir; within(config.root, folder); folder = dirname(folder)) {
      folderSet.add(folder);
      if (folder === config.root) break;
    }
  }
  const folderList = [...folderSet].sort();
  const rootLogText = await readText(join(config.root, "log.md"));
  const bible = bibleLines(rootLogText);
  for (const folder of folderList) {
    const isRoot = folder === config.root;
    const here = cards.filter((c) => c.dir === folder);
    const name = isRoot ? config.game : basename(folder);
    const children = folderList
      .filter((f) => f !== folder && dirname(f) === folder)
      .map((f) => basename(f));
    const index = renderIndex({
      name,
      ...(isRoot && { root: { game: config.game } }),
      folders: children,
      assets: here.map((c) => {
        const data = c.card!.parsed.data as { title: string; description?: string };
        return {
          id: c.id,
          title: data.title,
          ...(data.description !== undefined && { description: data.description }),
        };
      }),
    });
    expected.push({
      path: join(folder, "index.md"),
      kind: "index",
      text: index,
      normalise: (actual) => {
        const parsed = parseIndex(actual, join(folder, "index.md"));
        checkIndexPaths(parsed, config.root, folder, join(folder, "index.md"));
        if (parsed.root && parsed.root.okfVersion !== "0.2") return "";
        return renderIndex({
          name,
          ...(parsed.root && { root: { game: parsed.root.game } }),
          folders: parsed.folders,
          assets: parsed.assets.map((a) => ({
            id: a.id,
            title: a.title,
            ...(a.description !== undefined && { description: a.description }),
          })),
        });
      },
    });
    if (config.log && (here.length > 0 || (isRoot && bible.length > 0))) {
      const entries: LogEntry[] = isRoot ? [...bible] : [];
      for (const c of here) {
        if (c.review) {
          entries.push(
            ...logEntriesFromReview(c.review.record, {
              id: c.id,
              title: (c.card!.parsed.data as { title: string }).title,
            }),
          );
        }
      }
      expected.push({
        path: join(folder, "log.md"),
        kind: "log",
        text: renderLog(entries),
        normalise: (actual) => {
          checkLogPaths(actual, config.root, folder, join(folder, "log.md"));
          return normalizeLog(actual);
        },
      });
    }
  }

  const order = { review: 0, card: 1, index: 2, log: 3 } as const;
  expected.sort((a, b) => order[a.kind] - order[b.kind] || compare(a.path, b.path));
  for (const file of expected) {
    const actual = await readText(file.path);
    if (actual === undefined) {
      if (file.kind === "index" || file.kind === "log") problem(file.path, `${file.kind}_missing`);
      writes.push({ path: file.path, text: file.text });
      continue;
    }
    if (actual === file.text) continue;
    writes.push({ path: file.path, text: file.text });
    if (file.kind === "card") {
      // A machine-field mismatch was reported above; otherwise only the layout differs.
      if (!problems.some((p) => p.file === rel(config, file.path)))
        needsRebuild.push(rel(config, file.path));
      continue;
    }
    if (file.kind === "review") {
      needsRebuild.push(rel(config, file.path));
      continue;
    }
    let normalised: string;
    try {
      normalised = file.normalise!(actual);
    } catch {
      problem(file.path, `${file.kind}_invalid`);
      continue;
    }
    if (normalised === file.text) needsRebuild.push(rel(config, file.path));
    else if (![...broken].some((b) => within(dirname(file.path), b))) {
      problem(file.path, `${file.kind}_mismatch`);
    }
  }
  return { config, assets, problems, needsRebuild, writes };
}

/** Rewrites every projection that differs from what the records say; the caller holds the library lock. */
export async function rebuildLibrary(state: LibraryState): Promise<string[]> {
  const written: string[] = [];
  for (const { path, text } of state.writes) {
    await writeAtomic(path, text);
    written.push(rel(state.config, path));
  }
  return written;
}

export interface LibraryStats {
  assets: number;
  byKind: Record<string, number>;
  byState: Record<string, number>;
  changeRequests: { total: number; approvedWithinTwoVersions: number; share: number | null };
}

/** Counts by kind and state, and the share of change requests approved within two new versions. */
export function libraryStats(state: LibraryState): LibraryStats {
  const byKind: Record<string, number> = {};
  const byState: Record<string, number> = {};
  let total = 0;
  let approved = 0;
  let assets = 0;
  for (const asset of state.assets) {
    if (!asset.review) continue;
    const { record } = asset.review;
    const current = currentVersion(record);
    if (!current) continue;
    assets += 1;
    const kind = String(asset.card?.parsed.data["kind"] ?? "unknown");
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    const status: VersionStatus = versionStatus(record, current.sha256);
    byState[status] = (byState[status] ?? 0) + 1;
    for (const annotation of record.annotations) {
      if (annotation.motivation !== "editing") continue;
      const target = annotation.target;
      let position =
        typeof target === "string" ? undefined : versionNumber(record, target["ag:version"] ?? "");
      if (position === undefined) {
        const before = record.versions.filter((v) => v.at <= annotation.created).length;
        position = Math.max(before, 1);
      }
      total += 1;
      const later = record.versions.slice(position, position + 2);
      if (later.some((v) => versionStatus(record, v.sha256) === "approved")) approved += 1;
    }
  }
  return {
    assets,
    byKind: sorted(byKind),
    byState: sorted(byState),
    changeRequests: {
      total,
      approvedWithinTwoVersions: approved,
      share: total === 0 ? null : approved / total,
    },
  };
}

function sorted(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compare(a, b)));
}

export interface DriftEntry {
  asset: string;
  file: string;
  reason: string;
}

export interface LibraryDrift {
  bibleVersion: string | null;
  stale: (DriftEntry & { bible: string })[];
  modified: DriftEntry[];
}

/** The version of a JSON or Markdown style bible. */
export function bibleVersionOf(path: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const data = path.endsWith(".json")
      ? JSON.parse(text)
      : parseYaml(splitFrontMatter(text).front);
    const version = (data as { version?: unknown } | null)?.version;
    return typeof version === "string" || typeof version === "number" ? String(version) : undefined;
  } catch {
    return undefined;
  }
}

/** Stale and modified assets, computed from each card; nothing is stored. */
export async function libraryDrift(
  state: LibraryState,
  bibleVersion: string | undefined,
): Promise<LibraryDrift> {
  const stale: LibraryDrift["stale"] = [];
  const modified: DriftEntry[] = [];
  for (const asset of state.assets) {
    if (!asset.card) continue;
    const data = asset.card.parsed.data as {
      resource: string;
      bible?: string;
      lock?: { sha256?: string; bible?: string };
    };
    const file = rel(state.config, join(asset.dir, data.resource));
    const cardBible = data.bible ?? data.lock?.bible;
    if (
      bibleVersion !== undefined &&
      cardBible !== undefined &&
      newer(bibleVersion, String(cardBible))
    ) {
      stale.push({
        asset: asset.id,
        file,
        reason: `bible ${cardBible} is older than ${bibleVersion}`,
        bible: String(cardBible),
      });
    }
    const lock = data.lock?.sha256;
    if (lock === undefined) continue;
    try {
      const media = libraryPath(state.config.root, asset.dir, data.resource, asset.cardPath);
      const read = await readMedia(media, { sha256: lock });
      if (read.matches === false) {
        modified.push({
          asset: asset.id,
          file,
          reason:
            read.kind === "lfs-pointer"
              ? `pointer oid ${read.sha256} differs from lock.sha256`
              : `sha256 ${read.sha256} differs from lock.sha256`,
        });
      }
    } catch {
      modified.push({ asset: asset.id, file, reason: "missing" });
    }
  }
  return { bibleVersion: bibleVersion ?? null, stale, modified };
}
