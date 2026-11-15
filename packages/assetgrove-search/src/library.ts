/**
 * What the indexer reads. Core supplies the real library reader (design section 7.1: picks with
 * card fields and text, bible references, run candidates, folders from settings); the package
 * defines the shape it needs, so the indexer and its tests do not depend on core.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Row } from "./store.ts";

/** One indexable file, as listed: cheap to produce, no file contents read. */
export interface LibraryItem {
  /** The file's path inside the work tree, `/`-separated. */
  path: string;
  size: number;
  mtimeMs: number;
  source: Row["source"];
  id: string;
  address: string;
  game?: string;
  kind?: string;
  subject?: string;
  tags?: string[];
  state?: string;
  bible?: string;
  license?: string;
  title?: string;
  description?: string;
  /** The card fields and body joined; full-text indexed and embedded as the card-text vector. */
  text?: string;
}

/** An item loaded on demand: the file's bytes and each image view to embed. */
export interface LoadedItem {
  bytes: Uint8Array;
  /** One per view; a still image has one view named `""`. */
  views: { view: string; image: Uint8Array }[];
}

export interface Library {
  list(): Promise<LibraryItem[]>;
  load(item: LibraryItem): Promise<LoadedItem>;
  /** The commit the work tree is on, recorded as `builtFrom.head`. */
  head?(): Promise<string>;
}

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

/** The key of a work tree's rows: the sha256 of its real path. */
export function treeKey(worktree: string): string {
  return sha256Hex(realpathSync(worktree));
}

/** The text an item is full-text indexed and embedded by. */
export function itemText(item: LibraryItem): string {
  if (item.text !== undefined) return item.text;
  return [item.title, item.subject, item.kind, ...(item.tags ?? []), item.description]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .join("\n");
}

/** The sha256 of an item's card fields and text: what decides whether its rows need rewriting. */
export function itemMeta(item: LibraryItem): string {
  const stat = new Set(["path", "size", "mtimeMs"]);
  const sorted = Object.fromEntries(
    Object.entries({ ...item, text: itemText(item) })
      .filter(([k]) => !stat.has(k))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return sha256Hex(JSON.stringify(sorted));
}
