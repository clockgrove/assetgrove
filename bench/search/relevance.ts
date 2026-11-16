/**
 * The bench's by-words relevance: a decision model judges each pooled candidate image against the
 * query, and the manifest records each answer's probability, model, prompt and date. No relevance
 * label comes from a file name.
 */
import { createHash } from "node:crypto";
import { createGateway } from "ai";
import type { Embedder } from "../../packages/assetgrove-search/src/embedder.ts";
import type { Store } from "../../packages/assetgrove-search/src/store.ts";
import type { DecisionQuestion } from "../../src/gateway/provider.ts";
import { decideStructured } from "../../src/gateway/structured.ts";
import { VercelGateway } from "../../src/gateway/vercel.ts";
import { indexLibrary, RANKINGS, rankingsFor } from "./bench.ts";
import { forVision } from "./card-text.ts";
import type { ImageSource } from "./fetch.ts";
import {
  SCRIPTED_JUDGE_MODEL,
  unjudged,
  type Judgement,
  type Manifest,
  type WrittenQuery,
} from "./manifest.ts";

/**
 * Top results taken from each ranking into a query's pool. The bench scores the top 5; 10 leaves
 * room for a ranking that moves without reaching unjudged images. docs/decisions.md names it.
 */
export const POOL_DEPTH = 10;

export interface PoolOptions {
  manifest: Manifest;
  source: ImageSource;
  embedder: Embedder;
  /** An empty store; the labelled library is indexed into it as the bench indexes it. */
  store: Store;
  depth?: number;
  /** Pool again a query that has candidates already (judgements of images still pooled are kept). */
  force?: boolean;
}

/**
 * Sets each written query's candidates: the union of the top `depth` of every ranking the bench
 * scores (image vector, card-text vector, full text, fused), in ranking order. Returns how many
 * queries it pooled. Makes no model call: the embedder is the bench's own.
 */
export async function poolCandidates(o: PoolOptions): Promise<number> {
  const depth = o.depth ?? POOL_DEPTH;
  await indexLibrary(o.manifest, o.source, o.embedder, o.store);
  let pooled = 0;
  for (const q of o.manifest.writtenQueries) {
    if (q.candidates !== undefined && !o.force) continue;
    const ranked = await rankingsFor(o.store, o.embedder, q.text, depth);
    const pool = [...new Set(RANKINGS.flatMap((r) => ranked[r]))];
    q.candidates = pool;
    q.pooledBy = {
      embedder: o.embedder.id,
      revision: o.embedder.revision,
      depth,
      rankings: [...RANKINGS],
    };
    if (q.judgements) {
      const kept = q.judgements.filter((j) => pool.includes(j.image));
      if (kept.length > 0) q.judgements = kept;
      else delete q.judgements;
    }
    pooled++;
  }
  return pooled;
}

/** What the judge is shown before the image; `{query}` is replaced by the query's words. */
export const JUDGE_PROMPT =
  'A game developer searched a library of game assets for: "{query}".\n' +
  "The image is one asset from the library. A plain white or transparent background is not part " +
  "of the asset. The image may be a small sprite scaled up.";

/** The typed question the decision model answers, with its probability. */
export const JUDGE_QUESTION: DecisionQuestion = {
  type: "boolean",
  instructions:
    "Would a game developer searching for this query want this image among the results?",
  whenTrue:
    "the image shows what the query asks for, so the developer would want to see it in the results",
  whenFalse:
    "the image shows something else, or only shares a colour, a style or a pack with what the query asks for",
};

/** The whole prompt as the manifest records it: the text, then the question. */
export function judgePromptRecord(
  prompt: string = JUDGE_PROMPT,
  q: DecisionQuestion = JUDGE_QUESTION,
): string {
  if (q.type !== "boolean") throw new Error("the relevance question is a Boolean question");
  return (
    `${prompt}\n\nQuestion: ${q.instructions}` +
    `${q.whenTrue !== undefined ? `\nTrue: ${q.whenTrue}` : ""}` +
    `${q.whenFalse !== undefined ? `\nFalse: ${q.whenFalse}` : ""}`
  );
}

export interface JudgeRequest {
  /** The image bytes as the model is shown them (after `forVision`). */
  image: Uint8Array;
  query: string;
  /** `JUDGE_PROMPT` with the query in place. */
  prompt: string;
  question: DecisionQuestion;
}

export interface RelevanceJudge {
  judge(
    r: JudgeRequest,
  ): Promise<{ probability: number; model: string; route?: string; requestId?: string }>;
}

const STOP = new Set(["the", "and", "for", "with", "such", "from", "that", "into", "seen", "or"]);
const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w));

/**
 * Offline judge: the image bytes are read as a caption (the fixture's and the scripted run's), and
 * the probability is the share of the query's words the caption holds. Tests use it; it never
 * calls a model.
 */
export class ScriptedJudge implements RelevanceJudge {
  async judge(r: JudgeRequest): Promise<{ probability: number; model: string }> {
    const caption = new Set(words(Buffer.from(r.image).toString("utf8")));
    const asked = words(r.query);
    const hit = asked.filter((w) => caption.has(w)).length;
    return {
      probability: asked.length === 0 ? 0 : hit / asked.length,
      model: SCRIPTED_JUDGE_MODEL,
    };
  }
}

/** The vision model the committed judgements come from: the one that wrote the card texts. */
export const STRUCTURED_JUDGE_MODEL = "anthropic/claude-sonnet-5-5";
/** The gateway decision model `--judge decision` asks by default. */
export const DECISION_JUDGE_MODEL = "perplexity/pplx-decider-v1.2";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The gateway's decision models, as identity scoring and the prompt-policy check use them: one
 * Boolean typed question with the image, through core's `VercelGateway.decide`.
 */
export function gatewayJudge(
  model: string,
  options: { baseURL?: string; apiKey?: string; keyEnv?: string } = {},
): RelevanceJudge {
  const gateway = new VercelGateway({
    apiKey: options.apiKey,
    ...(options.keyEnv !== undefined && { keyEnv: options.keyEnv }),
    ...(options.baseURL !== undefined && { baseURL: options.baseURL }),
  });
  return {
    async judge(r) {
      const png = PNG_SIGNATURE.every((byte, i) => r.image[i] === byte);
      const result = await gateway.decide({
        model,
        prompt: r.prompt,
        images: [{ mediaType: png ? "image/png" : "application/octet-stream", bytes: r.image }],
        question: r.question,
        operation: "relevance",
      });
      if (result.answer.type !== "boolean" || !Number.isFinite(result.answer.probability))
        throw new Error("the relevance judge did not answer with a probability");
      return {
        probability: result.answer.probability,
        model,
        route: "ai-gateway",
        ...(result.requestIdSource === "provider" && { requestId: result.requestId }),
      };
    },
  };
}

/**
 * Any vision model the gateway serves, asked the same typed question through structured output
 * (core's `decideStructured`). The gateway's decision models were tried first and did not pass the
 * spot-check on this library's small sprites (docs/decisions.md, Relevance judgements), so the
 * committed judgements come from a model that reads the image well.
 */
export function structuredJudge(
  model: string,
  options: { baseURL?: string; apiKey?: string; keyEnv?: string } = {},
): RelevanceJudge {
  const apiKey = options.apiKey ?? process.env[options.keyEnv ?? "AI_GATEWAY_API_KEY"];
  if (apiKey === undefined || apiKey === "")
    throw new Error(`the relevance judge needs a key in ${options.keyEnv ?? "AI_GATEWAY_API_KEY"}`);
  const gateway = createGateway({
    apiKey,
    ...(options.baseURL !== undefined && { baseURL: options.baseURL }),
  });
  return {
    async judge(r) {
      const png = PNG_SIGNATURE.every((byte, i) => r.image[i] === byte);
      const result = await decideStructured(
        "ai-gateway",
        gateway(model),
        {
          model,
          prompt: r.prompt,
          images: [{ mediaType: png ? "image/png" : "application/octet-stream", bytes: r.image }],
          question: r.question,
          operation: "relevance",
        },
        (_label, call) => call(),
      );
      if (result.answer.type !== "boolean" || !Number.isFinite(result.answer.probability))
        throw new Error("the relevance judge did not answer with a probability");
      return {
        probability: result.answer.probability,
        model,
        route: "ai-gateway",
        ...(result.requestIdSource === "provider" && { requestId: result.requestId }),
      };
    },
  };
}

export interface JudgeOptions {
  manifest: Manifest;
  source: ImageSource;
  judge: RelevanceJudge;
  prompt?: string;
  question?: DecisionQuestion;
  now?: () => Date;
  /** The most judge calls this run makes; it stops there, everything judged so far kept. */
  maxCalls?: number;
  /** Called once before the first call with how many calls the run will make, and how many are left to judge. */
  onPlan?: (calls: number, toJudge: number) => void;
  /** Called after each answer, so a caller can save it. */
  onJudged?: (query: WrittenQuery, judgement: Judgement) => Promise<void> | void;
}

/**
 * Judges every pooled candidate that has no judgement yet, one call each, and records the
 * probability, model, prompt key and date. Returns how many it judged and how many are left.
 */
export async function judgeRelevance(o: JudgeOptions): Promise<{ judged: number; left: number }> {
  const prompt = o.prompt ?? JUDGE_PROMPT;
  const question = o.question ?? JUDGE_QUESTION;
  const record = judgePromptRecord(prompt, question);
  const key = createHash("sha256").update(record).digest("hex").slice(0, 12);
  const maxCalls = o.maxCalls ?? Number.POSITIVE_INFINITY;
  if (!(maxCalls === Number.POSITIVE_INFINITY || (Number.isInteger(maxCalls) && maxCalls >= 0)))
    throw new Error(`the call cap must be a non-negative integer, not ${maxCalls}`);
  const todo = o.manifest.writtenQueries.flatMap((q) => unjudged(q).map((image) => ({ q, image })));
  const calls = Math.min(todo.length, maxCalls);
  o.onPlan?.(calls, todo.length);
  const byId = new Map(o.manifest.images.map((i) => [i.id, i]));
  const shown = new Map<string, Uint8Array>();
  let judged = 0;
  for (const { q, image } of todo.slice(0, calls)) {
    const entry = byId.get(image);
    if (!entry)
      throw new Error(`written query ${q.id} names ${image}, which is not a manifest image`);
    let bytes = shown.get(image);
    if (!bytes) {
      bytes = forVision(await o.source.bytes(entry));
      shown.set(image, bytes);
    }
    const out = await o.judge.judge({
      image: bytes,
      query: q.text,
      prompt: prompt.replaceAll("{query}", q.text),
      question,
    });
    o.manifest.prompts[key] = record;
    const j: Judgement = {
      image,
      probability: out.probability,
      model: out.model,
      prompt: key,
      date: (o.now ?? (() => new Date()))().toISOString(),
      ...(out.route ? { route: out.route } : {}),
      ...(out.requestId ? { requestId: out.requestId } : {}),
    };
    (q.judgements ??= []).push(j);
    judged++;
    await o.onJudged?.(q, j);
  }
  return { judged, left: todo.length - judged };
}

const keyOf = (query: string, image: string) => `${query}:${image}`;

/** A seeded sample of judgements, as `<query id>:<image id>`, for a person to check against the images. */
export function judgementSample(manifest: Manifest, count: number, seed: string): string[] {
  const rank = (k: string) => createHash("sha256").update(`${seed}\0${k}`).digest("hex");
  return manifest.writtenQueries
    .flatMap((q) => (q.judgements ?? []).map((j) => keyOf(q.id, j.image)))
    .sort((a, b) => (rank(a) < rank(b) ? -1 : 1))
    .slice(0, count);
}

/** Records that a person checked these judgements (`<query id>:<image id>`) against the images. */
export function markJudgementsChecked(
  manifest: Manifest,
  keys: string[],
  by: string,
  date: string,
): void {
  for (const k of keys) {
    const at = k.indexOf(":");
    const q = manifest.writtenQueries.find((x) => x.id === k.slice(0, at));
    const j = q?.judgements?.find((x) => x.image === k.slice(at + 1));
    if (at < 0 || !j) throw new Error(`${k} is not a recorded judgement`);
    j.spotCheck = { by, date };
  }
}
