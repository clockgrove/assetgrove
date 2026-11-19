import { relative, sep } from "node:path";
import { z } from "zod";
import { InputError } from "../errors.ts";
import { libraryPath } from "./paths.ts";
import type { ReviewRecord } from "./review.ts";

export const RELATIONS = ["derived-from", "variant-of", "part-of"] as const;
const lineageSchema = z.object({
  relation: z.enum(RELATIONS),
  asset: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export interface VersionReference {
  asset: string;
  sha256: string;
}
export interface Relationship {
  relation: (typeof RELATIONS)[number];
  downstream: VersionReference;
  source: VersionReference;
  reference: string;
}
export interface LineageProblem {
  file: string;
  code: string;
  reference: string;
  message: string;
}
interface RecordAsset {
  reviewPath: string;
  review?: { record: ReviewRecord };
}
const key = (node: VersionReference) => `${node.asset}@${node.sha256}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function relationshipGraph(root: string, assets: readonly RecordAsset[]) {
  const nodes: VersionReference[] = [];
  const current = new Map<string, string>();
  const records = assets
    .filter((asset) => asset.review)
    .map((asset) => ({
      asset: relative(root, asset.reviewPath)
        .split(sep)
        .join("/")
        .replace(/\.review\.json$/, ""),
      file: relative(root, asset.reviewPath).split(sep).join("/"),
      record: asset.review!.record,
    }));
  for (const { asset, record } of records) {
    for (const version of record.versions) nodes.push({ asset, sha256: version.sha256 });
    const last = record.versions.at(-1);
    if (last) current.set(asset, last.sha256);
  }
  nodes.sort((a, b) => compare(key(a), key(b)));
  const known = new Set(nodes.map(key));
  const edges: Relationship[] = [];
  const problems: LineageProblem[] = [];
  for (const { asset, file, record } of records) {
    record.versions.forEach((version, index) => {
      const lineage = version["lineage"];
      if (lineage === undefined) return;
      const location = `ag:versions[${index}].lineage`;
      if (!Array.isArray(lineage)) {
        problems.push({
          file,
          code: "lineage_invalid",
          reference: location,
          message: "lineage must be an array",
        });
        return;
      }
      lineage.forEach((value: unknown, i: number) => {
        const reference = `${location}[${i}]`;
        const refuse = (message: string) =>
          problems.push({ file, code: "lineage_invalid", reference, message });
        const parsed = lineageSchema.safeParse(value);
        if (!parsed.success) {
          refuse(`${JSON.stringify(value)}: ${parsed.error.message}`);
          return;
        }
        const { relation, asset: sourceAsset, sha256 } = parsed.data;
        try {
          libraryPath(root, root, `${sourceAsset}.review.json`, `${file}: ${reference}`);
          if (sourceAsset.split("/").some((part) => part === "." || part === ".." || part === ""))
            throw new InputError("asset must be a canonical library-relative asset id");
        } catch (error) {
          refuse(
            `${JSON.stringify(value)}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        const source = { asset: sourceAsset, sha256 };
        if (!known.has(key(source))) {
          refuse(`unknown source ${key(source)}`);
          return;
        }
        edges.push({
          relation,
          downstream: { asset, sha256: version.sha256 },
          source,
          reference: `${file}:${reference}`,
        });
      });
    });
  }
  edges.sort((a, b) => compare(a.reference, b.reference));
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const from = key(edge.downstream);
    adjacency.set(from, [...(adjacency.get(from) ?? []), key(edge.source)]);
  }
  const reaches = (start: string, target: string) => {
    const pending = [start];
    const visited = new Set<string>();
    while (pending.length) {
      const node = pending.pop()!;
      if (node === target) return true;
      if (visited.has(node)) continue;
      visited.add(node);
      pending.push(...(adjacency.get(node) ?? []));
    }
    return false;
  };
  for (const edge of edges) {
    if (reaches(key(edge.source), key(edge.downstream))) {
      const split = edge.reference.indexOf(":ag:versions");
      problems.push({
        file: edge.reference.slice(0, split),
        code: "lineage_cycle",
        reference: edge.reference.slice(split + 1),
        message: `${key(edge.downstream)} --${edge.relation}--> ${key(edge.source)}`,
      });
    }
  }
  problems.sort((a, b) => compare(`${a.file}:${a.reference}`, `${b.file}:${b.reference}`));
  const changedSources = edges
    .filter((edge) => current.get(edge.source.asset) !== edge.source.sha256)
    .map((edge) => ({ ...edge, currentSha256: current.get(edge.source.asset)! }));
  const affectedKeys = new Set(changedSources.map((edge) => key(edge.downstream)));
  const pending = [...affectedKeys];
  const dependents = new Map<string, string[]>();
  for (const edge of edges) {
    const from = key(edge.source);
    dependents.set(from, [...(dependents.get(from) ?? []), key(edge.downstream)]);
  }
  while (pending.length) {
    for (const downstream of dependents.get(pending.pop()!) ?? []) {
      if (affectedKeys.has(downstream)) continue;
      affectedKeys.add(downstream);
      pending.push(downstream);
    }
  }
  const affected = nodes
    .filter((node) => affectedKeys.has(key(node)))
    .map((node) => ({
      ...node,
      recordedSources: edges.filter((edge) => key(edge.downstream) === key(node)),
    }));
  return { nodes, edges, problems, changedSources, affected };
}

export function browseRelationships(
  graph: ReturnType<typeof relationshipGraph>,
  asset?: string,
  sha256?: string,
) {
  if (sha256 !== undefined && asset === undefined)
    throw new InputError("--sha256 requires --asset");
  const selected =
    asset === undefined
      ? graph.nodes
      : graph.nodes.filter(
          (node) => node.asset === asset && (sha256 === undefined || node.sha256 === sha256),
        );
  if (asset !== undefined && selected.length === 0)
    throw new InputError(
      `unknown asset version ${asset}${sha256 === undefined ? "" : `@${sha256}`}`,
    );
  const keys = new Set(selected.map(key));
  return {
    ...graph,
    selected,
    forward: graph.edges.filter((edge) => keys.has(key(edge.downstream))),
    reverse: graph.edges.filter((edge) => keys.has(key(edge.source))),
  };
}
