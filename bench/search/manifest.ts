/**
 * The labelled search library's manifest: format, reading and checking. How each label is made:
 * - by-look labels (`labels`: pack, category, 16-px) come from the pack's own folders and sizes;
 * - card texts are written from the images by a vision model (`write-card-texts.ts`);
 * - by-words relevance is a decision model's judgement of each pooled candidate image against the
 *   query (`judge-relevance.ts`), never a match on file names.
 * docs/decisions.md (Search bars) records each.
 */
import { readFile } from "node:fs/promises";

export const MANIFEST_FORMAT = "assetgrove-search-bench/1";

export interface CardText {
  text: string;
  /** The vision model that wrote it. */
  model: string;
  /** Key into `Manifest.prompts`. */
  prompt: string;
  /** ISO date the text was written. */
  date: string;
  /** The route the call went through, and the provider's request id, when it gave one. */
  route?: string;
  requestId?: string;
  /** Present when a person spot-checked this text. */
  spotCheck?: { by: string; date: string };
}

export interface ManifestImage {
  id: string;
  /** The image's file name in its source pack; it never reaches the vision model. */
  file: string;
  /** Pinned download address. */
  url: string;
  sha256: string;
  width: number;
  height: number;
  card?: CardText;
}

export interface Label {
  image: string;
  category: string;
  pack: string;
  /** 16 for 16-px pixel art. */
  pixel?: number;
}

/**
 * One decision model's answer to "would a game developer searching for this query want this
 * image?", given the query and the image (scaled up as `forVision` does). Written by
 * `judge-relevance.ts`; never derived from a file name.
 */
export interface Judgement {
  image: string;
  /** The model's probability that the image answers the query (0 to 1), as it gave it. */
  probability: number;
  /** The decision model that answered. */
  model: string;
  /** Key into `Manifest.prompts`; the stored prompt holds `{query}` where the query goes. */
  prompt: string;
  /** ISO date of the judgement. */
  date: string;
  /** The route the call went through, and the provider's request id, when it gave one. */
  route?: string;
  requestId?: string;
  /** Present when a person spot-checked this judgement against the image. */
  spotCheck?: { by: string; date: string };
}

/** The rankings, embedder and depth a query's candidate pool was taken from. */
export interface PoolRecord {
  embedder: string;
  revision: string;
  /** Top results taken from each ranking. */
  depth: number;
  rankings: string[];
}

export interface WrittenQuery {
  id: string;
  /** A game developer's search, written by a person, never taken from a file name. */
  text: string;
  /**
   * The images judged for this query: the union of the top `POOL_DEPTH` results of every ranking
   * the bench scores (image vector, card-text vector, full text, fused). Absent until pooled.
   */
  candidates?: string[];
  pooledBy?: PoolRecord;
  /** One judgement per judged candidate. Relevant: probability at least `RELEVANT_AT`. */
  judgements?: Judgement[];
  /**
   * The old rule-made label (a regular expression over file names). A manifest that still holds
   * it is refused by the bench's by-words measures; the field is kept only so that is detected.
   */
  relevant?: string[];
}

/**
 * The probability at or above which a judged image counts as relevant to its query: yes is at
 * least as likely as no. Named in docs/decisions.md (Search bars, Relevance judgements).
 */
export const RELEVANT_AT = 0.5;

/** A query with fewer relevant images than this after judging is dropped from the by-words score. */
export const MIN_RELEVANT = 3;

/** The images judged relevant to a query (probability at least `RELEVANT_AT`). */
export function relevantOf(q: WrittenQuery): string[] {
  return (q.judgements ?? []).filter((j) => j.probability >= RELEVANT_AT).map((j) => j.image);
}

/** The candidates of a query that have no judgement yet. */
export function unjudged(q: WrittenQuery): string[] {
  const judged = new Set((q.judgements ?? []).map((j) => j.image));
  return (q.candidates ?? []).filter((c) => !judged.has(c));
}

/** The model name the offline `ScriptedJudge` records: a word match, never a judgement of an image. */
export const SCRIPTED_JUDGE_MODEL = "scripted-judge";

export interface WordsLabelOptions {
  /**
   * The embedder the bench scores with. A query pooled by another embedder or revision is refused:
   * its pool is not the top results of the rankings the bench then scores.
   */
  embedder?: { id: string; revision: string };
  /**
   * Accept judgements by the offline scripted judge. Only the offline fixture run and tests set it:
   * on the real manifest its "image" is words about the pack and category, a name match.
   */
  scriptedJudgements?: boolean;
}

/**
 * Why the manifest cannot be scored by words: a query that still holds a rule-made `relevant`
 * list, has no candidate pool, was pooled by another embedder than the bench's, has candidates not
 * yet judged, or holds scripted judgements outside the offline fixture. Empty means it can be.
 */
export function wordsLabelProblems(m: Manifest, o: WordsLabelOptions = {}): string[] {
  const problems: string[] = [];
  for (const q of m.writtenQueries) {
    if (q.relevant !== undefined) {
      problems.push(`written query ${q.id} holds rule-made relevance labels (relevant)`);
      continue;
    }
    if (q.candidates === undefined) {
      problems.push(`written query ${q.id} is not pooled`);
      continue;
    }
    if (
      o.embedder !== undefined &&
      (q.pooledBy?.embedder !== o.embedder.id || q.pooledBy?.revision !== o.embedder.revision)
    )
      problems.push(
        `written query ${q.id} was pooled by ${q.pooledBy ? `${q.pooledBy.embedder}@${q.pooledBy.revision}` : "an unrecorded embedder"}, not the bench's ${o.embedder.id}@${o.embedder.revision}`,
      );
    if (unjudged(q).length > 0)
      problems.push(`written query ${q.id} has ${unjudged(q).length} candidates not judged`);
    if (!o.scriptedJudgements && (q.judgements ?? []).some((j) => j.model === SCRIPTED_JUDGE_MODEL))
      problems.push(
        `written query ${q.id} holds judgements by ${SCRIPTED_JUDGE_MODEL}, a word match, not a judgement of the image`,
      );
  }
  return problems;
}

/** Fully judged queries with fewer than `MIN_RELEVANT` relevant images: dropped and reported. */
export function droppedQueries(m: Manifest): WrittenQuery[] {
  return m.writtenQueries.filter(
    (q) =>
      q.candidates !== undefined && unjudged(q).length === 0 && relevantOf(q).length < MIN_RELEVANT,
  );
}

export interface Manifest {
  format: typeof MANIFEST_FORMAT;
  description: string;
  /** Every category and pack of the spike library; the sample must cover each. */
  strata: { categories: string[]; packs: string[]; minPixel16: number };
  prompts: Record<string, string>;
  images: ManifestImage[];
  labels: Label[];
  /** Image ids used as look queries. */
  lookQueries: string[];
  writtenQueries: WrittenQuery[];
}

export async function readManifest(path: string | URL): Promise<Manifest> {
  return JSON.parse(await readFile(path, "utf8")) as Manifest;
}

/** Returns a list of problems; empty means the manifest is sound. */
export function checkManifest(m: Manifest, o: { cardsPending?: boolean } = {}): string[] {
  const problems: string[] = [];
  // Before orchestrator step o-6 writes them, a manifest may hold no card text at all.
  const cardsPending = o.cardsPending === true && m.images.every((i) => !i.card);
  if (m.format !== MANIFEST_FORMAT) problems.push(`format must be ${MANIFEST_FORMAT}`);
  const ids = new Set<string>();
  for (const i of m.images) {
    if (ids.has(i.id)) problems.push(`duplicate image ${i.id}`);
    ids.add(i.id);
    if (!/^[0-9a-f]{64}$/.test(i.sha256)) problems.push(`${i.id}: sha256 is not 64 hex digits`);
    if (!/^https:\/\//.test(i.url)) problems.push(`${i.id}: url must be https`);
    if (!i.card) {
      if (!cardsPending) problems.push(`${i.id}: no card text`);
    } else {
      if (!(i.card.prompt in m.prompts)) problems.push(`${i.id}: card names unknown prompt`);
      if (!i.card.model || !i.card.date) problems.push(`${i.id}: card lacks model or date`);
    }
  }
  const known = (id: string, where: string) => {
    if (!ids.has(id)) problems.push(`${where} names ${id}, which is not a manifest image`);
  };
  const labelled = new Map<string, Label>();
  for (const l of m.labels) {
    known(l.image, "label");
    labelled.set(l.image, l);
    if (!m.strata.categories.includes(l.category))
      problems.push(`label ${l.image}: category ${l.category} is not a stratum`);
    if (!m.strata.packs.includes(l.pack))
      problems.push(`label ${l.image}: pack ${l.pack} is not a stratum`);
  }
  for (const i of m.images) if (!labelled.has(i.id)) problems.push(`${i.id} has no label`);
  for (const c of m.strata.categories)
    if (!m.labels.some((l) => l.category === c)) problems.push(`category ${c} has no image`);
  for (const p of m.strata.packs)
    if (!m.labels.some((l) => l.pack === p)) problems.push(`pack ${p} has no image`);
  const pixel16 = m.labels.filter((l) => l.pixel === 16).length;
  if (pixel16 < m.strata.minPixel16)
    problems.push(`only ${pixel16} 16-px pixel-art images, need ${m.strata.minPixel16}`);
  for (const q of m.lookQueries) known(q, "look query");
  const queryIds = new Set<string>();
  for (const q of m.writtenQueries) {
    if (queryIds.has(q.id)) problems.push(`duplicate written query ${q.id}`);
    queryIds.add(q.id);
    for (const r of q.relevant ?? []) known(r, `written query ${q.id}`);
    for (const c of q.candidates ?? []) known(c, `written query ${q.id}`);
    const candidates = new Set(q.candidates ?? []);
    const judged = new Set<string>();
    for (const j of q.judgements ?? []) {
      known(j.image, `written query ${q.id}`);
      if (!candidates.has(j.image))
        problems.push(`written query ${q.id}: ${j.image} is judged but not a candidate`);
      if (judged.has(j.image)) problems.push(`written query ${q.id}: ${j.image} judged twice`);
      judged.add(j.image);
      if (!(j.prompt in m.prompts))
        problems.push(`written query ${q.id}: judgement names unknown prompt`);
      if (!j.model || !j.date)
        problems.push(`written query ${q.id}: judgement lacks model or date`);
      if (!(j.probability >= 0 && j.probability <= 1))
        problems.push(`written query ${q.id}: probability ${j.probability} is not in 0..1`);
    }
  }
  return problems;
}
