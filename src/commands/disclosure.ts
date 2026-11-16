import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { disclose, disclosureMarkdown } from "../disclosure.ts";
import { InputError } from "../errors.ts";
import { defineCommand } from "./types.ts";

interface DisclosureArgs {
  root?: string;
  out?: string;
}

export const disclosureCommand = defineCommand<DisclosureArgs>({
  name: "disclosure",
  tool: "disclosure",
  summary: "summarise the library's AI use for Steam's AI content survey and itch.io's AI tags",
  details: `Reads the cards under <root> (the current directory by default) and the provenance each names.
Reports assets by kind and source type, models, providers, and provider terms with their dates,
then text for Steam's AI content survey and itch.io's AI tags. No prompt text is read or shown.
--out <file> also writes the summary there as Markdown. The marks in the files and this summary
help users and stores; they make no claim that the game complies with any law.
Spends nothing; nothing is written without --out.`,
  input: {
    type: "object",
    properties: {
      root: { type: "string", description: "the library root to read", default: "." },
      out: {
        type: "string",
        description: "write the summary here as Markdown",
        placeholder: "<file>",
      },
    },
    additionalProperties: false,
  },
  positionals: [{ name: "root" }],
  effect: { readOnly: false, spends: "never", writes: "out" },
  async run(args) {
    const root = resolve(args.root ?? ".");
    const summary = await disclose(root);
    if (args.out !== undefined) {
      if (args.out === "") throw new InputError("--out needs a file");
      if (isAbsolute(args.out) || args.out.split(/[\\/]/).includes(".."))
        throw new InputError("--out must be a path inside the current directory");
      const file = resolve(args.out);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, disclosureMarkdown(summary));
    }
    const human = [
      `${summary.assets} assets`,
      ...summary.bySourceType.map((s) => `  ${s.name}: ${s.assets}`),
      `models: ${summary.models.map((m) => m.name).join(", ") || "none"}`,
      `providers: ${summary.providers.map((m) => m.name).join(", ") || "none"}`,
      ...summary.terms.map((t) => `terms: ${t.terms}`),
      ...(summary.contentCredentials.signed > 0 || summary.contentCredentials.note
        ? [
            `content credentials: ${summary.contentCredentials.signed} signed` +
              (summary.contentCredentials.note ? `. ${summary.contentCredentials.note}` : ""),
          ]
        : []),
      "",
      `Steam: ${summary.steam}`,
      `itch.io: ${summary.itch.text}`,
    ].join("\n");
    return {
      exitCode: 0,
      fields: { root, ...summary, ...(args.out !== undefined && { out: resolve(args.out) }) },
      human,
    };
  },
});
