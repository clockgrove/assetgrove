/**
 * Near matches before paid generation (design section 7.6): with search loaded and `search.nearMatch`
 * on, the plan step of plan, stage, apply and generate-sheet lists up to three picked assets of the
 * spec's kind, ranked closest to the request by the slot, for the person to judge: no subject
 * filter and no similarity cut. A failed search records `searchError` and the plan goes on.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadBible } from "../bible.ts";
import { calling, searchCall } from "../commands/search.ts";
import type { RunContext } from "../commands/types.ts";
import type { SearchHit } from "../extension/api.ts";
import { CORE_REGISTRY } from "../extensions/registry.ts";
import type { GenerationBrief } from "../planning.ts";
import { sniffMediaType, subjectOf } from "../request.ts";
import type { AssetSpec } from "../types.ts";
import { writeFindSheet } from "./sheet.ts";

/** The most near matches a plan lists. */
export const NEAR_MATCH_LIMIT = 3;

export type NearMatch = SearchHit;

export interface NearMatchOutcome {
  nearMatches?: NearMatch[];
  nearMatchSheet?: string;
  searchError?: string;
}

/**
 * The reference images that show the thing requested: the spec's key pose and, when the Markdown
 * bible at `biblePath` locks the spec's subject, its approved turnaround. The bible's style anchors
 * (positive and negative) are left out: they show the look of the whole game, not this asset.
 */
export async function subjectReferencePaths(
  spec: { value: AssetSpec; dir: string },
  biblePath?: string,
): Promise<string[]> {
  const paths: string[] = [];
  if (biblePath !== undefined) {
    try {
      const doc = await loadBible(biblePath);
      const lock = doc.data.identities[subjectOf(spec.value)];
      if (lock) paths.push(resolve(doc.dir, lock.turnaround));
    } catch {
      // A bible that does not load has no identity to compare; the plan step reports it itself.
    }
  }
  if (typeof spec.value.keyPose === "string") paths.push(resolve(spec.dir, spec.value.keyPose));
  return paths;
}

/**
 * The near matches of one spec: `{}` when no extension fills the search slot or near matches are
 * off, so every field is absent; `searchError` when the search failed.
 */
export async function nearMatchesFor(
  spec: Pick<AssetSpec, "kind" | "assetId" | "subject">,
  referencePaths: readonly string[],
  ctx: RunContext,
  brief?: GenerationBrief,
): Promise<NearMatchOutcome> {
  const slot = (ctx.extensions ?? CORE_REGISTRY).search;
  if (slot?.nearMatch === undefined || ctx.settings.search?.nearMatch === false) return {};
  try {
    const { context, reader } = await searchCall("find", undefined, ctx);
    if (!context.settings.nearMatch) return {};
    const references: Uint8Array[] = [];
    for (const path of new Set(referencePaths)) {
      const bytes = new Uint8Array(await readFile(path));
      if (sniffMediaType(bytes).startsWith("image/")) references.push(bytes);
    }
    const words = [brief?.purpose, brief?.appearsIn, brief?.mood, brief?.context]
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .join(" ");
    const result = await calling(() =>
      slot.nearMatch!(
        {
          kind: spec.kind,
          subject: spec.subject ?? spec.assetId,
          ...(words !== "" && { brief: words }),
          references,
          limit: NEAR_MATCH_LIMIT,
        },
        context,
      ),
    );
    const hits = result.hits.slice(0, NEAR_MATCH_LIMIT);
    if (hits.length === 0) return { nearMatches: [] };
    const images = await Promise.all(hits.map((hit) => reader.loadImageByPath(hit.path)));
    const nearMatchSheet = await writeFindSheet(
      hits,
      images,
      join(ctx.settings.stateDir, "search", "sheets"),
    );
    return { nearMatches: hits, nearMatchSheet };
  } catch (error) {
    return { searchError: error instanceof Error ? error.message : String(error) };
  }
}
