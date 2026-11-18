/**
 * Whether the art direction changed in a way that means an asset should be redone (#366).
 *
 * "Made under another bible version" is an exact count: the card's `bible` differs from the style
 * bible's current `version`, compared for equality, never order, so a rollback or a renamed
 * version counts as well as a bump. Which of those are stale is a decision: one Boolean
 * `bible-staleness` call per (asset sha256, card version, current version), given the bible's diff
 * between the two versions, the asset's kind, subject and tags and its thumbnail, and cached in
 * `<stateDir>/staleness/`. Reads (`library drift`, `asset://<game>/stale/`) list the cached yes
 * answers and never call a model; only `library judge-stale`, which a person starts, makes calls.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { splitFrontMatter } from "../bible.ts";
import type { Caller } from "../calls.ts";
import { turntableViews } from "../compare.ts";
import { ProviderError } from "../errors.ts";
import { CORE_REGISTRY } from "../extensions/registry.ts";
import { isStripKind } from "../frames.ts";
import type { KindTraits } from "../frames.ts";
import { STALENESS_OPERATION } from "../routes.ts";
import { stripShape, thumbnail } from "../tree/thumbs.ts";
import type { ThumbShape } from "../tree/thumbs.ts";
import { findProvenance } from "./adopt.ts";
import type { LoadedReference } from "../types.ts";
import { sha256Hex } from "./canonical.ts";
import { readMedia } from "./lfs.ts";

/** The `version` of a JSON or Markdown style bible's text; undefined when it has none. */
export function bibleVersionOfText(text: string, json: boolean): string | undefined {
  try {
    const data = json ? JSON.parse(text) : parseYaml(splitFrontMatter(text).front);
    const version = (data as { version?: unknown } | null)?.version;
    return typeof version === "string" || typeof version === "number" ? String(version) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an asset was made under another bible version than the current one: equality only. */
export function madeUnderOtherVersion(
  cardBible: string | undefined,
  current: string | undefined,
): boolean {
  return cardBible !== undefined && current !== undefined && cardBible !== current;
}

/** One cached answer: whether the asset with this media should be redone for this version pair. */
export interface StalenessAnswer {
  /** The media's sha256 (the card's `lock.sha256`). */
  sha256: string;
  /** The bible version the asset was made under. */
  from: string;
  /** The bible version it was judged against. */
  to: string;
  /** True when the call answered that the asset should be redone. */
  redo: boolean;
  /** The probability the model gave that it should be redone, when it reported one. */
  probability?: number;
  /**
   * True: the call was given the bible's diff from its Git history (an asset whose version the
   * history does not hold, or whose diff cannot be made, is left unjudged).
   */
  history: true;
  /** True: the call was shown the asset's thumbnail (an asset with none is left unjudged). */
  thumbnail: true;
  model: string;
  at: string;
}

/** The cached answers, one file per asset sha256 and version pair, under `<stateDir>/staleness/`. */
export class StalenessCache {
  readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "staleness");
  }

  private file(sha256: string, from: string, to: string): string {
    return join(this.dir, `${sha256}-${sha256Hex(JSON.stringify([from, to])).slice(0, 16)}.json`);
  }

  /** The cached answer for the asset and version pair; undefined when it was never judged. */
  get(sha256: string, from: string, to: string): StalenessAnswer | undefined {
    try {
      const value = JSON.parse(readFileSync(this.file(sha256, from, to), "utf8")) as
        Partial<StalenessAnswer> | undefined;
      if (
        !value ||
        value.sha256 !== sha256 ||
        value.from !== from ||
        value.to !== to ||
        typeof value.redo !== "boolean" ||
        value.history !== true ||
        value.thumbnail !== true
      )
        return undefined;
      return value as StalenessAnswer;
    } catch {
      return undefined;
    }
  }

  set(answer: StalenessAnswer): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(answer.sha256, answer.from, answer.to);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(answer, null, 2)}\n`);
    renameSync(temp, file);
  }
}

/** What an asset's staleness judgement is: `redo`, `keep`, or `unjudged` while nothing is cached. */
export type Judgement = "redo" | "keep" | "unjudged";

/** The cached judgement of an asset made under `from`, against `to`. */
export function judgementOf(
  cache: StalenessCache,
  sha256: string | undefined,
  from: string,
  to: string,
): Judgement {
  if (sha256 === undefined) return "unjudged";
  const answer = cache.get(sha256, from, to);
  return answer === undefined ? "unjudged" : answer.redo ? "redo" : "keep";
}

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** The most diff text one call is given; the rest is cut with a note. */
const DIFF_LIMIT = 12_000;

function cut(text: string): string {
  return text.length <= DIFF_LIMIT
    ? text
    : `${text.slice(0, DIFF_LIMIT)}\n[… ${text.length - DIFF_LIMIT} more characters not shown]`;
}

/** The bible's text at an earlier version, from its Git history. */
export interface BibleChange {
  /** The commit whose bible text has the earlier version. */
  commit: string;
  /** The unified diff from that text to the current file, or a note that the two texts match. */
  diff: string;
}

/**
 * The bible's change from version `from` to its current text: the newest commit of the bible
 * file whose text carries `from`, diffed with `git diff` against the working file. Undefined when
 * no commit holds that version (the file was never committed at it, or it is outside Git) or the
 * diff cannot be made: with no change to show, the asset is not judged.
 */
export function bibleChange(biblePath: string, from: string): BibleChange | undefined {
  const dir = dirname(biblePath);
  const name = basename(biblePath);
  const json = extname(name).toLowerCase() === ".json";
  const commits = (git(dir, ["log", "--format=%H", "--", name]) ?? "")
    .split(/\r?\n/)
    .filter((line) => /^[0-9a-f]{40,64}$/.test(line));
  for (const commit of commits) {
    const text = git(dir, ["show", `${commit}:./${name}`]);
    if (text === undefined || bibleVersionOfText(text, json) !== from) continue;
    const diff = git(dir, ["diff", "--no-color", "--no-ext-diff", commit, "--", name]);
    if (diff === undefined) return undefined;
    return {
      commit,
      diff:
        diff.trim() === ""
          ? "(none: the bible's text is the same as at that version, and the same as its working file)"
          : cut(diff),
    };
  }
  return undefined;
}

/** One asset made under another bible version, as the judgement needs it. */
export interface StaleSubject {
  asset: string;
  /** The media file, absolute. */
  media: string;
  /** The provenance file the card names, absolute: a strip's frame size is read from it. */
  provenance?: string;
  /** The card's `lock.sha256`. */
  sha256: string;
  /** The bible version the card names. */
  from: string;
  kind?: string;
  subject?: string;
  tags: string[];
}

/** How a strip is cut, as the tree's thumbnail cuts it: the frames its provenance records. */
function stalenessShape(subject: StaleSubject, traits: KindTraits): ThumbShape {
  if (!isStripKind(subject.kind, traits) || subject.provenance === undefined) return "image";
  try {
    const record = findProvenance(JSON.parse(readFileSync(subject.provenance, "utf8")));
    return stripShape(subject.kind, record?.parameters, traits);
  } catch {
    return "image";
  }
}

/** The thumbnail the call is shown: 512 px at most, a strip's key frames, a 3D asset's turntable. */
export async function stalenessThumbnail(
  subject: StaleSubject,
  traits: KindTraits = CORE_REGISTRY,
): Promise<LoadedReference[]> {
  const budget = 4 * 1024 * 1024;
  let png: Uint8Array | undefined;
  if (extname(subject.media).toLowerCase() === ".glb") {
    let frames: string[];
    try {
      frames = turntableViews(subject.media);
    } catch {
      frames = [];
    }
    const images = frames.flatMap((f) => {
      try {
        return [new Uint8Array(readFileSync(f))];
      } catch {
        return [];
      }
    });
    png = thumbnail(images, "row", budget);
  } else {
    try {
      const media = await readMedia(subject.media);
      if (media.kind !== "lfs-pointer")
        png = thumbnail([media.bytes], stalenessShape(subject, traits), budget);
    } catch {
      png = undefined;
    }
  }
  if (png === undefined) return [];
  return [
    {
      role: "thumbnail",
      path: subject.media,
      mediaType: "image/png",
      bytes: png,
      sha256: sha256Hex(png),
    },
  ];
}

/** The text the staleness call is given. */
export function stalenessPrompt(subject: StaleSubject, to: string, change: BibleChange): string {
  return [
    `An asset in a game's library was made under version "${subject.from}" of the game's style bible (its art direction). The bible is now at version "${to}".`,
    `The asset: kind ${subject.kind ?? "unknown"}, subject ${subject.subject ?? "unknown"}, tags ${subject.tags.length > 0 ? subject.tags.join(", ") : "none"}.`,
    "The image is its thumbnail.",
    `The bible's change between the two versions, as a unified diff from Git: only the first character of each line marks it, "-" for text only in version "${subject.from}", "+" for text only in the current bible, a space for text in both (so a Markdown bullet removed reads "-- ", one kept reads " - "):`,
    change.diff,
  ].join("\n");
}

/** The Boolean question the staleness call answers. */
export const STALENESS_QUESTION = {
  type: "boolean",
  instructions:
    "Does this change in the art direction mean this asset should be redone? Answer true only when the change affects how an asset like this one should look; a change that leaves it as the bible now wants (a typo fix, a rule for other kinds or subjects) is false.",
  whenTrue: "the asset should be redone under the current bible",
  whenFalse: "the asset still fits the current bible",
} as const;

/**
 * Judges one asset: one `bible-staleness` decision through the caller (inside the run's budget),
 * shown its thumbnail (`stalenessThumbnail`), cached by the asset's sha256 and the version pair.
 * An asset with no thumbnail on this machine is never judged: the caller leaves it unjudged.
 */
export async function judgeStaleness(
  caller: Caller,
  subject: StaleSubject,
  to: string,
  change: BibleChange,
  cache: StalenessCache,
  images: LoadedReference[],
  now: () => Date = () => new Date(),
): Promise<StalenessAnswer> {
  if (images.length === 0)
    throw new ProviderError(`${subject.asset}: no thumbnail, so its staleness is not judged`);
  const { result, record } = await caller.decide(
    STALENESS_OPERATION,
    stalenessPrompt(subject, to, change),
    images,
    { ...STALENESS_QUESTION },
  );
  if (result.answer.type !== "boolean")
    throw new ProviderError(`the ${STALENESS_OPERATION} decision gave no Boolean answer`);
  const probability = result.answer.probability;
  const answer: StalenessAnswer = {
    sha256: subject.sha256,
    from: subject.from,
    to,
    redo: probability >= 0.5,
    probability: Math.round(probability * 1e4) / 1e4,
    history: true,
    thumbnail: true,
    model: record.model,
    at: now().toISOString(),
  };
  cache.set(answer);
  return answer;
}
