/**
 * The disclosure summary (design section 6): what a library says about its AI-made assets, read
 * from the cards and the provenance each card names, for a developer filling in Steam's AI content
 * survey or itch.io's AI tags. Only the fields it reports are read: no prompt, parameter or
 * request ID reaches the summary. It is help for the developer, not a compliance claim.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CORE_REGISTRY } from "./extensions/registry.ts";
import { mediaOf } from "./media.ts";
import type { KindMedia } from "./media.ts";
import { upstreamOf } from "./dataflows.ts";
import { canCarryCredentials, readCredentials } from "./credentials.ts";
import { markableMediaType } from "./handoff/mark-check.ts";
import { readDigitalSourceType, readMarkedModels, parseDigitalSourceType } from "./metadata.ts";
import { parseCard } from "./library/card.ts";
import { libraryPath } from "./library/paths.ts";
import { scanLibrary } from "./library/write.ts";
import { adapterOf } from "./providers/adapter.ts";
import type { Settings } from "./settings.ts";

export interface DisclosureCount {
  name: string;
  assets: number;
}
export interface DisclosureTerms {
  terms: string;
  /** The `as of` date the terms were recorded with, when they say one. */
  asOf?: string;
  assets: number;
}
export interface DisclosureSigner {
  subject: string;
  certificateSha256: string;
  development: boolean;
  assets: number;
}
export interface DisclosureCredentials {
  /** Assets whose provenance records a signing certificate. */
  signed: number;
  /** Of those, the assets signed with the local development certificate. */
  development: number;
  signers: DisclosureSigner[];
  /** Present only when something was signed with the development certificate. */
  note?: string;
}
export interface StoreEvidence {
  policy: string;
  checkedOn: string;
  status: "resolved" | "unresolved";
  affectedAssets: string[];
  unresolvedAssets: string[];
  what: string;
  how: string;
}
export interface DisclosureSound {
  asset: string;
  kind: string;
  models: string[];
  providers: string[];
  plans: string[];
  /** Present only when a call's output grant is not exclusive. */
  exclusive?: false;
  trainingOptOut?: { optedOut: boolean; since: string; source: string };
  line: string;
}
export interface Disclosure {
  /** Cards read. */
  assets: number;
  /** Assets by kind, then by IPTC source type (the vocabulary's last segment, or `unknown`). */
  byKind: Record<string, Record<string, number>>;
  bySourceType: DisclosureCount[];
  models: DisclosureCount[];
  providers: DisclosureCount[];
  /** The model vendors behind gateway calls; empty without settings to name the adapters. */
  vendors: DisclosureCount[];
  terms: DisclosureTerms[];
  contentCredentials: DisclosureCredentials;
  /** Cards whose provenance could not be read; they count as `unknown`. */
  withoutProvenance: string[];
  /** One entry per audio asset, from its route record, sorted by asset name. */
  sounds: DisclosureSound[];
  godot: StoreEvidence;
  playdate: StoreEvidence;
  steam: string;
  itch: { tags: string[]; text: string };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function list(map: Map<string, number>): DisclosureCount[] {
  return [...map]
    .map(([name, assets]) => ({ name, assets }))
    .sort((a, b) => b.assets - a.assets || compare(a.name, b.name));
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

const AI_TYPES = new Set(["trainedAlgorithmicMedia", "compositeWithTrainedAlgorithmicMedia"]);

/** The provenance record in a file: the file itself, or the object a manifest embeds it as. */
function findProvenance(value: unknown, depth: number): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value) || depth > 4)
    return undefined;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object["models"]) && typeof object["route"] === "string") return object;
  for (const child of Object.values(object)) {
    const found = findProvenance(child, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The date a record made before routes carried `providerTermsAsOf` wrote into its terms text as
 * `(as of YYYY-MM-DD)`; read only when no call of the library records the date as a field.
 */
function legacyTermsAsOf(text: string): string | undefined {
  return /\(as of (\d{4}-\d{2}-\d{2})\)/.exec(text)?.[1];
}

/** The sound entry of an audio asset: what its provenance's route record says, and no more. */
function soundOf(
  asset: string,
  kind: string,
  provenance: Record<string, unknown> | undefined,
): DisclosureSound {
  const calls = (Array.isArray(provenance?.["calls"]) ? provenance["calls"] : []) as Array<{
    route?: unknown;
    model?: unknown;
    outputGrant?: { plan?: unknown; exclusive?: unknown } | null;
    trainingOptOut?: { optedOut?: unknown; since?: unknown; source?: unknown } | null;
  } | null>;
  const models = new Set(strings(provenance?.["models"]));
  const providers = new Set<string>();
  const plans = new Set<string>();
  let exclusive = true;
  let optOut: DisclosureSound["trainingOptOut"];
  for (const call of calls) {
    if (typeof call?.model === "string" && models.size === 0) models.add(call.model);
    const provider = typeof call?.route === "string" ? call.route.split(":")[0] : undefined;
    if (provider) providers.add(provider);
    if (typeof call?.outputGrant?.plan === "string") plans.add(call.outputGrant.plan);
    if (call?.outputGrant?.exclusive === false) exclusive = false;
    const out = call?.trainingOptOut;
    if (
      optOut === undefined &&
      typeof out?.optedOut === "boolean" &&
      typeof out.since === "string" &&
      typeof out.source === "string"
    )
      optOut = { optedOut: out.optedOut, since: out.since, source: out.source };
  }
  const head = `Sound: ${asset} (${kind}): `;
  if (calls.length === 0 || providers.size === 0)
    return {
      asset,
      kind,
      models: [],
      providers: [],
      plans: [],
      line: `${head}route record unavailable`,
    };
  const line =
    `${head}${[...models].join(", ") || "unnamed model"} via ${[...providers].join(", ")}` +
    (plans.size === 0 ? "" : `, ${[...plans].join(", ")} plan`) +
    (exclusive ? "" : ", non-exclusive") +
    (optOut === undefined
      ? ""
      : `, training opt-out declared by the developer: ${optOut.optedOut ? "yes" : "no"} since ${optOut.since}`);
  return {
    asset,
    kind,
    models: [...models],
    providers: [...providers],
    plans: [...plans],
    ...(!exclusive && { exclusive: false as const }),
    ...(optOut !== undefined && { trainingOptOut: optOut }),
    line,
  };
}

/** Summarises the library under `root` from its cards and provenance. */
export async function disclose(
  root: string,
  options: {
    settings?: Pick<Settings, "providers">;
    selected?: string[];
    /** The kinds whose media trait says which assets are audio; core's by default. */
    kinds?: KindMedia;
  } = {},
): Promise<Disclosure> {
  const kindMedia = options.kinds ?? CORE_REGISTRY;
  const byKind: Record<string, Record<string, number>> = {};
  const sources = new Map<string, number>();
  const models = new Map<string, number>();
  const providers = new Map<string, number>();
  const vendors = new Map<string, number>();
  const terms = new Map<string, number>();
  const termDates = new Map<string, string>();
  const withoutProvenance: string[] = [];
  const sounds: DisclosureSound[] = [];
  const signers = new Map<string, DisclosureSigner>();
  let approvedAi = 0;
  const { cards: allCards, unreadable } = scanLibrary(root);
  const mediaName = (card: (typeof allCards)[number]): string =>
    relative(resolve(root), resolve(card.dir, card.resource ?? `${card.id}.md`))
      .split("\\")
      .join("/");
  const selected = options.selected === undefined ? undefined : new Set(options.selected);
  const unresolvedAssets: string[] =
    selected === undefined
      ? unreadable
          .filter((record) => record.code === "card_invalid")
          .map((record) => relative(resolve(root), record.file).split("\\").join("/"))
      : [...selected].filter((name) => !allCards.some((card) => mediaName(card) === name));
  const affectedAssets: string[] = [];
  const cards = allCards
    .filter((card) => selected === undefined || selected.has(mediaName(card)))
    .sort((a, b) => compare(join(a.dir, a.id), join(b.dir, b.id)));
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (const found of cards) {
    const path = join(found.dir, `${found.id}.md`);
    let kind = "unknown";
    let provenance: Record<string, unknown> | undefined;
    let state: unknown;
    let declaredOrigin: unknown;
    try {
      const data = parseCard(readFileSync(path, "utf8"), path).data as Record<string, unknown>;
      if (typeof data["kind"] === "string") kind = data["kind"];
      state = data["state"];
      declaredOrigin = data["origin"];
      const entry = (Array.isArray(data["sources"]) ? data["sources"] : []).find(
        (s: unknown) => (s as { id?: unknown } | null)?.id === "provenance",
      ) as { resource?: unknown } | undefined;
      if (typeof entry?.resource === "string") {
        // The source is the provenance file, or the manifest when the profile embeds provenance.
        const doc = JSON.parse(
          readFileSync(libraryPath(root, found.dir, entry.resource, path), "utf8"),
        ) as Record<string, unknown>;
        provenance = findProvenance(doc, 0);
      }
    } catch {
      provenance = undefined;
    }
    // Without a provenance file (a profile that embeds it in its manifest) the media's own mark
    // says the source type and the models.
    let marked: { source?: string; models: string[] } | undefined;
    // Without a provenance file, the media's own C2PA manifest says which certificate signed.
    let credentials: Record<string, unknown> | undefined;
    if (provenance === undefined) {
      withoutProvenance.push(path);
      const type = found.resource === undefined ? undefined : markableMediaType(found.resource);
      if (found.resource !== undefined && type !== undefined) {
        try {
          const bytes = new Uint8Array(readFileSync(join(found.dir, found.resource)));
          marked = {
            ...(readDigitalSourceType(bytes, type) !== undefined && {
              source: readDigitalSourceType(bytes, type) as string,
            }),
            models: (readMarkedModels(bytes, type) ?? "").split("; ").filter(Boolean),
          };
          const read = canCarryCredentials(type) ? await readCredentials(bytes, type) : undefined;
          if (read?.certificateSha256 !== undefined)
            credentials = {
              certificateSha256: read.certificateSha256,
              subject: read.signer.subject ?? "",
              development: read.development === true,
            };
        } catch {
          marked = undefined;
        }
      }
    }
    const declared = provenance?.["digitalSourceType"] ?? marked?.source;
    const source =
      typeof declared === "string" && declared !== "undeclared"
        ? (declared.split("/").pop() ?? "unknown")
        : "unknown";
    const name = mediaName(found);
    if (AI_TYPES.has(source)) affectedAssets.push(name);
    let mediaMatches = false;
    if (found.resource && found.sha256) {
      try {
        mediaMatches =
          createHash("sha256")
            .update(readFileSync(join(found.dir, found.resource)))
            .digest("hex") === found.sha256;
      } catch {
        /* Unavailable bytes remain unresolved. */
      }
    }
    const originKind =
      declaredOrigin && typeof declaredOrigin === "object"
        ? (declaredOrigin as Record<string, unknown>)["kind"]
        : undefined;
    if (
      source === "unknown" ||
      typeof declared !== "string" ||
      parseDigitalSourceType(declared) === undefined ||
      originKind === "unknown" ||
      !found.resource ||
      !existsSync(join(found.dir, found.resource)) ||
      !mediaMatches
    )
      unresolvedAssets.push(name);
    if (mediaOf(kind, kindMedia) === "audio") sounds.push(soundOf(name, kind, provenance));
    const row = (byKind[kind] ??= {});
    row[source] = (row[source] ?? 0) + 1;
    bump(sources, source);
    if (AI_TYPES.has(source) && state === "approved") approvedAi += 1;
    for (const model of new Set(
      provenance ? strings(provenance["models"]) : (marked?.models ?? []),
    ))
      bump(models, model);
    const calls = Array.isArray(provenance?.["calls"]) ? (provenance["calls"] as unknown[]) : [];
    const named = new Set<string>();
    const vendorNames = new Set<string>();
    for (const call of calls) {
      const fields = call as { route?: unknown; model?: unknown } | null;
      const route = typeof fields?.route === "string" ? fields.route.split(":") : [];
      const providerId = route[0];
      if (route.length < 3 || !providerId) continue;
      named.add(providerId);
      const entry = options.settings?.providers[providerId] ?? {};
      const adapter = options.settings === undefined ? undefined : adapterOf(providerId, entry);
      const model = route.slice(2).join(":");
      const vendor = adapter === undefined ? null : upstreamOf(adapter.id, model);
      if (vendor !== null) vendorNames.add(vendor);
    }
    if (
      named.size === 0 &&
      strings(provenance?.["models"]).length > 0 &&
      typeof provenance?.["route"] === "string"
    )
      named.add(provenance["route"]);
    for (const vendor of vendorNames) bump(vendors, vendor);
    for (const provider of named) bump(providers, provider);
    for (const t of new Set(strings(provenance?.["providerTerms"]))) bump(terms, t);
    for (const call of calls) {
      const fields = call as { providerTerms?: unknown; providerTermsAsOf?: unknown } | null;
      if (typeof fields?.providerTerms === "string" && typeof fields.providerTermsAsOf === "string")
        termDates.set(fields.providerTerms, fields.providerTermsAsOf);
    }
    const signer = (provenance?.["contentCredentials"] ?? credentials) as
      Record<string, unknown> | null | undefined;
    if (signer && typeof signer === "object" && typeof signer["certificateSha256"] === "string") {
      const hash = signer["certificateSha256"];
      const entry = signers.get(hash) ?? {
        subject: typeof signer["subject"] === "string" ? signer["subject"] : "",
        certificateSha256: hash,
        development: signer["development"] === true,
        assets: 0,
      };
      entry.assets += 1;
      signers.set(hash, entry);
    }
  }
  const signerList = [...signers.values()].sort(
    (a, b) => b.assets - a.assets || compare(a.certificateSha256, b.certificateSha256),
  );
  const signed = signerList.reduce((n, x) => n + x.assets, 0);
  const development = signerList.filter((x) => x.development).reduce((n, x) => n + x.assets, 0);
  const contentCredentials: DisclosureCredentials = {
    signed,
    development,
    signers: signerList,
    ...(development > 0 && {
      note:
        `${development} ${development === 1 ? "asset was" : "assets were"} signed with Assetgrove's local development certificate, ` +
        "which no C2PA trust list holds. A certificate from a C2PA-recognised authority, set in developer settings " +
        "`contentCredentials`, replaces it before release.",
    }),
  };
  const termList = [...terms]
    .map(([text, assets]): DisclosureTerms => {
      const asOf = termDates.get(text) ?? legacyTermsAsOf(text);
      return { terms: text, ...(asOf !== undefined && { asOf }), assets };
    })
    .sort((a, b) => compare(a.terms, b.terms));
  sounds.sort((a, b) => compare(a.asset, b.asset));
  const soundLines = sounds.map((sound) => `\n${sound.line}`).join("");
  const generated = cards.length;
  const aiAssets = [...sources].filter(([s]) => AI_TYPES.has(s)).reduce((n, [, c]) => n + c, 0);
  const modelNames = list(models).map((m) => m.name);
  const kinds = Object.keys(byKind).sort();
  const made = modelNames.length > 0 ? ` with ${modelNames.join(", ")}` : "";
  const approvedText =
    approvedAi === 0
      ? "none of them is recorded as approved by the developer yet"
      : `${approvedAi} of them recorded as approved by the developer`;
  const steam =
    aiAssets === 0
      ? `Pre-generated AI content: none recorded in ${generated} library assets.`
      : `Pre-generated AI content: ${aiAssets} of ${generated} assets (${kinds.join(", ")}) were made${made}, ` +
        `${approvedText}. Live-generated AI content: [developer to fill in].`;
  const steamText = steam + soundLines;
  const itchTags = aiAssets === 0 ? [] : ["ai-generated-assets"];
  const itchText =
    aiAssets === 0
      ? "No AI-generated assets recorded."
      : `AI-generated assets: ${aiAssets} of ${generated} (${kinds.join(", ")})${made}.`;
  const itchFull = itchText + soundLines;
  return {
    assets: generated,
    byKind,
    bySourceType: list(sources),
    models: list(models),
    providers: list(providers),
    vendors: list(vendors),
    terms: termList,
    contentCredentials,
    withoutProvenance,
    sounds,
    godot: {
      policy: "https://docs.godotengine.org/en/stable/community/asset_store/faq.html",
      checkedOn: "2026-11-19",
      status: unresolvedAssets.length || affectedAssets.length ? "unresolved" : "resolved",
      affectedAssets,
      unresolvedAssets: [...new Set([...unresolvedAssets, ...affectedAssets])].sort(compare),
      what: affectedAssets.length ? affectedAssets.join(", ") : "No generated media recorded.",
      how: affectedAssets.length
        ? `Generated or edited with AI${made}. Developer must describe the creation process.`
        : "No AI creation process recorded.",
    },
    playdate: {
      policy: "https://help.play.date/catalog-developer/ai-disclosure/",
      checkedOn: "2026-11-19",
      status: unresolvedAssets.length ? "unresolved" : "resolved",
      affectedAssets,
      unresolvedAssets: [...new Set(unresolvedAssets)].sort(compare),
      what: affectedAssets.length
        ? "Selected AI media triggers the April 2026 new-title Catalog exclusion."
        : "No selected AI media trigger recorded.",
      how: "New-title policy only; code assistance and grandfathered titles require developer review. This is media evidence, not title eligibility.",
    },
    steam: steamText,
    itch: { tags: itchTags, text: itchFull },
  };
}

/** The summary as Markdown, for `--out`. */
export function disclosureMarkdown(d: Disclosure): string {
  const rows = (items: DisclosureCount[]): string[] =>
    items.length ? items.map((i) => `- ${i.name}: ${i.assets}`) : ["- none"];
  return (
    [
      "# AI disclosure summary",
      "",
      `Assets read: ${d.assets}`,
      "",
      "## Assets by kind and source type",
      ...Object.entries(d.byKind).flatMap(([kind, row]) =>
        Object.entries(row).map(([source, n]) => `- ${kind} / ${source}: ${n}`),
      ),
      "",
      "## Models",
      ...rows(d.models),
      "",
      "## Providers",
      ...rows(d.providers),
      "",
      "## Model vendors behind gateways",
      ...rows(d.vendors),
      "",
      "## Provider terms",
      ...(d.terms.length
        ? d.terms.map((t) => `- ${t.terms}${t.asOf ? ` [${t.asOf}]` : ""}: ${t.assets}`)
        : ["- none"]),
      "",
      "## Content credentials",
      `Signed assets: ${d.contentCredentials.signed}`,
      ...d.contentCredentials.signers.map(
        (x) =>
          `- ${x.subject} (${x.development ? "development, " : ""}sha256 ${x.certificateSha256}): ${x.assets}`,
      ),
      ...(d.contentCredentials.note ? [d.contentCredentials.note] : []),
      "",
      "## Godot Asset Store AI usage disclosure",
      `Status: ${d.godot.status}`,
      `What: ${d.godot.what}`,
      `How: ${d.godot.how}`,
      `Unresolved assets: ${d.godot.unresolvedAssets.join(", ") || "none"}`,
      "",
      "## Playdate Catalog (April 2026 new-title policy)",
      `Status: ${d.playdate.status}`,
      d.playdate.what,
      d.playdate.how,
      `Affected assets: ${d.playdate.affectedAssets.join(", ") || "none"}`,
      `Unresolved assets: ${d.playdate.unresolvedAssets.join(", ") || "none"}`,
      "",
      "## Steam AI content survey",
      d.steam,
      "",
      "## itch.io AI tags",
      `Tags: ${d.itch.tags.join(", ") || "none"}`,
      d.itch.text,
      "",
    ].join("\n") + "\n"
  );
}
