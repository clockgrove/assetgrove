import { planDelivery } from "../delivery.ts";
import { EXIT } from "../errors.ts";
import { loadProfile, profileContext } from "../inputs.ts";
import { defineCommand } from "./types.ts";

interface DeliverArgs {
  selection: string;
  out: string;
  profile?: string;
  preview?: boolean;
  draft?: boolean;
}

export const deliverCommand = defineCommand<DeliverArgs>({
  name: "deliver",
  tool: "deliver",
  summary: "deliver an explicit set of exact library versions through project recipes",
  details:
    "Reads a selection file naming asset versions, recipes and destinations, resolves each version's exact mezzanine bytes from the library media or the local Git LFS store (never fetched), and builds the renditions under <out> with a delivery.json manifest. Missing objects and output collisions are reported before anything is written, exit 2. A release delivery also refuses a selected placeholder version and, when the --profile's release policy asks, an unapproved version or a licence outside its window, naming the asset, version and evidence. --preview is the dry run and --draft writes a draft delivery: both report the same release findings without refusing on them, and neither is a release. Available through MCP too. Never adds a version, approves one or changes the current pick.",
  input: {
    type: "object",
    properties: {
      selection: { type: "string", description: "delivery selection JSON file" },
      out: { type: "string", description: "delivery root directory" },
      profile: {
        type: "string",
        description: "target profile supplying style, frame size and the release policy",
      },
      preview: {
        type: "boolean",
        description: "dry run: resolve content hashes and destination paths without writes",
      },
      draft: {
        type: "boolean",
        description: "write a draft delivery: report release findings without refusing on them",
      },
    },
    required: ["selection", "out"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "out" },
  async run(args) {
    const policy =
      args.profile === undefined ? undefined : (await loadProfile(args.profile)).value.release;
    const result = await planDelivery({
      selection: args.selection,
      out: args.out,
      ...(args.preview !== undefined && { preview: args.preview }),
      ...(args.draft !== undefined && { draft: args.draft }),
      ...(policy !== undefined && { policy }),
      ...(await profileContext(args.profile)),
    });
    const fields = {
      preview: result.preview,
      draft: result.draft,
      release: result.release,
      policy: result.policy,
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
    const failed = result.policy.filter((f) => f.status === "failed");
    const findings = failed.map((f) => `  item ${f.item + 1}: ${f.check}: ${f.message}`);
    if (result.problems.length === 0) {
      const mode = result.preview ? "preview" : "draft delivery";
      const verdict = result.release
        ? [`release delivery: every release check passed`]
        : failed.length > 0
          ? [
              `${mode}, not a release: ${failed.length} release check(s) failed, which a release delivery refuses`,
              ...findings,
            ]
          : [`${mode}, not a release: every release check passed`];
      return {
        exitCode: 0,
        fields,
        human: [...planned, `manifest ${result.manifestPath}`, ...verdict].join("\n"),
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
        ...((result.preview || result.draft) && failed.length > 0
          ? [
              `${failed.length} release check(s) failed, which a release delivery refuses:`,
              ...findings,
            ]
          : []),
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
