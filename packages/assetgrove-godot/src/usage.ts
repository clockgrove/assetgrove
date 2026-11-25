/**
 * The read-only usage scan of a Godot project: where its `.tscn` and `.tres` files refer to an
 * asset, by `res://` path or `uid://`, so the replacement preview can show what a replacement
 * affects. It reads files only through core's `read` and stores nothing but `ctx.cache`.
 */
import type {
  TargetEntry,
  TargetRead,
  UsageContext,
  UsageReference,
  UsageReport,
} from "@clockgrove/assetgrove/extension";
import { headerAttribute, importUid, textHeaderUid } from "./godot-text.ts";

/** One `[ext_resource]` line and the lines that use its id. */
interface ParsedExternal {
  line: number;
  path?: string;
  uid?: string;
  uses: { line: number; where: string }[];
}

/** A `"res://..."` or `"uid://..."` string outside an `ext_resource` line. */
interface ParsedLiteral {
  line: number;
  value: string;
  where: string;
}

/** What one file contributes, independent of the asset scanned for. */
interface Parsed {
  uid?: string;
  externals?: ParsedExternal[];
  literals?: ParsedLiteral[];
}

interface CachedFile {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  parsed: Parsed;
}

interface UsageCacheValue {
  version: 1;
  revision: string;
  files: Record<string, CachedFile>;
}

/** The report, and which files this scan read and which it took from the cache. */
export interface UsageScan {
  report: UsageReport;
  read: string[];
  reused: string[];
}

const BINARY = /\.(scn|res)$/;
const TEXT = /\.(tscn|tres)$/;
const LITERAL = /"((?:res|uid):\/\/[^"\r\n]*)"/g;
const decoder = new TextDecoder();

/** The scene node path of a `[node ...]` header, given the root's name once known. */
function nodePath(header: string, root: string | undefined): { path: string; root: string } {
  const name = headerAttribute(header, "name") ?? "";
  const parent = headerAttribute(header, "parent");
  if (parent === undefined) return { path: name, root: name };
  const top = root ?? "";
  return { path: parent === "." ? `${top}/${name}` : `${top}/${parent}/${name}`, root: top };
}

/** Parses a `.tscn` or `.tres`: its UID, its external resources with their uses, its literals. */
export function parseText(content: Uint8Array): Parsed {
  const lines = decoder.decode(content).split(/\r?\n/);
  const uid = textHeaderUid(content);
  const externals = new Map<string, ParsedExternal>();
  const anonymous: ParsedExternal[] = [];
  const literals: ParsedLiteral[] = [];
  const uses: { id: string; line: number; where: string }[] = [];
  let section = "";
  let root: string | undefined;
  let key = "";
  lines.forEach((raw, index) => {
    const line = index + 1;
    const header = /^\[(\w+)/.exec(raw);
    if (header) {
      const kind = header[1] ?? "";
      if (kind === "node") {
        const node = nodePath(raw, root);
        root = node.root;
        section = `node ${JSON.stringify(node.path)}`;
      } else if (kind === "sub_resource") {
        section = `sub_resource ${JSON.stringify(headerAttribute(raw, "id") ?? "")}`;
      } else {
        section = kind;
      }
      key = kind === "node" ? "instance" : "";
      if (kind === "gd_scene" || kind === "gd_resource") return;
      if (kind === "ext_resource") {
        const id = headerAttribute(raw, "id");
        const external: ParsedExternal = { line, uses: [] };
        const path = headerAttribute(raw, "path");
        const refUid = headerAttribute(raw, "uid");
        if (path !== undefined) external.path = path;
        if (refUid !== undefined) external.uid = refUid;
        if (id === undefined) anonymous.push(external);
        else externals.set(id, external);
        return;
      }
    } else {
      const property = /^([^=\s;[][^=]*?)\s*=/.exec(raw);
      if (property) key = property[1] ?? "";
    }
    const where = `${section} ${key}`.trim();
    for (const use of raw.matchAll(/ExtResource\(\s*"?([^")\s]+)"?\s*\)/g))
      uses.push({ id: use[1] ?? "", line, where });
    for (const literal of raw.matchAll(LITERAL))
      literals.push({ line, value: literal[1] ?? "", where });
  });
  for (const use of uses) externals.get(use.id)?.uses.push({ line: use.line, where: use.where });
  const parsed: Parsed = {
    externals: [...anonymous, ...externals.values()].sort((a, b) => a.line - b.line),
    literals,
  };
  if (uid !== undefined) parsed.uid = uid;
  return parsed;
}

function parseImport(content: Uint8Array): Parsed {
  const uid = importUid(content);
  return uid === undefined ? {} : { uid };
}

const isUsageCache = (value: unknown): value is UsageCacheValue =>
  typeof value === "object" &&
  value !== null &&
  (value as UsageCacheValue).version === 1 &&
  typeof (value as UsageCacheValue).revision === "string" &&
  typeof (value as UsageCacheValue).files === "object" &&
  (value as UsageCacheValue).files !== null;

const same = (a: CachedFile, b: TargetEntry) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function readOrUndefined(read: TargetRead, path: string): Promise<Uint8Array | undefined> {
  try {
    return await read(path);
  } catch {
    return undefined;
  }
}

/**
 * Scans the Godot project at `project` (relative to the target) for references to `ctx.media`, and
 * says which files it read and which it reused from the cache.
 */
export async function scanUsage(
  ctx: UsageContext,
  project: string,
  read: TargetRead,
): Promise<UsageScan> {
  const prefix = project === "" ? "" : `${project}/`;
  const reads: string[] = [];
  const reused: string[] = [];
  if (!ctx.media.startsWith(prefix) || ctx.media === prefix) {
    return { report: { asset: { path: ctx.media }, references: [] }, read: reads, reused };
  }
  const assetPath = `res://${ctx.media.slice(prefix.length)}`;
  const entries = (await ctx.list(project)).filter((entry) => {
    const inside = entry.path.slice(prefix.length);
    return inside !== ".godot" && !inside.startsWith(".godot/");
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const key = `godot-usage:${project}`;
  const stored = await ctx.cache.get(key);
  const old =
    ctx.revision !== "" && isUsageCache(stored) && stored.revision === ctx.revision
      ? stored.files
      : {};
  const files: Record<string, CachedFile> = {};
  const unreadable = new Map<string, string>();
  const parsedOf = new Map<string, Parsed>();

  for (const entry of entries) {
    const isImport = entry.path.endsWith(".import");
    if (BINARY.test(entry.path)) {
      unreadable.set(entry.path, "a binary resource, which the scan does not read");
      continue;
    }
    if (!isImport && !TEXT.test(entry.path)) continue;
    const cached = Object.hasOwn(old, entry.path) ? old[entry.path] : undefined;
    if (cached !== undefined && same(cached, entry)) {
      reused.push(entry.path);
      files[entry.path] = cached;
      parsedOf.set(entry.path, cached.parsed);
      continue;
    }
    reads.push(entry.path);
    const content = await readOrUndefined(read, entry.path);
    if (content === undefined) {
      unreadable.set(entry.path, "could not be read");
      continue;
    }
    const parsed = isImport ? parseImport(content) : parseText(content);
    files[entry.path] = {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.ctimeMs,
      parsed,
    };
    parsedOf.set(entry.path, parsed);
  }
  await ctx.cache.set(key, { version: 1, revision: ctx.revision, files } satisfies UsageCacheValue);

  const resPath = (file: string) => `res://${file.slice(prefix.length)}`;
  const known = new Set(entries.map((entry) => resPath(entry.path)));
  const uids = new Map<string, string>();
  let assetUid: string | undefined;
  for (const [file, parsed] of parsedOf) {
    if (parsed.uid === undefined) continue;
    const owner = file.endsWith(".import")
      ? resPath(file.slice(0, -".import".length))
      : resPath(file);
    uids.set(parsed.uid, owner);
  }
  const imported = await readOrUndefined(read, `${ctx.media}.import`);
  if (imported !== undefined) assetUid = importUid(imported);

  const decide = (path: string | undefined, uid: string | undefined) => {
    const owner = uid === undefined ? undefined : uids.get(uid);
    if (uid !== undefined && assetUid !== undefined && uid === assetUid) return "resolved";
    if (path === assetPath && (uid === undefined || owner === undefined)) return "resolved";
    if (owner !== undefined) return undefined;
    if (path !== undefined && known.has(path)) return undefined;
    return "unresolved";
  };
  const reason = "its UID and path resolve to nothing in the project";

  const references: UsageReference[] = [];
  const add = (
    file: string,
    line: number,
    path: string | undefined,
    uid: string | undefined,
    locations: string[],
  ) => {
    const status = decide(path, uid);
    if (status === undefined) return;
    const reference: UsageReference = { file, line, status, locations: [...new Set(locations)] };
    if (path !== undefined) reference.path = path;
    if (uid !== undefined) reference.uid = uid;
    if (status === "unresolved") reference.reason = reason;
    references.push(reference);
  };
  for (const [file, parsed] of parsedOf) {
    for (const external of parsed.externals ?? [])
      add(
        file,
        external.line,
        external.path,
        external.uid,
        external.uses.map((u) => u.where),
      );
    for (const literal of parsed.literals ?? []) {
      if (literal.value.startsWith("uid://"))
        add(file, literal.line, undefined, literal.value, [literal.where]);
      else add(file, literal.line, literal.value, undefined, [literal.where]);
    }
  }
  for (const [file, why] of unreadable)
    references.push({ file, status: "unreadable", locations: [], reason: why });
  references.sort((a, b) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) : (a.line ?? 0) - (b.line ?? 0),
  );

  const asset: UsageReport["asset"] = { path: assetPath };
  if (assetUid !== undefined) asset.uid = assetUid;
  return { report: { asset, references }, read: reads, reused };
}

/** The `usage` hook of the Godot presets: `scanUsage`'s report. */
export async function godotUsage(
  ctx: UsageContext,
  project: string,
  read: TargetRead,
): Promise<UsageReport> {
  return (await scanUsage(ctx, project, read)).report;
}
