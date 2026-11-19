import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { digestOf } from "../confirm/index.ts";
import type { KindRequest } from "../confirm/index.ts";
import { InputError } from "../errors.ts";
import { PlanChangedError } from "../planning.ts";
import { loadAsset, locateAsset, selectVersion } from "./actions.ts";
import type { LoadedAsset } from "./actions.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { applySuggestedFields, SUGGESTION_BY } from "./card.ts";
import type { Card, SuggestedFieldEntry } from "./card.ts";
import type { DescribeSubject } from "./describe.ts";
import { canonicalLabel, checkedVocabulary } from "./labels.ts";
import type { CardSummary } from "./summary.ts";

const hex = z.string().regex(/^[0-9a-f]{64}$/);
const schema = z.strictObject({
  format: z.literal("assetgrove-suggestions/1"),
  card: z.string().min(1),
  asset: z.string().min(1),
  source: z.strictObject({ version: hex, media: hex, resource: z.string().min(1) }),
  operation: z.literal("vision"),
  model: z.string().min(1),
  createdAt: z.string().min(1),
  baseline: z.strictObject({ description: z.string().nullable(), labels: z.array(z.string()) }),
  fields: z.strictObject({
    description: z.string().min(1),
    labels: z.array(z.string()).optional(),
  }),
});
export type MetadataProposal = z.infer<typeof schema>;
export type SuggestionField = "description" | "labels";

export function metadataProposal(
  subject: DescribeSubject,
  summary: CardSummary,
  model: string,
  labels: boolean,
): MetadataProposal {
  if (!subject.baseline || !subject.version || !subject.mediaDigest)
    throw new InputError("a metadata proposal requires its source snapshot");
  return {
    format: "assetgrove-suggestions/1",
    card: subject.location.cardPath,
    asset: subject.asset,
    source: {
      version: subject.version,
      media: subject.mediaDigest,
      resource: subject.location.resource,
    },
    operation: "vision",
    model,
    createdAt: new Date().toISOString(),
    baseline: subject.baseline,
    fields: { description: summary.description, ...(labels && { labels: summary.tags }) },
  };
}

export function readProposal(path: string): MetadataProposal {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new InputError(`${path}: cannot read metadata proposal`, { cause: error });
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new InputError(`${path}: invalid metadata proposal`);
  return parsed.data;
}

export function selectedSuggestionFields(fields: string[]): SuggestionField[] {
  if (fields.length === 0 || fields.some((field) => field !== "description" && field !== "labels"))
    throw new InputError("card accept needs --field description or --field labels (repeatable)");
  return [...new Set(fields)].sort() as SuggestionField[];
}

export function checkProposal(
  proposal: MetadataProposal,
  fields: SuggestionField[],
  asset: LoadedAsset,
): void {
  if (
    asset.assetId !== proposal.asset ||
    asset.resource !== proposal.source.resource ||
    resolve(asset.cardPath) !== resolve(proposal.card) ||
    selectVersion(asset.record).sha256 !== proposal.source.version ||
    sha256Hex(readFileSync(asset.mediaPath)) !== proposal.source.media
  )
    throw new PlanChangedError("the proposal's source version or media changed; propose again");
  for (const field of fields) {
    if (proposal.fields[field] === undefined)
      throw new InputError(`the proposal has no ${field} suggestion`);
    const current =
      field === "description"
        ? (asset.card.data["description"] ?? null)
        : (asset.card.data["tags"] ?? []);
    if (canonicalJson(current) !== canonicalJson(proposal.baseline[field]))
      throw new PlanChangedError(
        `the card's ${field} changed since this proposal; keep the human edit or propose again`,
      );
  }
  if (fields.includes("labels")) {
    const vocabulary = checkedVocabulary(asset.dir);
    if (!vocabulary) throw new InputError("label suggestions require a project vocabulary");
    for (const label of proposal.fields.labels ?? [])
      if (canonicalLabel(label, vocabulary) !== label)
        throw new InputError(`unknown or non-canonical proposed label "${label}"; propose again`);
  }
}

export function acceptRequest(
  path: string,
  proposal: MetadataProposal,
  fields: SuggestionField[],
  asset: LoadedAsset,
): KindRequest {
  checkProposal(proposal, fields, asset);
  const proposalDigest = digestOf(proposal);
  const body = {
    command: "card accept",
    proposal: resolve(path),
    proposalDigest,
    card: asset.cardPath,
    asset: asset.assetId,
    candidate: proposalDigest,
    fields,
    source: proposal.source,
    baseline: Object.fromEntries(fields.map((field) => [field, proposal.baseline[field]])),
    values: Object.fromEntries(fields.map((field) => [field, proposal.fields[field]])),
  };
  return {
    kind: "pick",
    id: digestOf(body),
    summary: `accept ${fields.join(", ")} suggestions for ${asset.assetId}`,
    details: {
      card: asset.cardPath,
      sourceVersion: proposal.source.version,
      model: proposal.model,
      fields,
      current: body.baseline,
      proposed: body.values,
      proposalDigest,
    },
    body,
  };
}

export async function rebuildAcceptRequest(
  body: Record<string, unknown>,
): Promise<KindRequest | undefined> {
  if (
    typeof body["proposal"] !== "string" ||
    !Array.isArray(body["fields"]) ||
    !body["fields"].every((field): field is string => typeof field === "string")
  )
    return undefined;
  const path = body["proposal"];
  const proposal = readProposal(path);
  const asset = await loadAsset(locateAsset(proposal.card));
  return acceptRequest(path, proposal, selectedSuggestionFields(body["fields"]), asset);
}

export function acceptedCard(
  asset: LoadedAsset,
  proposal: MetadataProposal,
  fields: SuggestionField[],
): Card {
  const values: Record<string, unknown> = {};
  const entries: SuggestedFieldEntry[] = [];
  for (const field of fields) {
    const cardField = field === "labels" ? "tags" : "description";
    const value = proposal.fields[field]!;
    values[cardField] = value;
    entries.push({
      by: `${SUGGESTION_BY}${proposal.operation}:${proposal.model}`,
      at: new Date().toISOString(),
      field: cardField,
      value: sha256Hex(canonicalJson(value)),
      sourceVersion: proposal.source.version,
      proposal: digestOf(proposal),
    });
  }
  return applySuggestedFields(asset.card, values, entries, asset.cardPath);
}
