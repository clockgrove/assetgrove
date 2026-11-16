/**
 * Folder indexes and logs: `index.md` lists a folder's child folders and assets, `log.md` is the
 * newest-first history of Assetgrove's actions, projected from the review records. Both render
 * byte-identically whatever the input order. Card text is shared text, so every title, description
 * and detail is escaped and cannot forge a link. Git's union merge may duplicate lines and
 * headings in either file; the readers collapse them, and every path read from an index row or a
 * log line is held to the library path rule.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { splitFrontMatter } from "../bible.ts";
import { InputError } from "../errors.ts";
import { libraryPath } from "./paths.ts";
import type { ReviewRecord } from "./review.ts";

/** Folds line breaks to one space, then backslash-escapes `\ [ ] < > |`. */
export function escapeText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[\\[\]<>|]/g, "\\$&");
}

function unescapeText(text: string): string {
  return text.replace(/\\([\\[\]<>|])/g, "$1");
}

/** A relative path with each segment percent-encoded, so spaces and parentheses cannot break a link. */
export function linkTarget(rel: string): string {
  return rel
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[()!'*]/g,
        (c) => `%${c.codePointAt(0)!.toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function decodeTarget(target: string, source: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    throw new InputError(`${source}: link target "${target}" is not valid percent-encoding`);
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function checkName(kind: string, value: string): void {
  if (value === "" || value === "." || value === ".." || /[/\\\0]/.test(value)) {
    throw new InputError(`${kind} "${value}" is not a plain name`);
  }
}

export interface IndexAsset {
  id: string;
  title: string;
  description?: string;
}

export interface IndexInput {
  /** The folder name, or the game id at the root. */
  name: string;
  root?: { game: string };
  folders: string[];
  assets: IndexAsset[];
}

/** The text of an `index.md`. */
export function renderIndex(input: IndexInput): string {
  const folders = [...new Set(input.folders)].sort(compare);
  for (const folder of folders) checkName("folder", folder);
  const byId = new Map<string, IndexAsset>();
  for (const asset of input.assets) {
    checkName("asset id", asset.id);
    const seen = byId.get(asset.id);
    if (
      seen &&
      (seen.title !== asset.title || (seen.description ?? "") !== (asset.description ?? ""))
    ) {
      throw new InputError(`asset id "${asset.id}" appears twice with different entries`);
    }
    byId.set(asset.id, asset);
  }
  const assets = [...byId.values()].sort((a, b) => compare(a.id, b.id));

  const lines: string[] = [];
  if (input.root) {
    const front = stringifyYaml({
      okf_version: 0.2,
      type: "Asset Library",
      game: input.root.game,
    }).trimEnd();
    lines.push("---", front, "---", "");
  }
  lines.push(`# ${escapeText(input.name)}`);
  if (folders.length > 0) {
    lines.push("", "## Folders", "");
    for (const folder of folders) {
      lines.push(`- [${escapeText(folder)}/](${linkTarget(folder)}/index.md)`);
    }
  }
  if (assets.length > 0) {
    lines.push("", "## Assets", "");
    for (const asset of assets) {
      const description = asset.description ? `: ${escapeText(asset.description)}` : "";
      lines.push(`- [${escapeText(asset.title)}](${linkTarget(asset.id)}.md)${description}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface ParsedIndexAsset {
  id: string;
  /** The decoded link target, relative to the folder. */
  target: string;
  title: string;
  description?: string;
}

export interface ParsedIndex {
  root?: { okfVersion: string; game: string };
  folders: string[];
  assets: ParsedIndexAsset[];
}

const ROW = /^- \[((?:\\.|[^\\\]])*)\]\(([^)\s]*)\)(?:: (.*))?$/;

function frontField(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** Reads an `index.md`, collapsing the duplicate headings and rows a union merge leaves. */
export function parseIndex(text: string, source: string): ParsedIndex {
  let lines = text.split(/\r?\n/);
  const result: ParsedIndex = { folders: [], assets: [] };
  if (lines[0]?.trim() === "---" && lines.some((line, i) => i > 0 && line.trim() === "---")) {
    const { front, prose } = splitFrontMatter(text);
    let fields: unknown;
    try {
      fields = parseYaml(front, { uniqueKeys: false });
    } catch (error) {
      throw new InputError(`${source}: invalid front matter YAML: ${(error as Error).message}`);
    }
    const map =
      fields !== null && typeof fields === "object" ? (fields as Record<string, unknown>) : {};
    result.root = { okfVersion: frontField(map.okf_version), game: frontField(map.game) };
    lines = prose.split(/\r?\n/);
  }
  const folders = new Set<string>();
  const assets = new Map<string, ParsedIndexAsset>();
  for (const line of lines) {
    const row = ROW.exec(line);
    if (!row) continue;
    const target = decodeTarget(row[2]!, source);
    if (target.endsWith("/index.md")) {
      folders.add(target.slice(0, -"/index.md".length));
    } else if (target.endsWith(".md")) {
      const id = target.slice(0, -".md".length);
      if (assets.has(id)) continue;
      const asset: ParsedIndexAsset = { id, target, title: unescapeText(row[1]!) };
      if (row[3] !== undefined) asset.description = unescapeText(row[3]);
      assets.set(id, asset);
    }
  }
  result.folders = [...folders].sort(compare);
  result.assets = [...assets.values()].sort((a, b) => compare(a.id, b.id));
  return result;
}

/** Refuses (InputError) any index row whose path leaves the library root. */
export function checkIndexPaths(
  index: ParsedIndex,
  libraryRoot: string,
  folderDir: string,
  source: string,
): void {
  for (const folder of index.folders) {
    libraryPath(libraryRoot, folderDir, `${folder}/index.md`, source);
  }
  for (const asset of index.assets) libraryPath(libraryRoot, folderDir, asset.target, source);
}

export type LogAction =
  "pick" | "replace" | "approve" | "reject" | "answer" | "card-edit" | "adopt";

export type LogEntry =
  | {
      /** ISO-8601 UTC. */
      at: string;
      action: LogAction;
      asset: { id: string; title: string };
      detail?: string;
    }
  | { at: string; action: "bible"; from: string; to: string };

const ISO_UTC = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/;

function logLine(entry: LogEntry): { date: string; line: string } {
  const match = ISO_UTC.exec(entry.at);
  if (!match || Number.isNaN(Date.parse(entry.at))) {
    throw new InputError(`log time "${entry.at}" is not ISO-8601 UTC`);
  }
  const stamp = `${match[2]}Z ${entry.action}`;
  if (entry.action === "bible") {
    return {
      date: match[1]!,
      line: `- ${stamp} ${escapeText(entry.from)} → ${escapeText(entry.to)}`,
    };
  }
  checkName("asset id", entry.asset.id);
  const detail = entry.detail ? `: ${escapeText(entry.detail)}` : "";
  const link = `[${escapeText(entry.asset.title)}](${linkTarget(entry.asset.id)}.md)`;
  return { date: match[1]!, line: `- ${stamp} ${link}${detail}` };
}

function emitLog(days: Map<string, Set<string>>): string {
  const lines = ["# Log"];
  for (const date of [...days.keys()].sort(compare).reverse()) {
    lines.push("", `## ${date}`, "");
    lines.push(...[...days.get(date)!].sort(compare).reverse());
  }
  return `${lines.join("\n")}\n`;
}

/** One rendered log line, under its day's heading. */
export interface LogLine {
  date: string;
  line: string;
}

/**
 * The text of a `log.md`: newest first, one line per entry, identical lines collapsed. `kept` lines
 * (carried over as they are from the current log) are rendered with them.
 */
export function renderLog(entries: LogEntry[], kept: LogLine[] = []): string {
  const days = new Map<string, Set<string>>();
  for (const { date, line } of [...entries.map(logLine), ...kept]) {
    if (!days.has(date)) days.set(date, new Set());
    days.get(date)!.add(line);
  }
  return emitLog(days);
}

/** The lines of a log that link to one of the asset ids' cards, as they are. */
export function logLinesFor(text: string | undefined, ids: Set<string>): LogLine[] {
  const kept: LogLine[] = [];
  if (ids.size === 0 || text === undefined) return kept;
  let date: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^## (\d{4}-\d{2}-\d{2})$/.exec(line);
    if (heading) {
      date = heading[1];
      continue;
    }
    if (date === undefined || !line.startsWith("- ")) continue;
    let targets: string[];
    try {
      targets = logLinks(line);
    } catch {
      continue;
    }
    if (targets.some((t) => t.endsWith(".md") && ids.has(t.slice(0, -".md".length)))) {
      kept.push({ date, line });
    }
  }
  return kept;
}

/** The asset rows of an index that name one of the asset ids, as entries `renderIndex` takes. */
export function indexAssetsFor(text: string | undefined, ids: Set<string>): IndexAsset[] {
  if (ids.size === 0 || text === undefined) return [];
  let parsed: ParsedIndex;
  try {
    parsed = parseIndex(text, "index.md");
  } catch {
    return [];
  }
  return parsed.assets
    .filter((a) => ids.has(a.id) && a.target === `${a.id}.md`)
    .map((a) => ({
      id: a.id,
      title: a.title,
      ...(a.description !== undefined && { description: a.description }),
    }));
}

/** Re-emits a possibly union-merged log: duplicate headings merged, duplicate lines dropped, order restored. */
export function normalizeLog(text: string): string {
  const days = new Map<string, Set<string>>();
  let current: Set<string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^## (\d{4}-\d{2}-\d{2})$/.exec(line);
    if (heading) {
      current = days.get(heading[1]!) ?? new Set();
      days.set(heading[1]!, current);
    } else if (current && line.startsWith("- ")) {
      current.add(line);
    }
  }
  return emitLog(days);
}

/** Every link target (decoded) the log's lines name. */
export function logLinks(text: string, source = "log.md"): string[] {
  const targets = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("- ")) continue;
    for (const match of line.matchAll(/\\.|\[(?:\\.|[^\\\]])*\]\(([^)\s]*)\)/g)) {
      if (match[1] !== undefined) targets.add(decodeTarget(match[1], source));
    }
  }
  return [...targets];
}

/** Refuses (InputError) any log link that leaves the library root. */
export function checkLogPaths(
  text: string,
  libraryRoot: string,
  folderDir: string,
  source: string,
): void {
  for (const target of logLinks(text, source)) libraryPath(libraryRoot, folderDir, target, source);
}

/** One entry per annotation carrying an Assetgrove action other than `resolve`. */
export function logEntriesFromReview(
  record: ReviewRecord,
  asset: { id: string; title: string },
): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const annotation of record.annotations) {
    const action = annotation["ag:action"];
    if (action === undefined || action === "resolve") continue;
    const parts: string[] = [];
    const target = annotation.target;
    if (action === "pick" || action === "replace" || action === "answer" || action === "adopt") {
      const sha = typeof target === "string" ? undefined : target["ag:version"];
      const index = record.versions.findIndex((v) => v.sha256 === sha);
      if (sha !== undefined && index >= 0) parts.push(`version ${index + 1}`);
      // Which version answered a request lives only in versions[].answers (design section 3.1).
      const answers = index >= 0 ? record.versions[index]!.answers : undefined;
      if (action === "answer" && answers !== undefined && answers.length > 0)
        parts.push(`answers ${answers.join(", ")}`);
    }
    const body = annotation.body === undefined ? [] : [annotation.body].flat();
    const textual = body.find((part) => part.type === "TextualBody");
    if (textual && textual.type === "TextualBody" && textual.value !== "")
      parts.push(textual.value);
    const entry: LogEntry = { at: annotation.created, action, asset: { ...asset } };
    if (parts.length > 0) entry.detail = parts.join("; ");
    entries.push(entry);
  }
  return entries;
}
