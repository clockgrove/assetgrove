/**
 * The package blocklist of the prompt policy (design section 16): `policy/blocklist.json`, format
 * `assetgrove-blocklist/1`, the terms the policy looks for. An unambiguous name refuses for free; a
 * phrase or a name marked `ambiguous` is a hit the model check decides. Names in it are exempt from
 * the names rule (docs/decisions.md).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InputError } from "../errors.ts";
import { readFormat } from "../formats.ts";

/** Whether a hit on `term` refuses for free: a name not marked ambiguous. */
export function refusesFree(term: { kind: BlockKind; ambiguous?: boolean }): boolean {
  return term.kind !== "phrase" && term.ambiguous !== true;
}

/** What a term names: an imitation phrase, an artist, a studio, a game or a character. */
export type BlockKind = "phrase" | "artist" | "studio" | "game" | "character" | "person";

export interface BlockTerm {
  term: string;
  kind: BlockKind;
  /**
   * A name that is also an ordinary word or a given name (a kind of weather, a kind of star, a
   * common first name): a hit on it is decided by the model check, not refused for free.
   */
  ambiguous?: boolean;
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
        !KINDS.has((t as BlockTerm).kind) ||
        ((t as BlockTerm).ambiguous !== undefined &&
          typeof (t as BlockTerm).ambiguous !== "boolean"),
    )
  )
    throw new InputError(`${path}: terms must be a list of {term, kind, ambiguous?}`);
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
