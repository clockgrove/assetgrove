import { createHash } from "node:crypto";
import { bindProvenance, callsSha256 } from "../provenance-binding.ts";
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Budget, runCap } from "../budget.ts";
import { Caller } from "../calls.ts";
import { compareRasters, comparisonFields, writeCompareSheet } from "../compare.ts";
import type { CompareRow } from "../compare.ts";
import { writeContactRows } from "../contact.ts";
import { InputError } from "../errors.ts";
import { decodeImage } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType } from "../metadata.ts";
import type { DigitalSourceType } from "../metadata.ts";
import { readRun } from "../loop.ts";
import type { RunRecord, StagedCandidate } from "../loop.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { loadReference, sha256 } from "../request.ts";
import { ledgerFor } from "../spend.ts";
import type { Provenance } from "../types.ts";
import {
  DRY_RUN_PROPERTY,
  ROUND_PROPERTY,
  RUNS_PROPERTY,
  buildWorkPlan,
  jobOf,
  paidBy,
} from "../runs/plan.ts";
import { dryRunOutcome, formatWork, refusal } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";

export const DEFAULT_VARIATIONS = 4;

interface VaryArgs {
  run: string;
  candidate: string;
  count?: number;
  cap?: number;
  runs?: string;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
}

/** The file extension a media type names: its subtype, so no format list lives here. */
function extensionOf(mediaType: string): string {
  const subtype = (mediaType.split("/")[1] ?? "").split(/[+;]/)[0] ?? "";
  const clean = subtype.toLowerCase().replace(/[^a-z0-9]/g, "");
  return clean === "jpeg" ? "jpg" : clean || "bin";
}

/** The source run's record and the candidate to vary; refused unless it is an image. */
async function source(args: VaryArgs): Promise<{ run: RunRecord; candidate: StagedCandidate }> {
  const run = await readRun(resolve(args.run)).catch((error: unknown) => {
    throw new InputError(`cannot read the run ${args.run}: it needs a run.json from stage`, {
      cause: error,
    });
  });
  const candidate = (run.candidates ?? []).find((c) => c.id === args.candidate);
  if (candidate === undefined)
    throw new InputError(`run ${args.run} has no candidate "${args.candidate}"`);
  if (!candidate.mediaType.startsWith("image/"))
    throw new InputError(`candidate ${candidate.id} is ${candidate.mediaType}; vary edits images`);
  if (run.spec.kind !== "still")
    throw new InputError(
      `candidate ${candidate.id} is a ${run.spec.kind} candidate; vary edits still candidates`,
    );
  return { run, candidate };
}

/** The plan step: the source candidate, the edit calls and the WorkPlan, with no call made. */
async function prepare(args: VaryArgs, ctx: RunContext) {
  const count = args.count ?? DEFAULT_VARIATIONS;
  if (!Number.isInteger(count) || count < 1) throw new InputError(`invalid count: ${count}`);
  const { run, candidate } = await source(args);
  const providers = await providerSet(args.providerScript, ctx);
  const route = providers.routes["edit"];
  if (!route) throw new InputError('no model route for operation "edit"');
  const capUsd = runCap(args.cap, ctx.settings);
  const jobs = [jobOf("edit", route, count)];
  const file = join(resolve(args.run), candidate.file);
  const work = await buildWorkPlan(varyCommand, args, {
    promptAllow: ctx.settings.promptPolicy.allow,
    inputs: [],
    reads: { candidate: file },
    jobs,
    capUsd,
    paid: paidBy(providers, jobs),
    providers,
    candidates: count,
  });
  return { count, run, candidate, file, providers, capUsd, jobs, work };
}

export const varyCommand = defineCommand<VaryArgs>({
  name: "vary",
  tool: "vary",
  summary: "make variations of one staged candidate through the edit route",
  details: `Makes --count (default ${DEFAULT_VARIATIONS}) variations of one still candidate of a staged run, each one
reference-guided edit of the candidate with a fresh seed, within the cost cap in USD. Writes
v<n>.<ext> and its provenance, contact.png and compare.png (each variation against the candidate,
numbers only) to the run directory, and reports each variation's outsideChange. The request
asks for spend once; the same request again returns the finished run (reused true) with no
provider call. Variations are not QA-filtered and are never marked approved.
--dry-run prints the planned calls and the forecast, and needs no key.`,
  input: {
    type: "object",
    properties: {
      run: { type: "string", description: "the staged run directory", placeholder: "<run>" },
      candidate: { type: "string", description: "the candidate id to vary", placeholder: "<id>" },
      count: {
        type: "integer",
        minimum: 1,
        description: "how many variations to make",
        default: DEFAULT_VARIATIONS,
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
    required: ["run", "candidate"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "always", writes: "runs" },
  confirm: "spend",
  plan: async (args, ctx) => (await prepare(args, ctx)).work,
  async run(args, ctx) {
    const { count, run, candidate, file, providers, capUsd, work } = await prepare(args, ctx);
    const ledger = spendLedger(ctx, args.workItem);
    if (args.dryRun) return dryRunOutcome(work, formatWork("vary", work), ledger);
    const dir = ctx.run?.dir ?? work.runDir;
    const reference = await loadReference(file, `candidate ${candidate.id}`, ".");
    const before = decodeImage(reference.bytes);
    const budget = new Budget(capUsd, ledgerFor(ledger, providers, run.profile));
    const prompt = [
      "Reference image 1 is the approved candidate.",
      "Draw a variation of it: keep the subject, identity, design, palette, style, framing and scale; change only incidental detail.",
      "No text.",
    ].join("\n");
    const sourceType = (candidate.provenance.digitalSourceType ??
      DIGITAL_SOURCE_TYPES.generated) as DigitalSourceType;
    const rows: CompareRow[] = [];
    const variations: Array<Record<string, unknown>> = [];
    const shown: Array<{ number: number; image: Raster }> = [];
    const errors: string[] = [];
    for (let index = 0; index < count; index++) {
      const caller = new Caller({
        provider: providers,
        budget,
        routes: providers.routes,
        index,
        log: ctx.log,
      });
      const seed = Number.parseInt(
        createHash("sha256")
          .update(`${basename(dir)}:${candidate.id}:${index}`)
          .digest("hex")
          .slice(0, 8),
        16,
      );
      try {
        const image = await caller.image("edit", prompt, [reference], seed);
        const decoded = decodeImage(image.bytes);
        const extension = extensionOf(image.mediaType);
        const name = `v${index + 1}`;
        const calls = caller.records;
        // The mark carries the sha256 of the record's calls (src/provenance-binding.ts).
        const bytes = embedDigitalSourceType(image.bytes, image.mediaType, sourceType, {
          callsSha256: callsSha256({ calls }),
        });
        await writeFile(join(dir, `${name}.${extension}`), bytes);
        const provenance: Provenance = {
          ...candidate.provenance,
          route: calls.map((c) => c.route).join(" + "),
          models: [...new Set(calls.map((c) => c.model))],
          prompt,
          parameters: {
            variationOf: {
              run: basename(resolve(args.run)),
              candidate: candidate.id,
              sha256: candidate.sha256,
            },
          },
          seed,
          requestIds: calls.map((c) => c.requestId),
          referenceHashes: [reference.sha256],
          startedAt: calls[0]?.startedAt ?? "",
          finishedAt: calls[calls.length - 1]?.finishedAt ?? "",
          costUsd: calls.reduce((sum, c) => sum + c.costUsd, 0),
          calls,
          digitalSourceType: sourceType,
        };
        delete provenance.steps;
        await writeFile(
          join(dir, `${name}.provenance.json`),
          `${JSON.stringify(bindProvenance(provenance, bytes), null, 2)}\n`,
        );
        const comparison = await compareRasters(before, decoded);
        rows.push({ number: index + 1, comparison });
        shown.push({ number: index + 1, image: decoded });
        variations.push({
          id: name,
          file: `${name}.${extension}`,
          sha256: sha256(bytes),
          ...comparisonFields(comparison),
        });
      } catch (error) {
        errors.push(
          `variation ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (budget.spentUsd >= capUsd) break;
      }
    }
    const spentUsd = budget.spentUsd;
    const contact = await writeContactRows(
      dir,
      shown.map(({ number, image }) => ({ number, images: [image] })),
      [before],
    );
    const compareSheet = rows.length > 0 ? await writeCompareSheet(dir, rows) : undefined;
    const fields = {
      runDir: dir,
      source: { run: resolve(args.run), candidate: candidate.id },
      spentUsd,
      variations,
      errors,
      ...(contact && { contactSheet: contact.file }),
      ...(compareSheet && { compareSheet: "compare.png" }),
    };
    const human = [
      `${variations.length} of ${count} variation(s) of ${candidate.id}, $${spentUsd.toFixed(4)} spent`,
      ...variations.map((v) => `  ${v["file"]}  outsideChange ${v["outsideChange"]}`),
      ...errors,
    ].join("\n");
    if (variations.length === 0)
      return refusal("provider_error", errors[0] ?? "no variation was made", fields, human);
    return { exitCode: 0, fields, human };
  },
});
