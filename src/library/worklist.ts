/**
 * The work list: every review note (an `editing` or `commenting` annotation on a version) with the
 * version it was made on and, when one is recorded, how it was closed. Computed from the review
 * records, which it reads and never writes. Note text is returned apart, as shared text.
 */
import { annotationText } from "../commands/review.ts";
import { relative, sep } from "node:path";
import type { SharedText } from "../request.ts";
import { anchorOf } from "./extent.ts";
import type { Anchor } from "./extent.ts";
import type { LibraryState } from "./maintain.ts";
import { versionNumber } from "./review.ts";
import type { Annotation, ReviewRecord } from "./review.ts";

export interface WorkNote {
  asset: string;
  /** The card's library-relative path, with `/` separators. */
  card: string;
  id: string;
  motivation: string;
  created: string;
  state: "open" | "resolved";
  anchor?: Anchor & { frame?: number; view?: number };
  source: { version: number | null; sha256: string; link: string | null };
  resolution?:
    | {
        by: "answer";
        version: number;
        sha256: string;
        link: string;
        confirmation?: { method: string; digest?: string };
      }
    | { by: "resolve"; annotation: string; created: string; link: string };
}

const NOTE_MOTIVATIONS = new Set(["editing", "commenting"]);

function resolutionOf(
  record: ReviewRecord,
  note: Annotation,
  assetUri: string,
): WorkNote["resolution"] {
  const index = record.versions.findIndex((v) => v.answers?.includes(note.id));
  const answering = record.versions[index];
  if (answering !== undefined) {
    const { method, digest } = answering.confirmation ?? {};
    return {
      by: "answer",
      version: index + 1,
      sha256: answering.sha256,
      link: `${assetUri}/versions/${index + 1}`,
      ...(method !== undefined && {
        confirmation: { method, ...(digest !== undefined && { digest }) },
      }),
    };
  }
  const resolve = record.annotations.find(
    (a) => a["ag:action"] === "resolve" && a["ag:resolves"] === note.id,
  );
  if (resolve === undefined) return undefined;
  return {
    by: "resolve",
    annotation: resolve.id,
    created: resolve.created,
    link: `${assetUri}/review${resolve.id}`,
  };
}

export function worklist(
  state: LibraryState,
  options: { open?: boolean },
): { notes: WorkNote[]; text: SharedText[] } {
  const notes: WorkNote[] = [];
  const bodies = new Map<WorkNote, SharedText[]>();
  for (const asset of state.assets) {
    if (asset.review === undefined) continue;
    const record = asset.review.record;
    const assetUri = `asset://${state.config.game}/${asset.id}`;
    const card = relative(state.config.root, asset.cardPath).split(sep).join("/");
    for (const annotation of record.annotations) {
      const target = annotation.target;
      if (!NOTE_MOTIVATIONS.has(annotation.motivation) || typeof target === "string") continue;
      const sha256 = target["ag:version"];
      if (sha256 === undefined) continue;
      const resolution = resolutionOf(record, annotation, assetUri);
      if (options.open && resolution !== undefined) continue;
      const number = versionNumber(record, sha256);
      const base = anchorOf(target);
      const frame = target["ag:frame"];
      const view = target["ag:view"];
      const anchor = {
        ...base,
        ...(frame !== undefined && { frame }),
        ...(view !== undefined && { view }),
      };
      const entry: WorkNote = {
        asset: asset.id,
        card,
        id: annotation.id,
        motivation: annotation.motivation,
        created: annotation.created,
        state: resolution === undefined ? "open" : "resolved",
        ...(Object.keys(anchor).length > 0 && { anchor }),
        source: {
          version: number ?? null,
          sha256,
          link: number === undefined ? null : `${assetUri}/versions/${number}`,
        },
        ...(resolution !== undefined && { resolution }),
      };
      notes.push(entry);
      bodies.set(
        entry,
        annotationText(annotation).map((t) => ({ ...t, source: `${asset.id} ${t.source}` })),
      );
    }
  }
  const order = (a: WorkNote, b: WorkNote) =>
    a.asset < b.asset
      ? -1
      : a.asset > b.asset
        ? 1
        : Date.parse(a.created) - Date.parse(b.created) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  notes.sort(order);
  return { notes, text: notes.flatMap((n) => bodies.get(n) ?? []) };
}
