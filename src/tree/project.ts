/**
 * The project the asset tree serves (design section 2): the profile `init` wrote at the working
 * directory's Git top level, or at `--target`, its library and its runs. Assets are found by id
 * through their cards, never by a stored path; every path a card names passes the library path
 * rule before it is read.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitTopLevel } from "../approvals.ts";
import { InputError } from "../errors.ts";
import { VIEWS } from "./address.ts";
import { PROFILE_PATH } from "../init.ts";
import { loadProfile } from "../inputs.ts";
import { checkCardPaths, parseCard } from "../library/card.ts";
import type { Card } from "../library/card.ts";
import { libraryPath } from "../library/paths.ts";
import { checkReviewPaths, parseReview } from "../library/review.ts";
import type { ReviewRecord } from "../library/review.ts";
import { StalenessCache, judgementOf, madeUnderOtherVersion } from "../library/stale.ts";
import type { Judgement } from "../library/stale.ts";
import { libraryConfig, scanCards } from "../library/write.ts";
import type { LibraryConfig } from "../library/write.ts";
import { DEFAULT_RUNS } from "../runs/plan.ts";
import type { TargetProfile } from "../types.ts";

export interface Project {
  /** The project directory, absolute. */
  dir: string;
  profile: TargetProfile;
  library: LibraryConfig;
  /** The runs directory, `<project>/.assetgrove/runs`. */
  runsDir: string;
  /** Where thumbnails are cached (`<stateDir>/thumbs/`). */
  thumbsDir: string;
  /** The cached staleness answers (`<stateDir>/staleness/`), read only: a read never judges. */
  staleness: StalenessCache;
}

/** The directory the tree serves: `target`, else the Git top level of `cwd`, else `cwd`. */
export function projectDir(target: string | undefined, cwd = process.cwd()): string {
  if (target !== undefined) return resolve(cwd, target);
  return gitTopLevel(cwd) ?? resolve(cwd);
}

/** Opens the project at `dir`; a missing or invalid profile exits 2 `invalid_input`. */
export async function openProject(dir: string, stateDir: string): Promise<Project> {
  const profilePath = join(dir, PROFILE_PATH);
  if (!existsSync(profilePath)) {
    throw new InputError(
      `${dir} has no ${PROFILE_PATH}; run assetgrove init there or pass --target`,
    );
  }
  const { value: profile } = await loadProfile(profilePath);
  return {
    dir,
    profile,
    library: libraryConfig(profile, dir),
    runsDir: resolve(dir, DEFAULT_RUNS),
    thumbsDir: join(stateDir, "thumbs"),
    staleness: new StalenessCache(stateDir),
  };
}

/** One asset of the library, as its card says. */
export interface Asset {
  id: string;
  /** The folder holding the card, absolute. */
  dir: string;
  cardPath: string;
  card: Card;
  kind?: string;
  subject?: string;
  state?: string;
  version?: number;
  bible?: string;
  tags: string[];
}

/**
 * Every asset under the library root by id; the first card found wins an id carded twice. An id
 * that is a view's name (`runs`, `stale`, `by-kind`, `by-subject`, `by-tag`) has no address of its
 * own, since `asset://<game>/<view>/` reads the view: it is left out and pushed onto `reserved`.
 */
export function loadAssets(project: Project, reserved?: string[]): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  for (const found of scanCards(project.library.root)) {
    if (assets.has(found.id)) continue;
    if ((VIEWS as readonly string[]).includes(found.id)) {
      if (!reserved?.includes(found.id)) reserved?.push(found.id);
      continue;
    }
    const cardPath = join(found.dir, `${found.id}.md`);
    let card: Card;
    try {
      card = parseCard(readFileSync(cardPath, "utf8"), cardPath);
    } catch {
      continue;
    }
    const data = card.data as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
    const tags = Array.isArray(data["tags"])
      ? (data["tags"] as unknown[]).filter((t): t is string => typeof t === "string" && t !== "")
      : [];
    const kind = text(data["kind"]);
    const subject = text(data["subject"]);
    const state = text(data["state"]);
    assets.set(found.id, {
      id: found.id,
      dir: found.dir,
      cardPath,
      card,
      ...(kind && { kind }),
      ...(subject && { subject }),
      ...(state && { state }),
      ...(typeof data["version"] === "number" && { version: data["version"] }),
      ...(found.bible !== undefined && { bible: found.bible }),
      tags: [...new Set(tags)],
    });
  }
  return assets;
}

/** The asset's card, its paths checked: one that leaves the library root exits 2 `invalid_input`. */
export function checkedCard(project: Project, asset: Asset): Card {
  checkCardPaths(asset.card, project.library.root, asset.dir, asset.cardPath);
  return asset.card;
}

/** The absolute path of a card source (`provenance`, `review`), checked, or undefined when absent. */
export function sourcePath(project: Project, asset: Asset, id: string): string | undefined {
  const sources = (asset.card.data["sources"] ?? []) as { id: string; resource: string }[];
  const source = sources.find((s) => s.id === id);
  if (source === undefined) return undefined;
  return libraryPath(project.library.root, asset.dir, source.resource, asset.cardPath);
}

/** The asset's media file, checked by the path rule. */
export function mediaPath(project: Project, asset: Asset): string {
  checkedCard(project, asset);
  return libraryPath(
    project.library.root,
    asset.dir,
    asset.card.data["resource"] as string,
    asset.cardPath,
  );
}

/** The asset's review record: its `review` source, else `<id>.review.json` beside the card. */
export function reviewPath(project: Project, asset: Asset): string {
  checkedCard(project, asset);
  return sourcePath(project, asset, "review") ?? join(asset.dir, `${asset.id}.review.json`);
}

/** The asset's review record, its paths checked; undefined when there is none. */
export function readAssetReview(project: Project, asset: Asset): ReviewRecord | undefined {
  const path = reviewPath(project, asset);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const record = parseReview(text, path);
  checkReviewPaths(record, project.library.root, asset.dir, path);
  return record;
}

/** Whether the asset was made under another bible version than the style bible's own: equality. */
export function otherVersion(asset: Asset, bible: string | undefined): boolean {
  return madeUnderOtherVersion(asset.bible, bible);
}

/**
 * The cached staleness judgement of an asset made under another bible version (`redo`, `keep` or
 * `unjudged`), or undefined when it was made under the current one. Never calls a model.
 */
export function judgement(
  project: Project,
  asset: Asset,
  bible: string | undefined,
): Judgement | undefined {
  if (!otherVersion(asset, bible)) return undefined;
  const lock = asset.card.data["lock"] as { sha256?: unknown } | undefined;
  const sha256 = typeof lock?.sha256 === "string" ? lock.sha256 : undefined;
  return judgementOf(project.staleness, sha256, asset.bible!, bible!);
}

/** Whether the asset is stale, as `library drift` says: judged (and cached) to need redoing. */
export function isStale(project: Project, asset: Asset, bible: string | undefined): boolean {
  return judgement(project, asset, bible) === "redo";
}
