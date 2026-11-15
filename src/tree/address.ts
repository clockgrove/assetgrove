/**
 * `asset://<game>/…` addresses (design section 2): the game, the path segments below it, whether
 * the address names a folder (a trailing `/`) and the page cursor `?after=<name>` of a folder read.
 * Segments are percent-encoded, so a tag or id with a space or `/` stays one segment.
 */
import { InputError } from "../errors.ts";

export const SCHEME = "asset://";

/** The views the game root lists before its assets. */
export const VIEWS = ["by-kind", "by-subject", "by-tag", "stale", "runs"] as const;

export interface Address {
  game: string;
  /** Decoded path segments below the game root; empty for the root. */
  segments: string[];
  /** Whether the address ends in `/` (or is the game root). */
  folder: boolean;
  /** The last child name of the previous page, for a folder read. */
  after?: string;
}

/** Parses an address; anything else exits 2 `invalid_input`. */
export function parseAddress(text: string): Address {
  if (typeof text !== "string" || !text.startsWith(SCHEME)) {
    throw new InputError(`"${String(text)}" is not an asset:// address`);
  }
  let rest = text.slice(SCHEME.length);
  let after: string | undefined;
  const query = rest.indexOf("?");
  if (query !== -1) {
    const params = new URLSearchParams(rest.slice(query + 1));
    for (const key of params.keys()) {
      if (key !== "after") throw new InputError(`${text}: unknown query parameter "${key}"`);
    }
    after = params.get("after") ?? undefined;
    rest = rest.slice(0, query);
  }
  if (rest.includes("#")) throw new InputError(`${text}: an address has no fragment`);
  const raw = rest.split("/");
  const game = decode(raw[0]!, text);
  if (game === "") throw new InputError(`${text}: the address names no game`);
  const tail = raw.slice(1);
  const folder = tail.length === 0 || tail.at(-1) === "";
  if (folder && tail.length > 0) tail.pop();
  const segments = tail.map((s) => decode(s, text));
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new InputError(`${text}: empty, "." or ".." segment`);
  }
  return { game, segments, folder: folder || segments.length === 0, ...(after && { after }) };
}

function decode(segment: string, text: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new InputError(`${text}: invalid percent-encoding`);
  }
}

/** The address of `segments` under the game, a folder when `folder`. */
export function formatAddress(game: string, segments: readonly string[], folder = false): string {
  const path = [game, ...segments].map((s) => encodeURIComponent(s)).join("/");
  return `${SCHEME}${path}${folder || segments.length === 0 ? "/" : ""}`;
}

/** The folder address with the page cursor after `name`. */
export function pageAddress(folder: string, name: string): string {
  return `${folder}?after=${encodeURIComponent(name)}`;
}
