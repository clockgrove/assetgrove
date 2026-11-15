/** The labelled search library's manifest: format, reading and checking. */
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
  /** Present when a person spot-checked this text. */
  spotCheck?: { by: string; date: string };
}

export interface ManifestImage {
  id: string;
  /** The image's file name in its source pack; its stem must not appear in the card text. */
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

export interface WrittenQuery {
  id: string;
  text: string;
  /** Images a person judged relevant. */
  relevant: string[];
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
  /** Pairs of images that are the same asset (a variant, a rescale, a recolour). */
  pairs: [string, string][];
}

export async function readManifest(path: string | URL): Promise<Manifest> {
  return JSON.parse(await readFile(path, "utf8")) as Manifest;
}

export const stem = (file: string): string => file.replace(/\.[^./]+$/, "");

const normalise = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");

/** True when `text` contains the file stem as a whole phrase (separators ignored). */
export function containsStem(text: string, file: string): boolean {
  const s = normalise(stem(file)).trim();
  if (s === "") return false;
  return ` ${normalise(text).trim()} `.includes(` ${s} `);
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
      if (containsStem(i.card.text, i.file))
        problems.push(`${i.id}: card text contains the file stem "${stem(i.file)}"`);
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
  for (const q of m.writtenQueries) {
    for (const r of q.relevant) known(r, `written query ${q.id}`);
  }
  for (const [a, b] of m.pairs) {
    known(a, "pair");
    known(b, "pair");
  }
  return problems;
}
