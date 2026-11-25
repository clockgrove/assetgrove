import { planDelivery } from "../delivery.ts";
import { EXIT } from "../errors.ts";
import { profileContext } from "../inputs.ts";
import { defineCommand } from "./types.ts";

interface DeliverArgs {
  selection: string;
  out: string;
  profile?: string;
  preview?: boolean;
}

export const deliverCommand = defineCommand<DeliverArgs>({
  name: "deliver",
  tool: "deliver",
  summary: "deliver an explicit set of exact library versions through project recipes",
  details:
    "Reads a selection file naming asset versions, recipes and destinations, resolves each version's exact mezzanine bytes from the library media or the local Git LFS store (never fetched), and builds the renditions under <out> with a delivery.json manifest. Missing objects and output collisions are reported before anything is written, exit 2. --preview is the dry run; available through MCP too. Never adds a version or changes the current pick.",
  input: {
    type: "object",
    properties: {
      selection: { type: "string", description: "delivery selection JSON file" },
      out: { type: "string", description: "delivery root directory" },
      profile: { type: "string", description: "target profile supplying style and frame size" },
      preview: {
        type: "boolean",
        description: "dry run: resolve content hashes and destination paths without writes",
      },
    },
    required: ["selection", "out"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "out" },
  async run(args) {
    const result = await planDelivery({
      selection: args.selection,
      out: args.out,
      ...(args.preview !== undefined && { preview: args.preview }),
      ...(await profileContext(args.profile)),
    });
    const fields = {
      preview: result.preview,
      written: result.written,
      out: result.out,
      manifestPath: result.manifestPath,
      manifest: result.manifest,
      items: result.items,
      problems: result.problems,
    };
    const planned = result.manifest.items.flatMap((item) =>
      item.outputs.map(
        (o) => `${result.written ? "wrote" : "planned"} ${o.path} sha256 ${o.sha256}`,
      ),
    );
    if (result.problems.length === 0) {
      return {
        exitCode: 0,
        fields,
        human: [...planned, `manifest ${result.manifestPath}`].join("\n"),
      };
    }
    const where = (p: (typeof result.problems)[number]) => p.file ?? `item ${p.item + 1}`;
    return {
      exitCode: EXIT.invalid_input,
      fields,
      human: [
        ...planned,
        `delivery refused: ${result.problems.length} problem(s), nothing written`,
        ...result.problems.map((p) => `  item ${p.item + 1}: ${p.code}: ${p.message}`),
      ].join("\n"),
      error: {
        code: "invalid_input",
        message: `delivery refused: ${result.problems.length} problem(s): ${result.problems.map((p) => `${where(p)} ${p.code}: ${p.message}`).join("; ")}`,
        problems: result.problems.map((p) => ({
          file: where(p),
          code: p.code,
          problem: p.message,
        })),
      },
    };
  },
});
