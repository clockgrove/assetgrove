import { isAbsolute, relative, resolve, sep } from "node:path";
import { Budget, runCap } from "../budget.ts";
import { Caller } from "../calls.ts";
import { InputError } from "../errors.ts";
import { declarationOption, readJson, loadProfile } from "../inputs.ts";
import { runMaterials } from "../material/pipeline.ts";
import type { MaterialDerivation } from "../material/pipeline.ts";
import { resolveMaterialProfile } from "../material/profile.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { ledgerFor } from "../spend.ts";
import type { AssetSpec } from "../types.ts";
import { dryRunOutcome, refusal, usd } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";
import {
  DRY_RUN_PROPERTY,
  ROUND_PROPERTY,
  RUNS_PROPERTY,
  buildWorkPlan,
  jobsOf,
  paidBy,
} from "../runs/plan.ts";

interface MaterialsArgs {
  albedo: string;
  spec: string;
  profile: string;
  derivation: string;
  out: string;
  cap?: number;
  workItem?: string;
  digitalSourceType?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
  runs?: string;
}

/**
 * The files the profile's compression and preview commands name, as `profile/<arg>`: a changed
 * compressor or renderer changes the request digest, so it is a new run, not a reused one.
 */
function commandReads(
  config: ReturnType<typeof resolveMaterialProfile>,
  profileDir: string,
): Record<string, string> {
  const argv = [config.compression?.command ?? [], config.preview?.command ?? []].flat();
  const reads: Record<string, string> = {};
  for (const arg of argv) {
    if (arg === "" || arg.includes("{{")) continue;
    const rel = relative(profileDir, resolve(profileDir, arg));
    // Only files beside the profile: an interpreter elsewhere (node itself) is not hashed.
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    reads[`profile/${rel.split(sep).join("/")}`] = resolve(profileDir, arg);
  }
  return reads;
}

/** The plan step: the inputs, the channels' model calls and the QA call, with no call made. */
async function prepare(args: MaterialsArgs, ctx: RunContext) {
  const spec = await readJson<AssetSpec>(args.spec);
  const profile = await loadProfile(args.profile);
  const derivation = await readJson<MaterialDerivation>(args.derivation);
  const provider = await providerSet(args.providerScript, ctx);
  const routes = provider.routes;
  const config = resolveMaterialProfile(profile.value.style?.materials);
  const capUsd = runCap(args.cap, ctx.settings);
  new Budget(capUsd);
  const needed = new Set(config.channels);
  if (needed.has("normal") && derivation.value.maps?.normal?.method === "height-derived-normal")
    needed.add("height");
  const operations = [...needed].flatMap((channel) => {
    const input = derivation.value.maps?.[channel];
    if (!input?.version?.trim())
      throw new InputError(`missing declared method/version for ${channel}`);
    return input.method === "model-assisted-painting" ? [`material-${channel}`] : [];
  });
  operations.push("material-qa");
  const perCall = operations.map((operation) => {
    const route = routes[operation];
    if (!route || !Number.isFinite(route.estimatedCostUsd) || route.estimatedCostUsd < 0)
      throw new InputError(`missing or invalid route for ${operation}`);
    return { operation, model: route.model, estimatedCostUsd: route.estimatedCostUsd };
  });
  const jobs = jobsOf(perCall, routes);
  const work = await buildWorkPlan(materialsCommand, args, {
    promptAllow: ctx.settings.promptPolicy.allow,
    inputs: ["albedo", "spec", "profile", "derivation"],
    reads: commandReads(config, profile.dir),
    jobs,
    capUsd,
    paid: paidBy(provider, jobs),
    candidates: 1,
  });
  return { spec, profile, derivation, provider, routes, config, capUsd, perCall, work };
}

export const materialsCommand = defineCommand<MaterialsArgs>({
  name: "materials",
  tool: "materials",
  summary: "derive and check material maps, native renditions and target lit previews",
  details: `Derives the channels requested by style.materials, checks alignment and temporal stability,
writes native-resolution renditions, runs target compression and dusk-rain/night previews,
and judges the flat and lit images with vision QA. Rejected materials exit 5 and remain
unapproved. Model calls reserve against --cap. See docs/materials.md.`,
  input: {
    type: "object",
    properties: {
      albedo: {
        type: "string",
        description: "the painted albedo image",
        placeholder: "<painted.png>",
      },
      spec: { type: "string", description: "the asset spec", placeholder: "<spec.json>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      derivation: {
        type: "string",
        description: "the declared method and version of every channel",
        placeholder: "<derivation.json>",
      },
      out: {
        type: "string",
        description: "where maps, renditions and the report are written",
        placeholder: "<directory>",
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
      digitalSourceType: {
        type: "string",
        description: "the IPTC digital source type to declare",
        placeholder: "<IPTC code or URI>",
      },
      providerScript: {
        type: "string",
        description: "answer every model call from this module instead of a provider",
        placeholder: "<module>",
      },
      round: ROUND_PROPERTY,
      runs: RUNS_PROPERTY,
      dryRun: DRY_RUN_PROPERTY,
    },
    required: ["albedo", "spec", "profile", "derivation", "out"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "out" },
  confirm: "spend",
  plan: async (args, ctx) => (await prepare(args, ctx)).work,
  async run(args, ctx) {
    const { spec, profile, derivation, provider, routes, config, capUsd, perCall, work } =
      await prepare(args, ctx);
    const ledger = spendLedger(ctx, args.workItem).forProfile(profile.value);
    if (args.dryRun) {
      const estimateUsd = work.forecastUsd;
      const plan = {
        kind: "materials",
        channels: config.channels,
        scales: config.scales,
        calls: perCall.length,
        perCall,
        estimateUsd,
        capUsd,
        withinCap: estimateUsd <= capUsd + 1e-9,
      };
      const human = `dry run: materials, ${plan.calls} planned call(s), nothing spent\nforecast ${usd(estimateUsd)} against a $${capUsd.toFixed(2)} cap`;
      return dryRunOutcome(work, human, ledger, plan);
    }
    const call = new Caller({
      provider,
      budget: new Budget(capUsd, ledgerFor(ledger, provider)),
      routes,
    });
    const declared = declarationOption(args.digitalSourceType);
    const result = await runMaterials({
      albedoPath: resolve(args.albedo),
      ...(declared && { digitalSourceType: declared }),
      spec: spec.value,
      profile: profile.value,
      derivation: derivation.value,
      baseDir: derivation.dir,
      profileDir: profile.dir,
      outDir: resolve(args.out),
      call,
      gate: { settings: ctx.settings, ...(ctx.prompt && { prompt: ctx.prompt }) },
    });
    const fields = { ...result };
    const human = `materials ${result.passed ? "passed QA" : "failed QA"}: ${result.reportPath}`;
    if (!result.passed)
      return refusal("qa_found_nothing", "material maps failed QA", fields, human);
    return { exitCode: 0, fields, human };
  },
});
