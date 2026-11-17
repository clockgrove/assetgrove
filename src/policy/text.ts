/**
 * The prompt policy's text check (design section 16): a request's prompt text, as labelled parts,
 * normalised (NFKC, case, diacritics, spacing) and matched against the package blocklist on word
 * boundaries. A hit on an unambiguous name not cleared by a settings allow term refuses the request
 * with exit 9 `prompt_refused` and `error.policy`, before confirmation and spend. A hit on a phrase
 * or on a name that is also an ordinary word refuses nothing by itself: it is recorded, with the
 * words around it, for the model check the run starts with (src/policy/model.ts) to decide.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { doDontSection } from "../bible.ts";
import { packageBlocklist, refusesFree } from "./blocklist.ts";
import type { BlockKind, Blocklist } from "./blocklist.ts";

/** The blocklist term a prompt matched. */
export interface PolicyMatch {
  term: string;
  kind: BlockKind;
}

/**
 * What a part of a request's prompt text is: the spec's strings, the brief, the bible's tone
 * fields, the bible's Do's and Don'ts (rules the art must follow), the template's body, other text
 * a person or a profile gave (a note, a subject), or text the prompt compiler (a model) wrote: its
 * prompt and its negative prompt.
 */
export type PromptPartLabel =
  "spec" | "brief" | "tone" | "rules" | "template" | "text" | "model-prompt" | "model-negative";

/** One labelled part of a request's prompt text. */
export interface PromptPart {
  label: PromptPartLabel;
  text: string;
}

/** Whether a part is text a model (the prompt compiler) wrote, not the person. */
export function modelWritten(part: { label: PromptPartLabel }): boolean {
  return part.label === "model-prompt" || part.label === "model-negative";
}

/** A phrase or ambiguous-name hit the model check decides: the term, its part and its context. */
export interface PolicyHit {
  term: string;
  kind: BlockKind;
  /** Present on a name that is also an ordinary word or a given name. */
  ambiguous?: true;
  part: PromptPartLabel;
  /** The normalised words around the hit: up to `HIT_CONTEXT_WORDS` either side. */
  context: string;
}

/** How many words either side of a hit go to the model check with it. */
export const HIT_CONTEXT_WORDS = 12;

/** The record of one policy check, kept in the request, the run record and provenance. */
export interface PromptPolicyRecord {
  /** sha256 hex of the blocklist file. */
  blocklistSha256: string;
  /** sha256 hex of the normalised text checked. */
  textSha256: string;
  verdict: "allowed" | "refused";
  /** The first unambiguous name that refused the text; absent when allowed. */
  match?: PolicyMatch;
  /** The settings allow terms (`promptPolicy.allow`) that cleared a hit. */
  allowedBy: string[];
  /**
   * The phrase and ambiguous-name hits the free check refused nothing for: the model check decides
   * them when the run starts, and its answer is this record's `probability` and `verdict`.
   */
  hits?: PolicyHit[];
  /**
   * The route, `<provider>:prompt-policy:<model>`, of the model answer that decided the outcome,
   * once the check has run.
   */
  model?: string;
  /** The deciding model answer's probability that the text breaks the policy. */
  probability?: number;
  /**
   * Every model answer the run's check got, in order: the first on all the labelled parts, and a
   * second on the person's parts alone only when the first refused text holding compiler-written
   * parts. `decided` marks the answer the outcome follows.
   */
  checks?: PromptPolicyCheck[];
  /**
   * Why the run used the repository template's prompt in place of the prompt compiler's: the
   * policy objected only to text the compiler wrote, so the person's request is not refused.
   */
  fallback?: string;
  /**
   * How the run's check read each ambiguous name a person-written part holds (`readingTerms`):
   * the protected name, an ordinary word, or an unrelated name. Only `protected` refuses.
   */
  readings?: PolicyReading[];
  /**
   * The cut the model answer was judged by, from `policy/prompt-policy-cuts.json` for the decisions
   * route: under `confirmAt` allowed, from `confirmAt` up to `refuseAt` a person confirms, `refuseAt`
   * or more refused.
   */
  cut?: { confirmAt: number; refuseAt: number };
  /**
   * The deciding answer fell between the cut's `confirmAt` and `refuseAt`: the verdict is allowed,
   * and a person confirms the request before the run goes on (`clearedBy`).
   */
  borderline?: true;
  /** The confirmation (`policy` kind) that cleared a borderline request: its id and method. */
  clearedBy?: { id: string; method: "headless" | "tty" | "terminal" | "elicitation" };
}

/** What an ambiguous name in a request refers to, as the reading call answers. */
export type NameReading = "protected" | "word" | "other-name";

/** One ambiguous name's reading in a prompt-policy record. */
export interface PolicyReading {
  term: string;
  kind: BlockKind;
  reading: NameReading;
  /** The answer's route, `<provider>:prompt-policy:<model>`. */
  model: string;
  /** The model's probability for the option it chose, when it reported one. */
  probability?: number;
}

/**
 * The ambiguous names the run's check reads one by one: each distinct term with a hit in a
 * person-written part, with that hit's part and context. A term held only by compiler-written text
 * is left to the Boolean call and its template fallback.
 */
export function readingTerms(hits: readonly PolicyHit[] | undefined): PolicyHit[][] {
  const byTerm = new Map<string, PolicyHit[]>();
  for (const hit of hits ?? []) {
    if (hit.ambiguous !== true || modelWritten({ label: hit.part })) continue;
    const list = byTerm.get(hit.term) ?? [];
    list.push(hit);
    byTerm.set(hit.term, list);
  }
  return [...byTerm.values()];
}

/** One model answer in a prompt-policy record. */
export interface PromptPolicyCheck {
  /** `all`: every labelled part; `person`: the person's parts and the bible's rules alone. */
  scope: "all" | "person";
  /** The answer's route, `<provider>:prompt-policy:<model>`. */
  model: string;
  probability: number;
  refused: boolean;
  /** Present on the answer the outcome follows. */
  decided?: true;
}

/** A prompt the policy refuses: exit 9 `prompt_refused`, with `error.policy`. */
export class PromptRefusedError extends Error {
  readonly code = "prompt_refused";
  readonly policy: PromptPolicyRecord;
  constructor(policy: PromptPolicyRecord, where = "the prompt") {
    const named = policy.readings?.find((r) => r.reading === "protected");
    super(
      named !== undefined
        ? `${where} uses "${named.term}" as the protected ${named.kind} name (the prompt-policy reading call, ${named.model}): describe the look in plain visual words and anchor it with reference images`
        : policy.match === undefined && policy.probability !== undefined
          ? `${where} reads as a request for a protected style, work, character or real person (the prompt-policy model check gives ${policy.probability.toFixed(2)}, refused at ${(policy.cut?.refuseAt ?? 0.5).toFixed(2)} or more): describe the look in plain visual words and anchor it with reference images`
          : `${where} names "${policy.match?.term ?? ""}" (${policy.match?.kind ?? "term"}), which the prompt policy refuses: describe the look in plain visual words and anchor it with reference images, or add the term to promptPolicy.allow in the developer settings if it is not a name`,
    );
    this.name = "PromptRefusedError";
    this.policy = policy;
  }
}

/**
 * Text as the policy compares it: invisible format characters (soft hyphen, zero-width space and
 * joiners) removed, NFKC, lower case, combining marks removed, and every run of characters that
 * are neither letters nor digits made one space, trimmed.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\p{Cf}+/gu, "")
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

/**
 * The normalised words around the first place normalised `text` holds normalised `term`: up to
 * `HIT_CONTEXT_WORDS` either side.
 */
export function hitContext(text: string, term: string): string {
  const words = text.split(" ");
  const termWords = term.split(" ");
  const compact = term.replaceAll(" ", "");
  for (let i = 0; i < words.length; i++) {
    const length = words.slice(i, i + termWords.length).join(" ") === term ? termWords.length : 0;
    const width = length || (words[i] === compact ? 1 : 0);
    if (width === 0) continue;
    return words.slice(Math.max(0, i - HIT_CONTEXT_WORDS), i + width + HIT_CONTEXT_WORDS).join(" ");
  }
  return term;
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

/** Prompt text as labelled parts: a plain string is a `text` part. */
export function asParts(texts: string | readonly (string | PromptPart)[]): PromptPart[] {
  return (typeof texts === "string" ? [texts] : texts).map((t) =>
    typeof t === "string" ? { label: "text", text: t } : t,
  );
}

/** The parts' text, joined as the policy hashes it and the model check reads it. */
export function partsText(parts: readonly PromptPart[]): string {
  return parts.map((p) => p.text).join("\n");
}

/**
 * Checks prompt text against the blocklist. A matched term equal (normalised) to an allow term is
 * cleared and recorded in `allowedBy`; the first other unambiguous name refuses; every other phrase
 * or ambiguous-name hit is recorded in `hits` (once per term and part), for the model check.
 */
export function checkPromptText(
  texts: string | readonly (string | PromptPart)[],
  allow: readonly string[] = [],
  blocklist: Blocklist = packageBlocklist(),
): PromptPolicyRecord {
  const parts = asParts(texts);
  const text = normalizeText(partsText(parts));
  const normalizedParts = parts.map((p) => ({ label: p.label, text: normalizeText(p.text) }));
  const allowed = new Map(allow.map((a) => [normalizeText(a), a]));
  const allowedBy = new Set<string>();
  const hits: PolicyHit[] = [];
  let match: PolicyMatch | undefined;
  for (const t of blocklist.terms) {
    const term = normalizeText(t.term);
    if (!holds(text, term)) continue;
    const allowTerm = allowed.get(term);
    if (allowTerm !== undefined) {
      allowedBy.add(allowTerm);
      continue;
    }
    if (refusesFree(t)) {
      match ??= { term: t.term, kind: t.kind };
      continue;
    }
    const seen = new Set<PromptPartLabel>();
    for (const part of normalizedParts) {
      if (seen.has(part.label) || !holds(part.text, term)) continue;
      seen.add(part.label);
      hits.push({
        term: t.term,
        kind: t.kind,
        ...(t.ambiguous === true && { ambiguous: true as const }),
        part: part.label,
        context: hitContext(part.text, term),
      });
    }
    // A term only the joined text holds (it spans two parts) goes to the model as one hit too.
    if (seen.size === 0)
      hits.push({
        term: t.term,
        kind: t.kind,
        ...(t.ambiguous === true && { ambiguous: true as const }),
        part: parts[0]?.label ?? "text",
        context: hitContext(text, term),
      });
  }
  return {
    blocklistSha256: blocklist.sha256,
    textSha256: sha256Hex(text),
    verdict: match ? "refused" : "allowed",
    ...(match && { match }),
    allowedBy: [...allowedBy],
    ...(!match && hits.length > 0 && { hits }),
  };
}

/** Checks prompt text and throws `PromptRefusedError` on a refusal; returns the record. */
export function enforcePromptPolicy(
  texts: string | readonly (string | PromptPart)[],
  allow: readonly string[] = [],
  where?: string,
): PromptPolicyRecord {
  const record = checkPromptText(texts, allow);
  if (record.verdict === "refused") throw new PromptRefusedError(record, where);
  return record;
}

/**
 * The fields of each input argument whose values are files or ids, not text: dot-separated field
 * paths, `*` matching any key or array index. A spec's `assetId` is an id and its `keyPose` a file;
 * a bible's anchors, turnarounds and references are files, as are the stage bible's references
 * and perspective sample.
 */
export const NON_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = (() => {
  const bible = [
    "anchors.*.*.path",
    "identities.*.turnaround",
    "identities.*.references.*",
    "references.*.path",
    "perspective",
  ];
  return { spec: ["assetId", "keyPose"], bible, lockBible: bible };
})();

function fieldMatches(pattern: string, path: readonly string[]): boolean {
  const parts = pattern.split(".");
  return parts.length === path.length && parts.every((p, i) => p === "*" || p === path[i]);
}

/**
 * Every string value of a JSON value, keys left out, and a string whose field path matches one of
 * `skip` left out. With no `skip`, every string is text.
 */
export function promptStrings(
  value: unknown,
  skip: readonly string[] = [],
  path: readonly string[] = [],
): string[] {
  if (typeof value === "string") return skip.some((p) => fieldMatches(p, path)) ? [] : [value];
  if (Array.isArray(value))
    return value.flatMap((v, i) => promptStrings(v, skip, [...path, String(i)]));
  if (value !== null && typeof value === "object")
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      promptStrings(v, skip, [...path, k]),
    );
  return [];
}

/** The input arguments whose files feed prompts. */
export const PROMPT_INPUTS: ReadonlySet<string> = new Set([
  "spec",
  "brief",
  "bible",
  "lockBible",
  "template",
]);

/** The part a file's text is, by the argument that names it. */
const FILE_LABELS: Readonly<Record<string, PromptPartLabel>> = {
  spec: "spec",
  brief: "brief",
  bible: "tone",
  lockBible: "tone",
  template: "template",
};

/**
 * The prompt text of one input file, labelled: a JSON file's strings minus its file and id fields (`NON_TEXT_FIELDS`); a template's
 * body without its `{{fields}}`; another Markdown file's front matter strings minus those fields (`tone`)
 * and its Do's and Don'ts section (`rules`). A saved plan is not read here: apply labels its
 * input files as the plan step does and its compiler-written text apart (`savedPlanPromptParts`
 * in src/planning.ts). A file that cannot be read gives none (the command reports it when it
 * loads it).
 */
export async function promptPartsOf(name: string, path: string): Promise<PromptPart[]> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const label = FILE_LABELS[name] ?? "text";
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  const body = front ? source.slice(front[0].length) : source;
  if (name === "template") return [{ label, text: body.replace(/\{\{[\s\S]*?\}\}/g, " ") }];
  if (extname(path).toLowerCase() === ".md" || front) {
    let data: unknown;
    try {
      data = front ? parseYaml(front[1]!) : undefined;
    } catch {
      data = undefined;
    }
    return [
      ...promptStrings(data, NON_TEXT_FIELDS[name]).map((text) => ({ label, text })),
      { label: "rules" as const, text: doDontSection(body) },
    ].filter((p) => p.text.length > 0);
  }
  let data: unknown;
  try {
    data = JSON.parse(source) as unknown;
  } catch {
    return [];
  }
  return promptStrings(data, NON_TEXT_FIELDS[name]).map((text) => ({ label, text }));
}

/** The prompt text of one input file, unlabelled (`promptPartsOf`). */
export async function promptTextOf(name: string, path: string): Promise<string[]> {
  return (await promptPartsOf(name, path)).map((p) => p.text);
}

/** The labelled prompt text of a request's input files, in argument order. */
export async function collectPromptParts(files: Record<string, string>): Promise<PromptPart[]> {
  const parts: PromptPart[] = [];
  for (const [name, path] of Object.entries(files))
    if (PROMPT_INPUTS.has(name)) parts.push(...(await promptPartsOf(name, path)));
  return parts;
}

/** The prompt text of a request's input files, in argument order. */
export async function collectPromptText(files: Record<string, string>): Promise<string[]> {
  return (await collectPromptParts(files)).map((p) => p.text);
}
