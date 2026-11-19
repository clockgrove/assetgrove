/**
 * `card edit` (tool `card_edit`, design sections 3.1 and 3.3): a person changes a card's person
 * fields (title, description, tags, the body and fields Assetgrove does not own). Naming a machine
 * field exits 2 `card_field_owned`. The edit is recorded as a `describing` annotation, or `tagging`
 * when only the tags change, with `ag:action: "card-edit"`, and logged; the card text reaches a
 * tool result only under `sharedText`.
 */
import { canonicalLabels, checkedVocabulary, editLabels } from "../library/labels.ts";
import { join, resolve } from "node:path";
import { Budget, runCap } from "../budget.ts";
import { Caller } from "../calls.ts";
import { InputError } from "../errors.ts";
import { PROFILE_PATH } from "../init.ts";
import { loadProfile } from "../inputs.ts";
import { selectDescribed, writeDescribed } from "../library/describe.ts";
import type { Skipped } from "../library/describe.ts";
import { describePrompt, parseSummary } from "../library/summary.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import type { Route } from "../routes.ts";
import {
  DRY_RUN_PROPERTY,
  ROUND_PROPERTY,
  RUNS_PROPERTY,
  buildWorkPlan,
  canonicalJson,
  jobOf,
  paidBy,
} from "../runs/plan.ts";
import { ledgerFor } from "../spend.ts";
import { sha256Hex } from "../library/canonical.ts";
import { libraryConfig } from "../library/write.ts";
import { dryRunOutcome, formatWork } from "./result.ts";
import type { RunContext } from "./types.ts";
import {
  loadAsset,
  locateAsset,
  newest,
  selectVersion,
  withLibraryLock,
  writeAsset,
} from "../library/actions.ts";
import {
  CardFieldOwnedError,
  MACHINE_FIELDS,
  dropSummary,
  setPersonFields,
} from "../library/card.ts";
import { appendAnnotation, nextStamp } from "../library/review.ts";
import type { AnnotationInput } from "../library/review.ts";
import type { SharedText } from "../request.ts";
import { annotationFields } from "./review.ts";
import { defineCommand } from "./types.ts";

interface CardEditArgs {
  address: string;
  title?: string;
  description?: string;
  tag?: string[];
  label?: string[];
  body?: string;
  field?: string[];
}

/** The person fields an edit sets, by name; a machine field throws `CardFieldOwnedError`. */
function editedFields(args: CardEditArgs): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const entry of args.field ?? []) {
    const at = entry.indexOf("=");
    const name = at === -1 ? entry : entry.slice(0, at);
    if ((MACHINE_FIELDS as readonly string[]).includes(name)) throw new CardFieldOwnedError(name);
    if (at <= 0 || !/^[A-Za-z_][\w-]*$/.test(name)) {
      throw new InputError(`--field "${entry}" is not name=value`);
    }
    values[name] = entry.slice(at + 1);
  }
  if (args.title !== undefined) values["title"] = args.title;
  if (args.description !== undefined) values["description"] = args.description;
  if (args.tag !== undefined && args.label !== undefined)
    throw new InputError("choose --label or --tag");
  if (args.label !== undefined || args.tag !== undefined) values["tags"] = args.label ?? args.tag;
  // A card keeps a title, whether --title or --field title= sets it.
  const title = values["title"];
  if (typeof title === "string" && title.trim() === "") {
    throw new InputError("a card's title cannot be empty (--title or --field title=)");
  }
  return values;
}

export const cardEditCommand = defineCommand<CardEditArgs>({
  name: "card edit",
  tool: "card_edit",
  summary: "edit a card's person fields: title, description, tags, body and other fields",
  details: `Changes the person fields of a picked asset's card (docs/library.md): --title, --description,
--tag (repeated; replaces the tags), --body (the Markdown after the front matter) and --field
<name=value> for a field Assetgrove does not own. Naming a machine field (type, format, resource,
generated, verified, sources, kind, subject, state, version, bible, license, lock) exits 2
card_field_owned before anything is written. The address is the asset's card, media or review
record. Appends a describing annotation (tagging when only the tags change) with ag:action
card-edit naming the fields changed, rewrites the card, the folder indexes and logs one line. No
confirmation. The card's text is returned only under sharedText.`,
  input: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "the asset's card, media or review record",
        placeholder: "<address>",
      },
      title: { type: "string", description: "the card's new title", placeholder: "<text>" },
      description: {
        type: "string",
        description: "the card's new description",
        placeholder: "<text>",
      },
      label: {
        type: "array",
        items: { type: "string" },
        description: "canonical project labels; replaces the card labels",
        placeholder: "<label>",
      },
      tag: {
        type: "array",
        items: { type: "string" },
        description: "a tag; the tags given replace the card's tags",
        placeholder: "<tag>",
      },
      body: {
        type: "string",
        description: "the card's new body, the Markdown after its front matter",
        placeholder: "<markdown>",
      },
      field: {
        type: "array",
        items: { type: "string" },
        description: "another person field, as name=value",
        placeholder: "<name=value>",
      },
    },
    required: ["address"],
    additionalProperties: false,
  },
  positionals: [{ name: "address" }],
  effect: { readOnly: false, spends: "never", writes: "target" },
  async run(args, ctx) {
    // A machine field refuses before anything is read or written.
    const values = editedFields(args);
    const changed = [...Object.keys(values), ...(args.body !== undefined ? ["body"] : [])];
    if (changed.length === 0) {
      throw new InputError(
        "card edit needs --title, --description, --tag, --body or --field <name=value>",
      );
    }
    const location = locateAsset(args.address);
    return withLibraryLock(location, ctx.settings.stateDir, async () => {
      const asset = await loadAsset(location);
      if ("tags" in values)
        values["tags"] = editLabels(
          values["tags"],
          asset.card.data["tags"],
          checkedVocabulary(asset.dir),
        );
      let card = setPersonFields(asset.card, values, args.body, asset.cardPath);
      // A person's words replace the summary's: the card no longer reads machine-confirmed.
      if ("description" in values || "tags" in values) card = dropSummary(card, asset.cardPath);
      const version = selectVersion(asset.record);
      const input: AnnotationInput = {
        type: "Annotation",
        motivation: changed.length === 1 && changed[0] === "tags" ? "tagging" : "describing",
        created: nextStamp(asset.record),
        body: [{ type: "TextualBody", purpose: "describing", value: changed.join(", ") }],
        target: { source: asset.resource, "ag:version": version.sha256 },
        "ag:action": "card-edit",
      };
      const record = appendAnnotation(asset.record, input);
      const annotation = newest(record, input);
      const written = await writeAsset({ ...asset, card }, record, { card });
      const sharedText: SharedText[] = [];
      for (const [name, value] of Object.entries(values)) {
        for (const text of [value].flat())
          if (typeof text === "string" && text !== "")
            sharedText.push({ source: `card.${name}`, text });
      }
      if (args.body !== undefined && args.body !== "")
        sharedText.push({ source: "card.body", text: args.body });
      return {
        exitCode: 0,
        fields: {
          asset: asset.assetId,
          changed,
          annotation: annotationFields(annotation),
          files: written.files,
          sharedText,
        },
        human: [
          `edited ${changed.join(", ")} of ${asset.assetId}`,
          ...written.files.map((f) => `wrote ${f}`),
        ].join("\n"),
      };
    });
  },
});

interface CardDescribeArgs {
  address?: string;
  missing?: boolean;
  target?: string;
  profile?: string;
  cap?: number;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
  runs?: string;
}

/** The plan step of `card describe`: the cards to describe, their views and the WorkPlan. */
async function prepareDescribe(args: CardDescribeArgs, ctx: RunContext) {
  if ((args.address === undefined) === (args.missing !== true))
    throw new InputError("give the asset's address, or --missing, and not both");
  let missingIn: string | undefined;
  if (args.missing === true) {
    const targetDir = resolve(args.target ?? ".");
    const profilePath = resolve(args.profile ?? join(targetDir, PROFILE_PATH));
    let profile;
    try {
      profile = (await loadProfile(profilePath)).value;
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError(`cannot read the target profile ${profilePath}`, { cause: error });
    }
    missingIn = libraryConfig(profile, targetDir).root;
  }
  const { pending, skipped } = await selectDescribed(
    {
      ...(args.address !== undefined && { address: args.address }),
      ...(missingIn !== undefined && { missingIn }),
    },
    ctx.extensions,
  );
  const provider = await providerSet(args.providerScript, ctx);
  const jobs = [jobOf("vision", provider.routes["vision"] as Route, pending.length)];
  const work = await buildWorkPlan(cardDescribeCommand, args, {
    inputs: [],
    hashes: {
      pending: sha256Hex(
        canonicalJson(
          pending.map((p) => [
            p.asset,
            p.location.cardPath,
            p.mediaSha256,
            p.images.map((i) => i.sha256),
          ]),
        ),
      ),
    },
    jobs,
    capUsd: runCap(args.cap, ctx.settings),
    paid: paidBy(provider, jobs),
    providers: provider,
    candidates: 0,
  });
  return { pending, skipped, provider, work };
}

export const cardDescribeCommand = defineCommand<CardDescribeArgs>({
  name: "card describe",
  tool: "card_describe",
  summary: "have a vision model write a card's description and tags (paid)",
  details: `Writes a model-written description and tags into the card of an asset (give its card, media
or review record) or into every card of the library of --target's profile that has no description
(--missing). One vision call per card, shown the asset's image (a 3D asset's turntable renders). The
summary is recorded in the card's verified list as process:assetgrove-summary:vision:<model>, so it
reads as machine-written. A card whose description or tags a person wrote is never overwritten and
is listed under skipped with the reason, as is an asset with no image view (audio, a Git LFS
pointer, a file that does not decode) or a reply with no summary. A paid command: plan step,
forecast, confirmation and caps. The written text is returned only under sharedText.`,
  input: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "the asset's card, media or review record",
        placeholder: "<address>",
      },
      missing: {
        type: "boolean",
        description: "describe every card with no description in the library of --target",
      },
      target: {
        type: "string",
        description: "the target directory holding the library (with --missing)",
        default: ".",
      },
      profile: {
        type: "string",
        description: "the target profile (default <target>/.assetgrove/profile.json)",
        placeholder: "<profile.json>",
      },
      cap: {
        type: "number",
        description:
          "the run's cost cap in USD; at most, and by default, the settings' caps.runUsd",
        placeholder: "<usd>",
      },
      workItem: {
        type: "string",
        description: "the work item the spend ledger counts against",
        placeholder: "<label>",
      },
      providerScript: {
        type: "string",
        description: "answer every model call from this module instead of a provider",
        placeholder: "<module>",
      },
      runs: RUNS_PROPERTY,
      round: ROUND_PROPERTY,
      dryRun: DRY_RUN_PROPERTY,
    },
    additionalProperties: false,
  },
  positionals: [{ name: "address" }],
  effect: { readOnly: false, spends: "always", writes: "runs" },
  confirm: "spend",
  replayFinished: false,
  plan: async (args, ctx) => (await prepareDescribe(args, ctx)).work,
  async run(args, ctx) {
    const { pending, skipped: unviewable, provider, work } = await prepareDescribe(args, ctx);
    if (args.dryRun)
      return dryRunOutcome(
        work,
        formatWork("card describe", work),
        spendLedger(ctx, args.workItem),
      );
    const routes = provider.routes;
    const budget = new Budget(
      work.capUsd,
      ledgerFor(spendLedger(ctx, args.workItem), provider, {}),
    );
    budget.check(
      pending.length * (routes["vision"] as Route).estimatedCostUsd,
      `${pending.length} card descriptions`,
    );
    const caller = new Caller({ provider, budget, routes, log: ctx.log });
    const described: { asset: string; files: string[] }[] = [];
    const skipped: Skipped[] = [...unviewable];
    const sharedText: SharedText[] = [];
    for (const subject of pending) {
      const vocabulary = checkedVocabulary(subject.location.dir);
      const reply = await caller.vision(
        "vision",
        describePrompt({
          ...(subject.kind !== undefined && { kind: subject.kind }),
          ...(subject.subject !== undefined && { subject: subject.subject }),
          views: subject.images.length,
          ...(vocabulary && { labels: vocabulary.labels.map((label) => label.name) }),
        }),
        subject.images,
      );
      const summary = parseSummary(reply);
      if (summary === undefined) {
        skipped.push({ asset: subject.asset, reason: "no summary in the reply" });
        continue;
      }
      summary.tags = canonicalLabels(summary.tags, vocabulary, "omit");
      const model = caller.records[caller.records.length - 1]!.model;
      const written = await writeDescribed(
        subject,
        summary,
        model,
        ctx.settings.stateDir,
        args.missing === true,
      );
      if ("skipped" in written) {
        skipped.push({ asset: subject.asset, reason: written.skipped });
        continue;
      }
      described.push({ asset: subject.asset, files: written.files });
      sharedText.push({ source: "card.description", text: summary.description });
      for (const tag of summary.tags) sharedText.push({ source: "card.tags", text: tag });
    }
    const human = [
      `described ${described.length} card(s)`,
      ...described.map((d) => `  ${d.asset}: wrote ${d.files.join(", ")}`),
      ...(skipped.length > 0 ? [`skipped ${skipped.length}:`] : []),
      ...skipped.map((s) => `  ${s.asset}: ${s.reason}`),
      `spent $${budget.spentUsd.toFixed(4)}`,
    ].join("\n");
    return {
      exitCode: 0,
      fields: { described, skipped, spentUsd: budget.spentUsd, sharedText },
      human,
    };
  },
});
