/**
 * The asset tree's resolver (design section 2): every `asset://<game>/…` address the MCP server's
 * `resources/read`, `assetgrove ls` and `cat` (tools `ls`, `cat`) answer, as the same contents.
 *
 * A folder returns a JSON document `{address, kind: "folder", children, next?}` with at most 200
 * children per read, plus `index.md` for the library root. Card text appears only under
 * `sharedText`. `card` and `log` return Markdown, `provenance` and `review` JSON, `image` a PNG
 * thumbnail of at most 512 px and `image/full` the file. No read's encoded content exceeds 64 KB:
 * content that would is replaced by a JSON pointer naming the file and its size.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { turntableViews } from "../compare.ts";
import { InputError } from "../errors.ts";
import { BIBLE_PATH } from "../init.ts";
import { MACHINE_FIELDS } from "../library/card.ts";
import { sha256Hex } from "../library/canonical.ts";
import { logEntriesFromReview, renderLog } from "../library/folder.ts";
import { bibleVersionOf } from "../library/maintain.ts";
import { findGitDir, lfsObjectPath, readMedia } from "../library/lfs.ts";
import { versionStatus } from "../library/review.ts";
import type { ReviewRecord } from "../library/review.ts";
import { sniffMediaType } from "../request.ts";
import { readRunState } from "../runs/execute.ts";
import { runLockLive } from "../runs/lock.ts";
import { VIEWS, formatAddress, pageAddress, parseAddress } from "./address.ts";
import type { Address } from "./address.ts";
import {
  checkedCard,
  isStale,
  loadAssets,
  mediaPath,
  readAssetReview,
  sourcePath,
} from "./project.ts";
import type { Asset, Project } from "./project.ts";
import { READ_LIMIT, base64Length, thumbnail } from "./thumbs.ts";
import type { ThumbShape } from "./thumbs.ts";

/** The most children one folder read returns. */
export const PAGE_SIZE = 200;

export type Content =
  { uri: string; mimeType: string; text: string } | { uri: string; mimeType: string; blob: string };

export interface Child {
  address: string;
  name: string;
  kind: "folder" | "asset" | "file" | "candidate" | "version";
  state?: string;
}

/** What one read returns. */
export interface ReadResult {
  address: string;
  contents: Content[];
  /** The JSON document of the read (its first content), when it has one. */
  document?: Record<string, unknown>;
  /** Whether the address is a folder. */
  folder: boolean;
  /** The whole file a file address names, for `cat --out`; absent when there are no bytes. */
  bytes?: Uint8Array;
}

const JSON_TYPE = "application/json";
const MARKDOWN = "text/markdown";
const PNG = "image/png";
const ASSET_FILES = ["card", "provenance", "review", "log", "image", "versions"] as const;

/** Media types by extension for what sniffing does not tell. */
function mediaTypeOf(path: string, bytes?: Uint8Array): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".glb") return "model/gltf-binary";
  if (ext === ".gltf") return "model/gltf+json";
  if (bytes) {
    const sniffed = sniffMediaType(bytes);
    if (sniffed !== "application/octet-stream") return sniffed;
  }
  if (ext === ".png") return PNG;
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".json") return JSON_TYPE;
  if (ext === ".md") return MARKDOWN;
  return "application/octet-stream";
}

function is3d(path: string): boolean {
  return extname(path).toLowerCase() === ".glb";
}

const encoder = new TextEncoder();
function size(content: Content): number {
  return "text" in content ? encoder.encode(content.text).length : content.blob.length;
}

/** A project-relative path with `/`. */
function rel(project: Project, path: string): string {
  return relative(project.dir, path).split(sep).join("/");
}

/** The JSON pointer that stands in for content over the limit. */
function pointer(
  address: string,
  extra: { path?: string; mediaType: string; bytes: number },
): Record<string, unknown> {
  return { address, kind: "file", ...extra, tooLarge: true, limit: READ_LIMIT };
}

/** Builds a read's contents within the limit, in order: the JSON document, text, then an image. */
class Reader {
  readonly contents: Content[] = [];
  used = 0;
  document?: Record<string, unknown>;
  readonly address: string;
  readonly project: Project;
  constructor(address: string, project: Project) {
    this.address = address;
    this.project = project;
  }

  get left(): number {
    return READ_LIMIT - this.used;
  }

  private push(content: Content): boolean {
    const n = size(content);
    if (n > this.left) return false;
    this.contents.push(content);
    this.used += n;
    return true;
  }

  json(doc: Record<string, unknown>): void {
    const text = JSON.stringify(doc);
    if (!this.push({ uri: this.address, mimeType: JSON_TYPE, text })) {
      const stand = pointer(this.address, {
        mediaType: JSON_TYPE,
        bytes: encoder.encode(text).length,
      });
      this.push({ uri: this.address, mimeType: JSON_TYPE, text: JSON.stringify(stand) });
      this.document = stand;
      return;
    }
    this.document ??= doc;
  }

  text(uri: string, mimeType: string, text: string, path?: string): void {
    if (this.push({ uri, mimeType, text })) return;
    this.json(
      pointer(uri, {
        ...(path && { path: rel(this.project, path) }),
        mediaType: mimeType,
        bytes: encoder.encode(text).length,
      }),
    );
  }

  /** A thumbnail of `sources` within what is left; nothing when none fits or none decodes. */
  thumb(sources: Uint8Array[], shape: ThumbShape): boolean {
    const png = thumbnail(sources, shape, this.left, this.project.thumbsDir);
    if (png === undefined) return false;
    return this.push({
      uri: this.address,
      mimeType: PNG,
      blob: Buffer.from(png).toString("base64"),
    });
  }

  blob(mimeType: string, bytes: Uint8Array, path?: string): void {
    if (base64Length(bytes.length) <= this.left) {
      this.push({ uri: this.address, mimeType, blob: Buffer.from(bytes).toString("base64") });
      return;
    }
    this.json(
      pointer(this.address, {
        ...(path && { path: rel(this.project, path) }),
        mediaType: mimeType,
        bytes: bytes.length,
      }),
    );
  }
}

/** The page of `children` after `after` (a child name), and the next page's address. */
function page(
  address: string,
  children: Child[],
  after: string | undefined,
): { children: Child[]; next?: string } {
  let start = 0;
  if (after !== undefined) {
    const at = children.findIndex((c) => c.name === after);
    if (at === -1) throw new InputError(`${address}: no child "${after}" to page after`);
    start = at + 1;
  }
  const slice = children.slice(start, start + PAGE_SIZE);
  const more = start + PAGE_SIZE < children.length;
  return { children: slice, ...(more && { next: pageAddress(address, slice.at(-1)!.name) }) };
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** The library as one read sees it. */
interface View {
  project: Project;
  game: string;
  assets: Map<string, Asset>;
  bible: string | undefined;
  /** Carded ids that are view names, so have no address; the root reports them. */
  reserved: string[];
}

function assetChild(view: View, asset: Asset): Child {
  return {
    address: formatAddress(view.game, [asset.id], true),
    name: asset.id,
    kind: "asset",
    ...(asset.state && { state: asset.state }),
  };
}

function folderChild(game: string, segments: string[], name = segments.at(-1)!): Child {
  return { address: formatAddress(game, segments, true), name, kind: "folder" };
}

function fileChild(game: string, segments: string[], name = segments.at(-1)!): Child {
  return { address: formatAddress(game, segments), name, kind: "file" };
}

/** The values a view groups assets by. */
function groups(view: View, by: "by-kind" | "by-subject" | "by-tag"): Map<string, Asset[]> {
  const out = new Map<string, Asset[]>();
  for (const asset of view.assets.values()) {
    const keys =
      by === "by-tag"
        ? asset.tags
        : [by === "by-kind" ? asset.kind : asset.subject].filter((k): k is string => !!k);
    for (const key of keys) {
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(asset);
    }
  }
  return out;
}

/** The run directories under the runs directory: each folder holding `run.json` or `request.json`. */
export function runIds(project: Project): string[] {
  let names: string[];
  try {
    names = readdirSync(project.runsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      const dir = join(project.runsDir, name);
      return existsSync(join(dir, "run.json")) || existsSync(join(dir, "request.json"));
    })
    .sort();
}

type JsonObject = Record<string, unknown>;

function readJsonObject(path: string): JsonObject | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

interface CandidateInfo {
  id: string;
  state: "staged" | "picked" | "rejected";
  file?: string;
  mediaType?: string;
  sha256?: string;
  reasons: unknown[];
  costUsd?: number;
  artifacts: string[];
  parameters?: unknown;
}

/** A run's candidates: each staged one, and each one QA filtered out (`c<n>`). */
function candidates(record: JsonObject | undefined): CandidateInfo[] {
  if (!record) return [];
  const picked = (record["picked"] as { candidateId?: string } | undefined)?.candidateId;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  const out: CandidateInfo[] = [];
  for (const c of (Array.isArray(record["candidates"])
    ? record["candidates"]
    : []) as JsonObject[]) {
    if (typeof c["id"] !== "string") continue;
    const provenance = c["provenance"] as JsonObject | undefined;
    const cost = provenance?.["costUsd"];
    const parameters = provenance?.["parameters"];
    out.push({
      id: c["id"],
      state: c["id"] === picked ? "picked" : "staged",
      ...(typeof c["file"] === "string" && { file: c["file"] }),
      ...(typeof c["mediaType"] === "string" && { mediaType: c["mediaType"] }),
      ...(typeof c["sha256"] === "string" && { sha256: c["sha256"] }),
      reasons: Array.isArray(c["reasons"]) ? c["reasons"] : [],
      ...(typeof cost === "number" && { costUsd: cost }),
      artifacts: strings(c["artifacts"]),
      ...(parameters !== undefined && { parameters }),
    });
  }
  const taken = new Set(out.map((c) => c.id));
  for (const r of (Array.isArray(record["rejections"])
    ? record["rejections"]
    : []) as JsonObject[]) {
    if (typeof r["candidate"] !== "number") continue;
    const id = `c${r["candidate"]}`;
    if (taken.has(id)) continue;
    out.push({
      id,
      state: "rejected",
      reasons: Array.isArray(r["reasons"]) ? r["reasons"] : [],
      ...(typeof r["costUsd"] === "number" && { costUsd: r["costUsd"] }),
      artifacts: strings(r["artifacts"]),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

/** A file inside the run directory, or undefined when the record names one outside it. */
function runFile(runDir: string, name: string): string | undefined {
  const path = join(runDir, name);
  const back = relative(runDir, path);
  if (back.startsWith("..") || back === "" || /^[\\/]/.test(back)) return undefined;
  return path;
}

/** A run's candidate files: each candidate of `run.json` that names a file inside the run folder. */
export function runCandidateFiles(project: Project, run: string): { id: string; file: string }[] {
  const dir = join(project.runsDir, run);
  const out: { id: string; file: string }[] = [];
  for (const c of candidates(readJsonObject(join(dir, "run.json")))) {
    const file = c.file === undefined ? undefined : runFile(dir, c.file);
    if (file !== undefined) out.push({ id: c.id, file });
  }
  return out;
}

function readBytes(path: string | undefined): Uint8Array | undefined {
  if (path === undefined) return undefined;
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return undefined;
  }
}

/** A strip's frame from provenance parameters (`frame`, `frameCount`); the whole image when absent. */
function shapeFrom(kind: unknown, parameters: unknown): ThumbShape {
  if (kind !== "sprite-strip" || parameters === null || typeof parameters !== "object") {
    return "image";
  }
  // An import records them at the top of its parameters; a generated strip under `postprocess`.
  const top = parameters as { frame?: JsonObject; frameCount?: unknown; postprocess?: unknown };
  const post = (
    top.postprocess !== null && typeof top.postprocess === "object" ? top.postprocess : {}
  ) as { frame?: JsonObject; frameCount?: unknown };
  const frame = top.frame ?? post.frame;
  const frameCount = top.frameCount ?? post.frameCount;
  if (
    typeof frame?.["width"] === "number" &&
    typeof frame["height"] === "number" &&
    typeof frameCount === "number"
  ) {
    return { strip: { width: frame["width"], height: frame["height"], count: frameCount } };
  }
  return "image";
}

/** How a library asset's image is cut for its thumbnail, from its own provenance record. */
function shapeOf(project: Project, asset: Asset): ThumbShape {
  if (asset.kind !== "sprite-strip") return "image";
  const path = sourcePath(project, asset, "provenance");
  const record = path === undefined ? undefined : readJsonObject(path);
  return shapeFrom(asset.kind, record?.["parameters"]);
}

function stillAsset(view: View, id: string): Asset {
  const asset = view.assets.get(id);
  if (!asset) throw new InputError(`asset://${view.game}/${id}/: no asset "${id}" in the library`);
  return asset;
}

/** The card's machine fields and tags: structure, never card text. */
function machine(asset: Asset): JsonObject {
  const data = asset.card.data;
  const out: JsonObject = { id: asset.id };
  for (const key of MACHINE_FIELDS) if (data[key] !== undefined) out[key] = data[key];
  out["tags"] = asset.tags;
  return out;
}

/** The card's text, each piece with where it came from. */
function cardText(asset: Asset): { source: string; text: string }[] {
  const data = asset.card.data;
  const out: { source: string; text: string }[] = [];
  if (typeof data["title"] === "string" && data["title"] !== "")
    out.push({ source: "card.title", text: data["title"] });
  if (typeof data["description"] === "string" && data["description"] !== "")
    out.push({ source: "card.description", text: data["description"] });
  if (asset.card.body.trim() !== "") out.push({ source: "card.body", text: asset.card.body });
  return out;
}

/** Bytes of a version: the working file, a run's candidate or the local Git LFS store. */
async function versionBytes(
  view: View,
  asset: Asset,
  sha256: string,
): Promise<{ bytes: Uint8Array; from: "working" | "run" | "lfs" } | undefined> {
  try {
    const media = await readMedia(mediaPath(view.project, asset));
    if (media.kind !== "lfs-pointer" && media.sha256 === sha256) {
      return { bytes: media.bytes, from: "working" };
    }
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
  }
  for (const run of runIds(view.project)) {
    const dir = join(view.project.runsDir, run);
    for (const c of candidates(readJsonObject(join(dir, "run.json")))) {
      if (c.sha256 !== sha256 || c.file === undefined) continue;
      const bytes = readBytes(runFile(dir, c.file));
      if (bytes && sha256Hex(bytes) === sha256) return { bytes, from: "run" };
    }
  }
  const gitDir = findGitDir(asset.dir);
  if (gitDir !== undefined) {
    const bytes = readBytes(lfsObjectPath(gitDir, sha256));
    if (bytes && sha256Hex(bytes) === sha256) return { bytes, from: "lfs" };
  }
  return undefined;
}

function folderDoc(
  address: string,
  listed: { children: Child[]; next?: string },
  extra: JsonObject,
) {
  return {
    address,
    kind: "folder",
    ...extra,
    children: listed.children,
    ...(listed.next && { next: listed.next }),
  };
}

async function readRoot(view: View, at: Address, r: Reader): Promise<void> {
  const { game } = view;
  const stale = [...view.assets.values()].filter((a) => isStale(a, view.bible)).length;
  const runs = runIds(view.project).length;
  const children: Child[] = [
    ...VIEWS.map((v) => folderChild(game, [v])),
    ...[...view.assets.values()].map((a) => assetChild(view, a)).sort(byName),
  ];
  const counts = {
    assets: view.assets.size,
    kinds: groups(view, "by-kind").size,
    subjects: groups(view, "by-subject").size,
    tags: groups(view, "by-tag").size,
    stale,
    runs,
  };
  r.json(
    folderDoc(r.address, page(r.address, children, at.after), {
      game,
      counts,
      ...(view.reserved.length > 0 && { reserved: view.reserved.sort() }),
    }),
  );
  const index = join(view.project.library.root, "index.md");
  if (existsSync(index)) {
    r.text(r.address, MARKDOWN, readFileSync(index, "utf8"), index);
  }
}

async function readView(view: View, at: Address, r: Reader): Promise<void> {
  const [name, value, ...rest] = at.segments as [string, string?, ...string[]];
  const { game } = view;
  if (rest.length > 0) throw new InputError(`${r.address}: no such address`);
  if (name === "stale") {
    if (value !== undefined) throw new InputError(`${r.address}: no such address`);
    const children = [...view.assets.values()]
      .filter((a) => isStale(a, view.bible))
      .map((a) => assetChild(view, a))
      .sort(byName);
    r.json(
      folderDoc(r.address, page(r.address, children, at.after), {
        ...(view.bible !== undefined && { bible: view.bible }),
      }),
    );
    return;
  }
  const grouped = groups(view, name as "by-kind" | "by-subject" | "by-tag");
  if (value === undefined) {
    const children = [...grouped.keys()].map((k) => folderChild(game, [name, k])).sort(byName);
    r.json(folderDoc(r.address, page(r.address, children, at.after), {}));
    return;
  }
  const members = grouped.get(value);
  if (!members) throw new InputError(`${r.address}: nothing in the library under "${value}"`);
  const children = members.map((a) => assetChild(view, a)).sort(byName);
  r.json(folderDoc(r.address, page(r.address, children, at.after), {}));
}

/** A run's state as `assetgrove runs` words it; "running" only while its lock is held. */
function runState(dir: string, record: JsonObject | undefined): string {
  const status = readRunState(dir)?.status;
  if (status === "running") return runLockLive(dir) ? "running" : "interrupted";
  if (status === "finished" || status === "failed") return status;
  if (record) return record["ok"] === false ? "failed" : "finished";
  return runLockLive(dir) ? "running" : "interrupted";
}

async function readRuns(view: View, at: Address, r: Reader): Promise<void> {
  const [, run, candidate, ...rest] = at.segments;
  const { game } = view;
  if (rest.length > 0) throw new InputError(`${r.address}: no such address`);
  if (run === undefined) {
    const children = runIds(view.project).map((id) => folderChild(game, ["runs", id]));
    r.json(folderDoc(r.address, page(r.address, children, at.after), {}));
    return;
  }
  if (!runIds(view.project).includes(run)) {
    throw new InputError(
      `${r.address}: no run "${run}" in ${rel(view.project, view.project.runsDir)}`,
    );
  }
  const dir = join(view.project.runsDir, run);
  const record = readJsonObject(join(dir, "run.json"));
  const list = candidates(record);
  const spec = (record?.["spec"] ?? {}) as JsonObject;
  if (candidate === undefined) {
    const children = list.map((c) => ({
      address: formatAddress(game, ["runs", run, c.id]),
      name: c.id,
      kind: "candidate" as const,
      state: c.state,
    }));
    const num = (k: string) => (typeof record?.[k] === "number" ? { [k]: record[k] } : {});
    r.json(
      folderDoc(r.address, page(r.address, children, at.after), {
        run: {
          id: run,
          state: runState(dir, record),
          ...(typeof spec["kind"] === "string" && { assetKind: spec["kind"] }),
          ...(typeof spec["assetId"] === "string" && { assetId: spec["assetId"] }),
          ...(typeof record?.["command"] === "string" && { command: record["command"] }),
          ...num("requested"),
          ...num("filtered"),
          ...num("spentUsd"),
          ...num("capUsd"),
        },
      }),
    );
    return;
  }
  const found = list.find((c) => c.id === candidate);
  if (!found) throw new InputError(`${r.address}: run ${run} has no candidate "${candidate}"`);
  const file = found.file === undefined ? undefined : runFile(dir, found.file);
  r.json({
    address: r.address,
    kind: "candidate",
    run: run,
    id: found.id,
    state: found.state,
    ...(file && { path: rel(view.project, file) }),
    ...(found.mediaType && { mediaType: found.mediaType }),
    ...(found.sha256 && { sha256: found.sha256 }),
    reasons: found.reasons,
    ...(found.costUsd !== undefined && { costUsd: found.costUsd }),
    ...(found.artifacts.length > 0 && { artifacts: found.artifacts }),
  });
  const bytes = readBytes(file);
  const shape = shapeFrom(spec["kind"], found.parameters);
  if (bytes && found.mediaType?.startsWith("image/")) {
    r.thumb([bytes], shape);
  } else {
    const frames = found.artifacts
      .filter((a) => a.endsWith(".png"))
      .map((a) => readBytes(runFile(dir, a)))
      .filter((b): b is Uint8Array => b !== undefined);
    if (frames.length > 0) r.thumb(frames, "row");
  }
}

async function readAsset(view: View, at: Address, r: Reader): Promise<ReadResult["bytes"]> {
  const [id, file, sub, ...rest] = at.segments as [string, string?, string?, ...string[]];
  const asset = stillAsset(view, id);
  const { game, project } = view;
  // Every read of an asset checks every path its card names first.
  checkedCard(project, asset);
  if (file === undefined) {
    const review = readAssetReview(project, asset);
    const children: Child[] = [
      fileChild(game, [id, "card"]),
      ...(sourcePath(project, asset, "provenance") ? [fileChild(game, [id, "provenance"])] : []),
      ...(review ? [fileChild(game, [id, "review"])] : []),
      fileChild(game, [id, "log"]),
      fileChild(game, [id, "image"]),
      fileChild(game, [id, "image", "full"], "image/full"),
      ...(review ? [folderChild(game, [id, "versions"])] : []),
    ];
    r.json({
      ...folderDoc(r.address, page(r.address, children, at.after), {
        asset: { ...machine(asset), stale: isStale(asset, view.bible) },
      }),
      sharedText: cardText(asset),
    });
    return undefined;
  }
  if (!(ASSET_FILES as readonly string[]).includes(file)) {
    throw new InputError(`${r.address}: an asset has no "${file}"`);
  }
  if (file !== "image" && file !== "versions" && sub !== undefined) {
    throw new InputError(`${r.address}: no such address`);
  }
  if (rest.length > 0) throw new InputError(`${r.address}: no such address`);
  if (file === "card") {
    const text = readFileSync(asset.cardPath, "utf8");
    r.text(r.address, MARKDOWN, text, asset.cardPath);
    return encoder.encode(text);
  }
  if (file === "provenance" || file === "review") {
    const path =
      file === "review"
        ? (sourcePath(project, asset, "review") ?? join(asset.dir, `${id}.review.json`))
        : sourcePath(project, asset, "provenance");
    if (file === "review") readAssetReview(project, asset);
    const bytes = readBytes(path);
    if (path === undefined || bytes === undefined) {
      throw new InputError(`${r.address}: the asset has no ${file} record`);
    }
    r.text(r.address, JSON_TYPE, Buffer.from(bytes).toString("utf8"), path);
    return bytes;
  }
  if (file === "log") {
    const review = readAssetReview(project, asset);
    const title = typeof asset.card.data["title"] === "string" ? asset.card.data["title"] : id;
    const text = review ? renderLog(logEntriesFromReview(review, { id, title })) : "# Log\n";
    r.text(r.address, MARKDOWN, text);
    return encoder.encode(text);
  }
  if (file === "image") return readImage(view, asset, sub, r);
  return readVersions(view, asset, sub, at, r);
}

async function readImage(
  view: View,
  asset: Asset,
  sub: string | undefined,
  r: Reader,
): Promise<ReadResult["bytes"]> {
  if (sub !== undefined && sub !== "full") throw new InputError(`${r.address}: no such address`);
  const path = mediaPath(view.project, asset);
  const media = await readMedia(path);
  const mediaType = mediaTypeOf(path, media.kind === "lfs-pointer" ? undefined : media.bytes);
  const where = { path: rel(view.project, path), mediaType, sha256: media.sha256 };
  if (media.kind === "lfs-pointer") {
    // The bytes are not on this machine: say so, with no image.
    r.json({ address: r.address, kind: "file", ...where, bytes: media.pointer.size, local: false });
    return undefined;
  }
  if (sub === "full") {
    r.blob(mediaType, media.bytes, path);
    return media.bytes;
  }
  if (is3d(path)) {
    let frames: string[];
    try {
      frames = turntableViews(path);
    } catch {
      frames = [];
    }
    r.json({
      address: r.address,
      kind: "model",
      ...where,
      bytes: media.bytes.length,
      frames: frames.map((f) => rel(view.project, f)),
    });
    const images = frames.map((f) => readBytes(f)).filter((b): b is Uint8Array => !!b);
    if (images.length > 0) r.thumb(images, "row");
    return media.bytes;
  }
  if (!r.thumb([media.bytes], shapeOf(view.project, asset))) {
    r.json({ address: r.address, kind: "file", ...where, bytes: media.bytes.length });
  }
  return media.bytes;
}

async function readVersions(
  view: View,
  asset: Asset,
  sub: string | undefined,
  at: Address,
  r: Reader,
): Promise<ReadResult["bytes"]> {
  const review: ReviewRecord | undefined = readAssetReview(view.project, asset);
  const versions = review?.versions ?? [];
  const { game } = view;
  if (sub === undefined) {
    const children: Child[] = versions.map((v, i) => ({
      address: formatAddress(game, [asset.id, "versions", String(i + 1)]),
      name: String(i + 1),
      kind: "version",
      state: versionStatus(review!, v.sha256),
    }));
    r.json(folderDoc(r.address, page(r.address, children, at.after), {}));
    return undefined;
  }
  const n = /^[1-9][0-9]*$/.test(sub) ? Number(sub) : NaN;
  const version = versions[n - 1];
  if (!version) throw new InputError(`${r.address}: ${asset.id} has no version ${sub}`);
  const found = await versionBytes(view, asset, version.sha256);
  const path = mediaPath(view.project, asset);
  r.json({
    address: r.address,
    kind: "version",
    asset: asset.id,
    n,
    ...version,
    status: versionStatus(review!, version.sha256),
    current: n === versions.length,
    image: found?.from ?? null,
  });
  if (found && !is3d(path)) r.thumb([found.bytes], shapeOf(view.project, asset));
  return undefined;
}

/** The library as it is now, for one read. */
function viewOf(project: Project, game: string): View {
  if (game !== project.library.game) {
    throw new InputError(`this project's game is "${project.library.game}", not "${game}"`);
  }
  const reserved: string[] = [];
  const assets = loadAssets(project, reserved);
  return { project, game, assets, reserved, bible: bibleVersionOf(join(project.dir, BIBLE_PATH)) };
}

/** Whether segments below a game root name a folder (views, runs, an asset, its versions). */
export function isFolder(segments: readonly string[]): boolean {
  const [first] = segments;
  if (first === undefined) return true;
  if ((VIEWS as readonly string[]).includes(first)) return segments.length <= 2;
  return segments.length === 1 || (segments.length === 2 && segments[1] === "versions");
}

/** An address in its canonical form: folders end in `/`, files do not; the page cursor is dropped. */
export function canonicalAddress(text: string): string {
  const at = parseAddress(text);
  return formatAddress(at.game, at.segments, isFolder(at.segments));
}

/** Reads one address of the project's tree; an unknown address exits 2 `invalid_input`. */
export async function readTree(project: Project, address: string): Promise<ReadResult> {
  const at = parseAddress(address);
  const view = viewOf(project, at.game);
  const [first] = at.segments;
  const folder = isFolder(at.segments);
  if (!folder && at.after !== undefined) {
    throw new InputError(`${address}: only a folder read takes ?after=`);
  }
  const canonical = formatAddress(at.game, at.segments, folder);
  const shown = at.after === undefined ? canonical : pageAddress(canonical, at.after);
  const r = new Reader(shown, project);
  let bytes: Uint8Array | undefined;
  if (first === undefined) await readRoot(view, at, r);
  else if (first === "runs") await readRuns(view, at, r);
  else if ((VIEWS as readonly string[]).includes(first)) await readView(view, at, r);
  else bytes = await readAsset(view, at, r);
  return {
    address: shown,
    contents: r.contents,
    ...(r.document && { document: r.document }),
    folder,
    ...(bytes && { bytes }),
  };
}
