import { declarationOption, profileContext } from "../inputs.ts";
import { buildRendition } from "../transform/rendition.ts";
import { defineCommand } from "./types.ts";

interface RenditionArgs {
  recipes: string;
  recipe: string;
  source: string;
  sourceSha256: string;
  sourceProvenance?: string;
  out: string;
  profile?: string;
  digitalSourceType?: string;
  preview?: boolean;
}

export const renditionCommand = defineCommand<RenditionArgs>({
  name: "rendition",
  tool: "rendition",
  summary: "build a named project recipe from an exact source image version",
  details:
    "Selects <recipes>/<recipe>.json and verifies the full source SHA-256. Writes deterministic raster outputs and provenance under <out>/<digest>/. --preview plans exact paths and byte hashes without writes; available through MCP too.",
  input: {
    type: "object",
    properties: {
      recipes: { type: "string", description: "project-owned recipe directory" },
      recipe: { type: "string", description: "recipe name (safe file stem, without .json)" },
      source: { type: "string", description: "selected mezzanine image path" },
      sourceSha256: { type: "string", description: "full SHA-256 of the selected source bytes" },
      sourceProvenance: {
        type: "string",
        description: "source provenance (defaults to <source>.provenance.json when present)",
      },
      out: { type: "string", description: "rendition output root directory" },
      profile: { type: "string", description: "target profile supplying style and frame size" },
      digitalSourceType: {
        type: "string",
        description: "IPTC source type declaration for an undeclared source",
      },
      preview: {
        type: "boolean",
        description: "dry run: show exact output paths and byte hashes without writes",
      },
    },
    required: ["recipes", "recipe", "source", "sourceSha256", "out"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "out" },
  async run(args) {
    const digitalSourceType = declarationOption(args.digitalSourceType);
    const result = await buildRendition({
      ...args,
      digitalSourceType,
      ...(await profileContext(args.profile)),
    });
    return {
      exitCode: 0,
      fields: {
        ...result.record,
        provenancePath: result.provenancePath,
        digest: result.digest,
        preview: result.preview,
      },
      human: [
        ...result.record.outputs.map(
          (o) => `${result.preview ? "planned" : "wrote"} ${o.path} sha256 ${o.sha256}`,
        ),
        `provenance ${result.provenancePath}`,
      ].join("\n"),
    };
  },
});
