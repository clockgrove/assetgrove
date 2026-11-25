import { declarationOption } from "../inputs.ts";
import { CORE_REGISTRY } from "../extensions/registry.ts";
import { stageSource } from "../source/stage.ts";
import { defineCommand } from "./types.ts";

interface StageSourceArgs {
  source: string;
  spec: string;
  profile: string;
  runs?: string;
  digitalSourceType?: string;
}

export const stageSourceCommand = defineCommand<StageSourceArgs>({
  name: "stage-source",
  tool: "stage_source",
  summary: "stage a strip rendered from an editable Aseprite source, with no model call",
  details: `Reads an Aseprite file, composites its layers (normal blend) and stages the frames of the tag
named the spec's animationFamily (every frame when the file has no tags) as one strip candidate,
c1, in a run directory a \`pick\` can take. The canvas must be the profile's frame size.
The candidate's provenance records the source file's path and sha256, the tag and the frames read,
so a pick keeps the lineage; editing the source and staging again is a new run.
An .aseprite file embeds no source type: declare it with --digital-source-type, or it stays
undeclared and pick refuses it. Calls no model and spends nothing.`,
  input: {
    type: "object",
    properties: {
      source: { type: "string", description: "the .aseprite file", placeholder: "<file.aseprite>" },
      spec: { type: "string", description: "the sprite-strip spec", placeholder: "<spec.json>" },
      profile: { type: "string", description: "the target profile", placeholder: "<profile.json>" },
      runs: { type: "string", description: "where runs are staged", default: ".assetgrove/runs" },
      digitalSourceType: {
        type: "string",
        description: "the IPTC digital source type to declare",
        placeholder: "<IPTC code or URI>",
      },
    },
    required: ["source", "spec", "profile"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "runs" },
  async run(args, ctx) {
    const declared = declarationOption(args.digitalSourceType);
    const { run, runDir, candidate, editableSource } = await stageSource({
      source: args.source,
      spec: args.spec,
      profile: args.profile,
      runsDir: args.runs ?? ".assetgrove/runs",
      traits: ctx.extensions ?? CORE_REGISTRY,
      ...(declared !== undefined && { digitalSourceType: declared }),
    });
    return {
      exitCode: 0,
      fields: {
        runDir,
        runId: run.runId,
        candidate: candidate.id,
        sha256: candidate.sha256,
        editableSource,
      },
      human: [
        `staged ${candidate.id} (${editableSource.frames.length} frames from ${editableSource.path}) in ${runDir}`,
        `pick it with: assetgrove pick --run ${runDir} --candidate ${candidate.id} --target <dir>`,
      ].join("\n"),
    };
  },
});
