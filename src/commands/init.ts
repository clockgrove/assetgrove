import { HARNESSES } from "../keys.ts";
import { InitConflictError, InitRefusedError, initProject, PROFILE_PRESETS } from "../init.ts";
import { BIBLE_PRESETS } from "../bible.ts";
import { refusal } from "./result.ts";
import { defineCommand } from "./types.ts";

interface InitArgs {
  directory: string;
  profilePreset: string;
  stylePreset: string;
  world: string;
  harness?: string;
  providers?: string;
  overwrite?: boolean;
}

export const initCommand = defineCommand<InitArgs>({
  name: "init",
  tool: "init",
  summary: "set up a project and list the steps a person takes next",
  details: `Writes into --directory the target profile (.assetgrove/profile.json), the style bible
(.assetgrove/art-direction/BIBLE.md, referenceLicense NOASSERTION) and its presets, the prompt
template (.assetgrove/prompts/default.md), the art-direction skill in .claude/skills and
.agents/skills, and .gitignore rules for the output folders. Never interactive and idempotent: an
identical file is left alone, and a differing one exits 2 invalid_input, writing nothing, unless
--overwrite. Never writes a key, the settings file or a project-scope harness config.

Returns steps [{id, status, detail}]: guard (refused exits 2 key_tracked before anything is
written), files, the key recipe's steps for --harness (needs-person), settings (needs-person: the
agent calls settings_change), spend-check (to-run) and two notices; bibleQuestions to draft the
bible with the developer; adapters, each adapter of a listed extension pack with its hosts and key
variable; providers, each route's data flow; and files [{path, role, status}].

Profile presets: ${Object.keys(PROFILE_PRESETS).join(", ")}.
Style presets: ${Object.keys(BIBLE_PRESETS).join(", ")}.
Harnesses: ${HARNESSES.join(", ")} (default claude-code).`,
  input: {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description: "the target repository to set up",
        placeholder: "<target>",
      },
      profilePreset: {
        type: "string",
        description: `the target profile preset: ${Object.keys(PROFILE_PRESETS).join(", ")}`,
        placeholder: "<id>",
      },
      stylePreset: {
        type: "string",
        description: `the style bible preset: ${Object.keys(BIBLE_PRESETS).join(", ")}`,
        placeholder: "<id>",
      },
      world: { type: "string", description: "the world's name", placeholder: "<name>" },
      harness: {
        type: "string",
        description: `the harness whose key recipe the steps give: ${HARNESSES.join(", ")}`,
        default: "claude-code",
      },
      providers: {
        type: "string",
        description:
          "comma-separated adapter ids (core's or a listed pack's) whose roles the settings step suggests",
        placeholder: "<adapterId,...>",
      },
      overwrite: {
        type: "boolean",
        description: "replace project files that differ from what init writes",
      },
    },
    required: ["directory", "profilePreset", "stylePreset", "world"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "target" },
  async run(args, ctx) {
    try {
      const result = await initProject(
        {
          directory: args.directory,
          profilePreset: args.profilePreset,
          stylePreset: args.stylePreset,
          world: args.world,
          ...(args.harness !== undefined && { harness: args.harness }),
          ...(args.providers !== undefined && {
            providers: args.providers
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean),
          }),
          ...(args.overwrite === true && { overwrite: true }),
        },
        {
          settings: ctx.settings,
          ...(ctx.env && { env: ctx.env }),
          ...(ctx.extensions && { extensions: ctx.extensions }),
        },
      );
      const human = [
        ...result.steps.map((step) => `[${step.status}] ${step.id}: ${step.detail}`),
        "",
        "Bible questions:",
        ...result.bibleQuestions.map((q) => `- ${q.question}`),
        "",
        "Data flows:",
        ...result.providers.map(
          (flow) =>
            `- ${flow.operation}: ${flow.providerId} (${flow.host ?? "no host"}${flow.upstream ? `, upstream ${flow.upstream}` : ""})`,
        ),
        ...result.adapters.map(
          (a) =>
            `- pack adapter ${a.adapter} (${a.package}): ${
              a.hosts.length > 0 ? `hosts ${a.hosts.join(", ")}` : "no fixed host"
            }${a.endpointFromSettings ? " or the settings baseURL" : ""}; ${a.keyEnv ? `key ${a.keyEnv}` : "no key"}`,
        ),
      ].join("\n");
      return { exitCode: 0, fields: { ...result }, human };
    } catch (error) {
      if (error instanceof InitRefusedError)
        return refusal(
          "key_tracked",
          error.message,
          { steps: error.steps, files: [], trackedFiles: error.files },
          error.message,
        );
      if (error instanceof InitConflictError)
        return refusal(
          "invalid_input",
          error.message,
          { files: [], conflicts: error.conflicts },
          error.message,
        );
      throw error;
    }
  },
});
