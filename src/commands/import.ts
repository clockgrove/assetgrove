import { join, resolve } from "node:path";
import { Budget, runCap } from "../budget.ts";
import { Caller } from "../calls.ts";
import {
  declarationOption,
  lockFor,
  readBytes,
  sliceOptions,
  loadProfile,
  loadStyleBible,
} from "../inputs.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { loadBibleInputs } from "../request.ts";
import { CONTACT_FILE, GROUPING_FILE, importSheet } from "../sheet/import.ts";
import type { ImportOptions, ImportRecord } from "../sheet/import.ts";
import type { Grouping } from "../sheet/types.ts";
import { ledgerFor } from "../spend.ts";
import type { AssetSpec } from "../types.ts";
import { IDENTITY_OPERATION } from "../identity.ts";
import {
  IDENTITY_CAST_OPERATION,
  IDENTITY_CHECK_OPERATION,
  SHEET_BLOB_OPERATION,
} from "../routes.ts";
import { decodeImage } from "../image/raster.ts";
import { plannedBlobDecisions } from "../sheet/blobs.ts";
import type { Route } from "../routes.ts";
import {
  DRY_RUN_PROPERTY,
  ROUND_PROPERTY,
  RUNS_PROPERTY,
  bibleReads,
  buildWorkPlan,
  styleBibleReads,
  jobsOf,
  paidBy,
} from "../runs/plan.ts";
import { dryRunOutcome, formatWork } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";

/** The identity score of an import as text lines. */
export function formatIdentity(record: ImportRecord): string[] {
  const score = record.identity;
  if (!score) return [];
  return [
    `identity ${score.mode} (${score.model}): ${score.reason}`,
    ...(score.filtered ? ["  write-families will refuse this sheet"] : []),
  ];
}

/** An import as text: the frames, their failed checks and the proposed grouping. */
export function formatImport(record: ImportRecord, importDir: string, grouping: Grouping): string {
  const lines = [
    `import ${record.importId}: ${record.frames.length} frames (${record.slice.mode}) from ${record.sheet.path}`,
    `staged in ${importDir}; contact sheet ${join(importDir, CONTACT_FILE)}`,
    ...formatIdentity(record),
  ];
  for (const f of record.frames) {
    for (const c of f.checks.filter((c) => !c.passed)) {
      lines.push(`  frame ${f.id} ${c.check}: ${c.reason}`);
    }
  }
  lines.push("", `proposed grouping (${join(importDir, GROUPING_FILE)}):`);
  for (const f of grouping.families) {
    const frames = f.mirrorOf ? `mirror of ${f.mirrorOf}` : (f.frames ?? []).join(" ");
    lines.push(`  ${f.name}: ${frames}  (${f.reason})`);
  }
  if (grouping.unassigned.length > 0) lines.push(`  unassigned: ${grouping.unassigned.join(" ")}`);
  if (grouping.notes) lines.push(`  notes: ${grouping.notes}`);
  lines.push(
    "",
    'review it, edit it, set "status": "confirmed", then run:',
    `  assetgrove write-families --import ${importDir} --target <dir>`,
  );
  return lines.join("\n");
}

interface ImportArgs {
  sheet: string;
  profile: string;
  asset: string;
  tool: string;
  digitalSourceType?: string;
  bible?: string;
  subject?: string;
  hints?: string;
  frames?: number;
  grid?: number;
  components?: boolean;
  maxHalo?: number;
  noPropose?: boolean;
  lockBible?: string;
  identityMode?: string;
  cap?: number;
  imports?: string;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
  runs?: string;
}

/** Import's plan step: its inputs, the calls it can make and its WorkPlan, with no call. */
async function prepare(args: ImportArgs, ctx: RunContext) {
  const capUsd = runCap(args.cap, ctx.settings);
  const slice = sliceOptions(args.grid, args.components, args.frames);
  const profile = await loadProfile(args.profile);
  const bible = args.bible ? await loadStyleBible(args.bible) : undefined;
  // A BIBLE.md holds the identity locks too: it is the lock bible unless --lock-bible names another.
  const lockBible = args.lockBible ?? args.bible;
  const subject = args.subject ?? args.asset;
  const sheet = await readBytes(args.sheet, "sheet");
  const digitalSourceType = declarationOption(args.digitalSourceType);
  const providers = await providerSet(args.providerScript, ctx);
  const lock = await lockFor(
    lockBible,
    args.identityMode,
    subject,
    profile.value,
    providers.routes,
  );
  // The blobs slicing cannot tell by area are each judged by one decision; a clean sheet has none.
  // A sheet that does not decode is refused by the import itself, naming why.
  let blobCalls: number;
  try {
    blobCalls = plannedBlobDecisions(decodeImage(sheet), slice);
  } catch {
    blobCalls = 0;
  }
  const operations = [
    ...Array<string>(blobCalls).fill(SHEET_BLOB_OPERATION),
    ...(args.noPropose ? [] : ["vision"]),
    ...(lock && lock.settings.mode !== "off"
      ? [
          lock.settings.question === "cast" ? IDENTITY_CAST_OPERATION : IDENTITY_OPERATION,
          ...(lock.settings.mode === "enforce" ? [IDENTITY_CHECK_OPERATION] : []),
        ]
      : []),
  ];
  // Always made: the prompt policy's model check runs on the bible's prompt text (makes no call).
  const jobs =
    operations.length > 0
      ? jobsOf(
          operations.map((operation) => ({
            operation,
            model: (providers.routes[operation] as Route).model,
            estimatedCostUsd: (providers.routes[operation] as Route).estimatedCostUsd,
          })),
          providers.routes,
        )
      : [];
  const work = await buildWorkPlan(importCommand, args, {
    promptAllow: ctx.settings.promptPolicy.allow,
    inputs: ["sheet", "profile", "bible", "lockBible"],
    reads: {
      ...(bible ? styleBibleReads("bible", bible) : {}),
      ...(lock && lockBible !== undefined
        ? await bibleReads("lockBible", lockBible, lock.cast ? undefined : [lock.record.subject])
        : {}),
      // The recorded threshold decides which candidates enforce mode drops.
      ...(lock?.recordPath !== undefined && { "lockBible/identity-thresholds": lock.recordPath }),
    },
    // The grouping proposal's prompt names the subject and carries the hints.
    promptText: args.noPropose ? [] : [args.subject, args.hints].filter((t) => t !== undefined),
    jobs,
    capUsd,
    paid: paidBy(providers, jobs),
    providers,
    candidates: 1,
  });
  return {
    capUsd,
    slice,
    blobCalls,
    profile,
    bible,
    subject,
    sheet,
    digitalSourceType,
    lock,
    providers,
    work,
  };
}

export const importCommand = defineCommand<ImportArgs>({
  name: "import",
  tool: "import",
  summary: "slice a contact sheet into frames and propose animation families",
  details: `Slices a contact sheet (from any tool; --tool names it, for example "ChatGPT image
generation"), removes the background to the profile's style, and has a vision model propose
families in <import>/grouping.json with status "proposed" (--no-propose skips the grouping
model; it needs no key unless --lock-bible names a locked subject, whose identity score is a
model call in shadow and enforce modes: add --identity-mode off to skip it, or the sheet holds
blobs slicing cannot tell by area, such as number labels or a detached part, each judged by one
sheet-blob decision; a clean sheet makes none). A human reviews the proposal against contact.png, edits it and sets its status
to "confirmed" before write-families. See docs/sheet-import.md.

With --frames, the sheet must hold exactly that many figures: slicing another number is refused
(exit 2) before any model call but the sheet-blob decisions, whose answers it counts after,
naming the cells or figures behind the difference.

With --lock-bible, or a --bible that is a BIBLE.md (the lock bible unless --lock-bible names
another), a subject with an identity lock in that art bible has its contact sheet scored
against the lock by the identity decision model. --identity-mode overrides the profile's
identity.mode: shadow (default) records the score, enforce makes write-families refuse a sheet
below the threshold, off skips scoring.`,
  input: {
    type: "object",
    properties: {
      sheet: { type: "string", description: "the contact sheet image", placeholder: "<sheet.png>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      asset: { type: "string", description: "the asset id", placeholder: "<id>" },
      tool: { type: "string", description: "the tool that made the sheet", placeholder: "<name>" },
      digitalSourceType: {
        type: "string",
        description: "the IPTC digital source type to declare",
        placeholder: "<IPTC code or URI>",
      },
      bible: {
        type: "string",
        description: "the style bible (BIBLE.md)",
        placeholder: "<BIBLE.md>",
      },
      subject: {
        type: "string",
        description: "the subject, when not the asset id",
        placeholder: "<name>",
      },
      hints: {
        type: "string",
        description: "family names to propose, comma separated",
        placeholder: "idle,walk-right,...",
      },
      frames: {
        type: "integer",
        minimum: 1,
        description: "how many figures the sheet must hold",
        placeholder: "<count>",
      },
      grid: {
        type: "integer",
        minimum: 1,
        description: "slice a grid of this many columns",
        placeholder: "<columns>",
      },
      components: { type: "boolean", description: "slice by connected components" },
      maxHalo: {
        type: "number",
        minimum: 0,
        description:
          "the matte checks' limit, 0 to 1: the share of a frame's edge pixels that may keep the background colour (default 0.005)",
        placeholder: "<fraction>",
      },
      noPropose: { type: "boolean", description: "skip the grouping model" },
      lockBible: {
        type: "string",
        description:
          "score the sheet against the subject's identity lock in this art bible (default: --bible)",
        placeholder: "<BIBLE.md>",
      },
      identityMode: {
        type: "string",
        description: "override the profile's identity mode",
        placeholder: "<off|shadow|enforce>",
      },
      cap: {
        type: "number",
        description:
          "the run's cost cap in USD; at most, and by default, the settings' caps.runUsd",
        placeholder: "<usd>",
      },
      imports: {
        type: "string",
        description: "where imports are staged",
        default: ".assetgrove/imports",
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
    required: ["sheet", "profile", "asset", "tool"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "runs" },
  confirm: "spend",
  plan: async (args, ctx) => (await prepare(args, ctx)).work,
  async run(args, ctx) {
    const ledger = spendLedger(ctx, args.workItem);
    const {
      capUsd,
      slice,
      blobCalls,
      profile,
      bible,
      subject,
      sheet,
      digitalSourceType,
      lock,
      providers,
      work,
    } = await prepare(args, ctx);
    if (args.dryRun) {
      const human = formatWork("import", work);
      return dryRunOutcome(work, human, ledger.forProfile(profile.value));
    }
    let shared: Caller | undefined;
    const caller = async (): Promise<Caller> => {
      if (!shared) {
        const provider = providers ?? (await providerSet(args.providerScript, ctx));
        const routes = provider.routes;
        shared = new Caller({
          provider,
          budget: new Budget(
            capUsd,
            ledgerFor(spendLedger(ctx, args.workItem), provider, profile.value),
          ),
          routes,
          log: ctx.log,
        });
      }
      return shared;
    };
    let propose: ImportOptions["propose"];
    if (!args.noPropose) {
      const call = await caller();
      const description = bible?.value.subjects?.[subject]?.description;
      const spec: AssetSpec = { kind: "sprite-sheet", assetId: args.asset, subject };
      const references = bible ? (await loadBibleInputs(spec, bible.value, bible.dir)).subject : [];
      propose = {
        call,
        references,
        ...(args.hints !== undefined && { hints: args.hints.split(",").map((h) => h.trim()) }),
        ...(description !== undefined && { subjectDescription: description }),
      };
    }
    const { record, importDir, grouping } = await importSheet({
      sheet,
      sheetPath: args.sheet,
      tool: args.tool,
      ...(digitalSourceType !== undefined && { digitalSourceType }),
      assetId: args.asset,
      ...(args.subject !== undefined && { subject: args.subject }),
      profile: profile.value,
      ...(bible && { bible: { version: bible.value.version, palette: bible.value.palette } }),
      importsDir: resolve(args.imports ?? ".assetgrove/imports"),
      slice,
      ...(blobCalls > 0 && { blobs: await caller() }),
      ...(propose !== undefined && { propose }),
      ...(args.maxHalo !== undefined && { matte: { maxHaloFraction: args.maxHalo } }),
      ...(lock && {
        identity: {
          caller: await caller(),
          record: lock.record,
          references: lock.references,
          settings: lock.settings,
          ...(lock.cast && { cast: lock.cast }),
        },
      }),
    });
    return {
      exitCode: 0,
      fields: { importDir, ...record, grouping },
      human: formatImport(record, importDir, grouping),
    };
  },
});
