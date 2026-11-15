import { InputError } from "../errors.ts";
import { generationTool } from "../mcp.ts";
import { defineCommand } from "./types.ts";

interface BibleArgs {
  action?: string;
  bible?: string;
  preset?: string;
}

export const bibleCommand = defineCommand<BibleArgs>({
  name: "bible",
  tool: "bible",
  summary: "describe a world's art constitution or switch it to a preset",
  details: `Actions (the bible tool takes the action as its action argument):
  describe  needs --bible
  preset    needs --bible and --preset

Presets: cozy-storybook, flat-cartoon-kids, dark-gritty-isometric.
init writes the bible, its presets, the Agent Skill and the prompt template.`,
  input: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "describe or preset",
        placeholder: "<describe|preset>",
      },
      bible: { type: "string", description: "the art bible", placeholder: "<BIBLE.md>" },
      preset: { type: "string", description: "the preset to apply", placeholder: "<preset>" },
    },
    additionalProperties: false,
  },
  positionals: [{ name: "action" }],
  effect: { readOnly: false, spends: "never", writes: "target" },
  async run(args) {
    if (!args.action || !["describe", "preset"].includes(args.action))
      throw new InputError("bible requires describe or preset; init sets up a project");
    const result = await generationTool(`bible_${args.action}`, {
      bible: args.bible,
      preset: args.preset,
    });
    return { exitCode: 0, fields: { ...result }, human: JSON.stringify(result, null, 2) };
  },
});
