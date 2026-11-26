import { resolve } from "node:path";
import { PRESETS } from "../handoff/presets/index.ts";
import { projectDoctor, sortFindings } from "../handoff/doctor.ts";
import { loadProfile } from "../inputs.ts";
import type { DoctorFinding } from "../handoff/presets/index.ts";
import { createProviders } from "../providers/adapter.ts";
import { redact } from "../redact.ts";
import type { Settings } from "../settings.ts";
import type { RunContext } from "./types.ts";
import { defineCommand } from "./types.ts";

interface DoctorArgs {
  profile: string;
  target?: string;
}

export const doctorCommand = defineCommand<DoctorArgs>({
  name: "doctor",
  tool: "doctor",
  summary: "report hygiene problems of the target the profile's hand-off presets know of",
  details: `Asks each hand-off preset of the profile that has a doctor to check the target and lists
what it finds: each finding has the exact path (and line), what is wrong and a safe correction.
Core also checks that Git sends every media type of the library's managed .gitattributes block
(init's) to LFS, .wav and .ogg included, and names the types it does not (lfs-rules-outdated).
Each configured provider whose adapter reads its account's plan (ElevenLabs' tier) is read, and a
plan it refuses, or a reading that fails, is a provider-account finding.
Read-only: it never writes the target, the settings or Git, and reads nothing in .git or the
settings and state directories. A report is not a failure: exit 0 with or without findings. A preset
whose doctor fails is listed as unknown and does not stop the others. A provider-account finding's
path is the settings file as given, not a target path. No model call, no spend: the account read is
the vendor's free subscription endpoint.`,
  input: {
    type: "object",
    properties: {
      profile: {
        type: "string",
        description: "the target profile",
        placeholder: "<profile.json>",
      },
      target: {
        type: "string",
        description: "the target directory (default: the current directory)",
        placeholder: "<target directory>",
      },
    },
    required: ["profile"],
    additionalProperties: false,
  },
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args, ctx) {
    const profile = (await loadProfile(resolve(args.profile))).value;
    const report = await projectDoctor({
      profile,
      targetDir: resolve(args.target ?? "."),
      registry: ctx.extensions ?? { presets: PRESETS },
      stateDir: ctx.settings.stateDir,
      configDir: ctx.settings.configDir,
    });
    report.findings.push(...(await accountFindings(ctx)));
    sortFindings(report.findings);
    const blocks = report.findings.map(
      (f) =>
        `${f.path}${f.line !== undefined ? `:${f.line}` : ""}  ${f.code}\n  problem: ${f.problem}\n  correction: ${f.correction}`,
    );
    const lines = report.errors.map((e) => `${e.preset}: doctor unknown: ${e.error}`);
    const human = [...blocks, ...lines].join("\n") || "no findings";
    return { exitCode: 0, fields: { findings: report.findings, errors: report.errors }, human };
  },
});

type CoreFinding = DoctorFinding & { presets: string[] };

/**
 * A finding for each configured provider whose account check (`GenerationProvider.checkAccount`)
 * refuses its plan or cannot read it; spends nothing. The path is the settings file.
 */
async function accountFindings(ctx: RunContext): Promise<CoreFinding[]> {
  // A context built without providers (a preset's own doctor run) has no account to read.
  const providers = ctx.settings.providers as Settings["providers"] | undefined;
  if (providers === undefined) return [];
  const configured = createProviders(ctx.settings, {
    ...(ctx.env && { env: ctx.env }),
    ...(ctx.extensions && { adapters: ctx.extensions.adapters }),
  });
  const path = ctx.settings.path ?? "settings";
  const findings: CoreFinding[] = [];
  for (const { id, provider } of configured) {
    if (provider.checkAccount === undefined) continue;
    try {
      const reading = await provider.checkAccount();
      if (reading.refused !== undefined)
        findings.push({
          code: "provider-account",
          presets: ["core"],
          path,
          problem: `provider "${id}" is on the ${reading.plan} plan (${reading.source}), which Assetgrove refuses: ${reading.refused}`,
          correction: `move the account of providers.${id} to a plan it allows, or remove providers.${id} from the settings`,
        });
    } catch (error) {
      findings.push({
        code: "provider-account",
        presets: ["core"],
        path,
        problem: `provider "${id}"'s account plan cannot be read: ${redact(error instanceof Error ? error.message : String(error))}`,
        correction: `check that providers.${id}'s key is set and valid, then run doctor again`,
      });
    }
  }
  return findings;
}
