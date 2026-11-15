/**
 * What the tree lists and how the server sees its own changes (design section 2): `resources/list`
 * returns the game root, every folder address and every card address, so an @-mention finds an
 * asset; the fingerprint of every asset and run folder tells which addresses a write changed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../library/canonical.ts";
import { VIEWS, formatAddress } from "./address.ts";
import { loadAssets, reviewPath } from "./project.ts";
import type { Project } from "./project.ts";
import { runIds } from "./read.ts";

export interface Listed {
  uri: string;
  name: string;
  mimeType: string;
}

/** Every listed address of the project's tree, in a stable order. */
export function listTree(project: Project): Listed[] {
  const game = project.library.game;
  const assets = [...loadAssets(project).values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const folder = (segments: string[], name: string): Listed => ({
    uri: formatAddress(game, segments, true),
    name,
    mimeType: "application/json",
  });
  const out: Listed[] = [folder([], game)];
  for (const view of VIEWS) out.push(folder([view], `${game} ${view}`));
  const values = (pick: (a: (typeof assets)[number]) => string[]) =>
    [...new Set(assets.flatMap(pick))].sort();
  for (const kind of values((a) => (a.kind ? [a.kind] : []))) {
    out.push(folder(["by-kind", kind], `${game} kind ${kind}`));
  }
  for (const subject of values((a) => (a.subject ? [a.subject] : []))) {
    out.push(folder(["by-subject", subject], `${game} subject ${subject}`));
  }
  for (const tag of values((a) => a.tags)) out.push(folder(["by-tag", tag], `${game} tag ${tag}`));
  for (const run of runIds(project)) out.push(folder(["runs", run], `${game} run ${run}`));
  for (const asset of assets) {
    out.push(folder([asset.id], asset.id));
    out.push({
      uri: formatAddress(game, [asset.id, "card"]),
      name: `${asset.id} card`,
      mimeType: "text/markdown",
    });
  }
  return out;
}

function stamp(path: string): string {
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return "-";
  }
}

function dirStamp(dir: string): string {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return "-";
  }
  return sha256Hex(
    names
      .map((name) => {
        try {
          const s = statSync(join(dir, name));
          return `${name}:${s.size}:${s.mtimeMs}`;
        } catch {
          return name;
        }
      })
      .join("\n"),
  );
}

/**
 * A fingerprint of every asset folder (its card and review record) and every run folder (its
 * files), by address, and of the listing, so the server can tell what its own call changed.
 */
export function fingerprint(project: Project): { addresses: Map<string, string>; listing: string } {
  const game = project.library.game;
  const addresses = new Map<string, string>();
  for (const asset of loadAssets(project).values()) {
    let review = "-";
    try {
      review = stamp(reviewPath(project, asset));
    } catch {
      // A card naming a path outside the root shows its refusal at the next read.
    }
    addresses.set(formatAddress(game, [asset.id], true), `${stamp(asset.cardPath)}:${review}`);
  }
  for (const run of runIds(project)) {
    addresses.set(formatAddress(game, ["runs", run], true), dirStamp(join(project.runsDir, run)));
  }
  const listing = sha256Hex(
    listTree(project)
      .map((l) => l.uri)
      .join("\n"),
  );
  return { addresses, listing };
}

/** The addresses whose fingerprint differs between `before` and `after`, new ones included. */
export function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([address, value]) => before.get(address) !== value).map(([a]) => a);
}
