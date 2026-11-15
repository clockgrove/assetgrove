/**
 * The package blocklist of the prompt policy (design section 16): `policy/blocklist.json`, format
 * `assetgrove-blocklist/1`, the terms a prompt may not hold. Names in it are exempt from the
 * names rule (docs/decisions.md).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InputError } from "../errors.ts";
import { readFormat } from "../formats.ts";

/** What a term names: an imitation phrase, an artist, a studio, a game or a character. */
export type BlockKind = "phrase" | "artist" | "studio" | "game" | "character" | "person";

export interface BlockTerm {
  term: string;
  kind: BlockKind;
}

export interface Blocklist {
  terms: BlockTerm[];
  /** sha256 hex of the file's bytes. */
  sha256: string;
  path: string;
}

const KINDS: ReadonlySet<string> = new Set([
  "phrase",
  "artist",
  "studio",
  "game",
  "character",
  "person",
]);

/** The package blocklist's path: `policy/blocklist.json` at the package root (src/ and dist/ alike). */
export const BLOCKLIST_PATH: string = fileURLToPath(
  new URL("../../policy/blocklist.json", import.meta.url),
);

/** Reads and checks a blocklist file. */
export function readBlocklist(path: string = BLOCKLIST_PATH): Blocklist {
  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = readFileSync(path);
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new InputError(`cannot read the prompt blocklist ${path}`, { cause: error });
  }
  const { value } = readFormat("blocklist", parsed, path);
  const terms = (value as { terms?: unknown }).terms;
  if (
    !Array.isArray(terms) ||
    terms.some(
      (t: unknown) =>
        t === null ||
        typeof t !== "object" ||
        typeof (t as BlockTerm).term !== "string" ||
        !(t as BlockTerm).term.trim() ||
        !KINDS.has((t as BlockTerm).kind),
    )
  )
    throw new InputError(`${path}: terms must be a list of {term, kind}`);
  return {
    terms: terms as BlockTerm[],
    sha256: createHash("sha256").update(bytes).digest("hex"),
    path,
  };
}

let cached: Blocklist | undefined;

/** The package blocklist, read once. */
export function packageBlocklist(): Blocklist {
  return (cached ??= readBlocklist());
}
