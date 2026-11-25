import { resolve } from "node:path";
import { PRESETS } from "../handoff/presets/index.ts";
import { projectDoctor } from "../handoff/doctor.ts";
import { loadProfile } from "../inputs.ts";
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
Read-only: it never writes the target, the settings or Git, and reads nothing in .git or the
settings and state directories. A report is not a failure: exit 0 with or without findings. A preset
whose doctor fails is listed as unknown and does not stop the others. Local: no model call, no spend.`,
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
    const blocks = report.findings.map(
      (f) =>
        `${f.path}${f.line !== undefined ? `:${f.line}` : ""}  ${f.code}\n  problem: ${f.problem}\n  correction: ${f.correction}`,
    );
    const lines = report.errors.map((e) => `${e.preset}: doctor unknown: ${e.error}`);
    const human = [...blocks, ...lines].join("\n") || "no findings";
    return { exitCode: 0, fields: { findings: report.findings, errors: report.errors }, human };
  },
});
