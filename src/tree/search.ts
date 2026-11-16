/**
 * The tree's search paths (design sections 2 and 7.5), served while the search slot is loaded:
 * `find/{words}`, `like/{asset}` and `where/{filter}` under the game root. Each runs the same find
 * as the `find` command with the same input, so both return the same hits. A read never spends and
 * writes no sheet.
 */
import { InputError } from "../errors.ts";
import { formatAddress, parseAddress } from "./address.ts";

/** The search paths' first segments. */
export const SEARCH_PATHS = ["find", "like", "where"] as const;
export type SearchPath = (typeof SEARCH_PATHS)[number];

/** The find input of `find`'s own arguments that a search path stands for. */
export interface PathQuery {
  words?: string;
  like?: string;
  where?: string[];
}

/** The search path an address names, with its find input; undefined for any other address. */
export function parseSearchPath(
  uri: string,
  game: string,
): { address: string; query: PathQuery } | undefined {
  let at;
  try {
    at = parseAddress(uri);
  } catch {
    return undefined;
  }
  const [first, value, ...rest] = at.segments;
  if (!(SEARCH_PATHS as readonly string[]).includes(first ?? "")) return undefined;
  if (at.game !== game) {
    throw new InputError(`this project's game is "${game}", not "${at.game}"`);
  }
  if (value === undefined || rest.length > 0 || at.folder) {
    throw new InputError(
      `${uri}: a search path is ${first}/{${first === "find" ? "words" : first === "like" ? "asset" : "filter"}}`,
    );
  }
  const address = formatAddress(at.game, at.segments);
  if (first === "find") return { address, query: { words: value } };
  if (first === "where") return { address, query: { where: [value] } };
  return { address, query: { like: formatAddress(at.game, [value]) } };
}

/** The templates `resources/templates/list` adds while the slot is loaded. */
export function searchTemplates(
  base: string,
): { uriTemplate: string; name: string; mimeType: string }[] {
  const json = "application/json";
  return [
    { uriTemplate: `${base}/find/{words}`, name: "assets found by words", mimeType: json },
    { uriTemplate: `${base}/like/{asset}`, name: "assets that look like an asset", mimeType: json },
    { uriTemplate: `${base}/where/{filter}`, name: "assets whose fields match", mimeType: json },
  ];
}
