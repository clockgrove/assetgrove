/**
 * The prompt policy's text check (design section 16): a request's prompt text, normalised (NFKC,
 * case, diacritics, spacing), matched against the package blocklist on word boundaries. A hit
 * not cleared by a settings allow term refuses the request with exit 9 `prompt_refused` and
 * `error.policy`, before confirmation and spend.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { doDontSection } from "../bible.ts";
import { packageBlocklist } from "./blocklist.ts";
import type { BlockKind, Blocklist } from "./blocklist.ts";

/** The blocklist term a prompt matched. */
export interface PolicyMatch {
  term: string;
  kind: BlockKind;
}

/** The record of one policy check, kept in the request, the run record and provenance. */
export interface PromptPolicyRecord {
  /** sha256 hex of the blocklist file. */
  blocklistSha256: string;
  /** sha256 hex of the normalised text checked. */
  textSha256: string;
  verdict: "allowed" | "refused";
  /** The first term that refused the text; absent when allowed. */
  match?: PolicyMatch;
  /** The settings allow terms (`promptPolicy.allow`) that cleared a hit. */
  allowedBy: string[];
  /** The model check's route, `<provider>:prompt-policy:<model>`, once it has run. */
  model?: string;
  /** The model check's probability that the text breaks the policy, once it has run. */
  probability?: number;
}

/** A prompt the policy refuses: exit 9 `prompt_refused`, with `error.policy`. */
export class PromptRefusedError extends Error {
  readonly code = "prompt_refused";
  readonly policy: PromptPolicyRecord;
  constructor(policy: PromptPolicyRecord, where = "the prompt") {
    super(
      policy.match === undefined && policy.probability !== undefined
        ? `${where} reads as a request for a protected style, work, character or real person (the prompt-policy model check gives ${policy.probability.toFixed(2)}, refused at 0.5 or more): describe the look in plain visual words and anchor it with reference images`
        : `${where} names "${policy.match?.term ?? ""}" (${policy.match?.kind ?? "term"}), which the prompt policy refuses: describe the look in plain visual words and anchor it with reference images${policy.match?.kind === "phrase" ? "" : `, or add the term to promptPolicy.allow in the developer settings if it is not a name`}`,
    );
    this.name = "PromptRefusedError";
    this.policy = policy;
  }
}

/**
 * Text as the policy compares it: NFKC, lower case, combining marks removed, and every run of
 * characters that are neither letters nor digits made one space, trimmed.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Whether normalised `text` holds normalised `term` on word boundaries, spaced or run together. */
function holds(text: string, term: string): boolean {
  if (!term) return false;
  const padded = ` ${text} `;
  if (padded.includes(` ${term} `)) return true;
  const compact = term.replaceAll(" ", "");
  return compact !== term && padded.includes(` ${compact} `);
}

/** Every blocklist term `text` holds, in blocklist order. */
export function blocklistMatches(
  text: string,
  blocklist: Blocklist = packageBlocklist(),
): PolicyMatch[] {
  const normalized = normalizeText(text);
  return blocklist.terms
    .filter((t) => holds(normalized, normalizeText(t.term)))
    .map((t) => ({ term: t.term, kind: t.kind }));
}

/**
 * Checks prompt text against the blocklist. A matched term equal (normalised) to an allow term is
 * cleared and recorded in `allowedBy`; the first other match refuses.
 */
export function checkPromptText(
  texts: string | readonly string[],
  allow: readonly string[] = [],
  blocklist: Blocklist = packageBlocklist(),
): PromptPolicyRecord {
  const text = normalizeText(typeof texts === "string" ? texts : texts.join("\n"));
  const allowed = new Map(allow.map((a) => [normalizeText(a), a]));
  const allowedBy = new Set<string>();
  let match: PolicyMatch | undefined;
  for (const t of blocklist.terms) {
    const term = normalizeText(t.term);
    if (!holds(text, term)) continue;
    const allowTerm = allowed.get(term);
    if (allowTerm !== undefined) {
      allowedBy.add(allowTerm);
      continue;
    }
    match ??= { term: t.term, kind: t.kind };
  }
  return {
    blocklistSha256: blocklist.sha256,
    textSha256: sha256Hex(text),
    verdict: match ? "refused" : "allowed",
    ...(match && { match }),
    allowedBy: [...allowedBy],
  };
}

/** Checks prompt text and throws `PromptRefusedError` on a refusal; returns the record. */
export function enforcePromptPolicy(
  texts: string | readonly string[],
  allow: readonly string[] = [],
  where?: string,
): PromptPolicyRecord {
  const record = checkPromptText(texts, allow);
  if (record.verdict === "refused") throw new PromptRefusedError(record, where);
  return record;
}

/** The extensions of the files a request names: images, models, data, documents and audio. */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tga",
  "tif",
  "tiff",
  "exr",
  "hdr",
  "ktx2",
  "svg",
  "glb",
  "gltf",
  "fbx",
  "obj",
  "bin",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "md",
  "txt",
  "csv",
  "wav",
  "ogg",
  "mp3",
  "mp4",
  "webm",
]);

/**
 * A string that names a file rather than describing anything: no whitespace and a known file
 * extension. Anything else, slash- or dot-bearing or not, is prompt text.
 */
function pathLike(value: string): boolean {
  const extension = /\.([A-Za-z0-9]+)$/.exec(value)?.[1]?.toLowerCase();
  return !/\s/.test(value) && extension !== undefined && FILE_EXTENSIONS.has(extension);
}

/** Every string value of a JSON value, keys left out, path-like strings left out. */
export function promptStrings(value: unknown): string[] {
  if (typeof value === "string") return pathLike(value) ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(promptStrings);
  if (value !== null && typeof value === "object")
    return Object.values(value as Record<string, unknown>).flatMap(promptStrings);
  return [];
}

/** The input arguments whose files feed prompts. */
export const PROMPT_INPUTS: ReadonlySet<string> = new Set([
  "spec",
  "brief",
  "bible",
  "lockBible",
  "template",
  "plan",
]);

/**
 * The prompt text of one input file: a JSON file's strings minus paths; a template's body without
 * its `{{fields}}`; another Markdown file's front matter strings minus paths and its Do's and
 * Don'ts section. A file that cannot be read gives none (the command reports it when it loads it).
 */
export async function promptTextOf(name: string, path: string): Promise<string[]> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  const body = front ? source.slice(front[0].length) : source;
  if (name === "template") return [body.replace(/\{\{[\s\S]*?\}\}/g, " ")];
  if (extname(path).toLowerCase() === ".md" || front) {
    let data: unknown;
    try {
      data = front ? parseYaml(front[1]!) : undefined;
    } catch {
      data = undefined;
    }
    return [...promptStrings(data), doDontSection(body)].filter((s) => s.length > 0);
  }
  try {
    return promptStrings(JSON.parse(source) as unknown);
  } catch {
    return [];
  }
}

/** The prompt text of a request's input files, in argument order. */
export async function collectPromptText(files: Record<string, string>): Promise<string[]> {
  const texts: string[] = [];
  for (const [name, path] of Object.entries(files))
    if (PROMPT_INPUTS.has(name)) texts.push(...(await promptTextOf(name, path)));
  return texts;
}
