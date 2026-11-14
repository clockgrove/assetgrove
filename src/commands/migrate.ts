import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseDocument } from "yaml";
import { splitFrontMatter } from "../bible.ts";
import { InputError } from "../errors.ts";
import { formatLine, readFormat, type FormatKind } from "../formats.ts";
import { defineCommand } from "./types.ts";

const KINDS = ["target-profile", "style-bible", "style-preset", "recipe"] as const;

interface MigrateArgs {
  file?: string;
  kind: string;
}

type Status = "added" | "migrated" | "current";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const migrateCommand = defineCommand<MigrateArgs>({
  name: "migrate",
  tool: "migrate",
  summary: "add the format line to a shared file, or move an older one forward",
  details: `Adds the format line of --kind to a file that has none and moves a file with an older format
forward to the current one, rewriting it in place. A file already current is left untouched. A file
whose format is newer than this Assetgrove reads, or of another kind, is refused. The file is not
otherwise validated; loading it does that.`,
  input: {
    type: "object",
    properties: {
      file: { type: "string", description: "the file to migrate", placeholder: "<file>" },
      kind: {
        type: "string",
        description: "the kind of file: target-profile, style-bible, style-preset or recipe",
        placeholder: "<kind>",
      },
    },
    required: ["kind"],
    additionalProperties: false,
  },
  positionals: [{ name: "file" }],
  effect: { readOnly: false, spends: "never", writes: "target" },
  async run(args) {
    if (args.file === undefined) throw new InputError("missing the file to migrate");
    if (!(KINDS as readonly string[]).includes(args.kind)) {
      throw new InputError(`unknown --kind "${args.kind}"; expected ${KINDS.join(", ")}`);
    }
    const kind = args.kind as FormatKind;
    const file = resolve(args.file);
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      throw new InputError(`cannot read ${file}`, { cause: error });
    }
    const markdown = extname(file) === ".md" || source.startsWith("---");
    const line = formatLine(kind);
    let status: Status;
    let from: number | null = null;
    let output: string;
    if (markdown) {
      const { front, prose } = splitFrontMatter(source);
      const doc = parseDocument(front);
      if (doc.errors.length > 0) {
        throw new InputError(`${file}: invalid front matter YAML: ${doc.errors[0]!.message}`);
      }
      const value: unknown = doc.toJS();
      if (!isRecord(value)) throw new InputError(`${file}: front matter must be a mapping`);
      if (value["format"] === undefined) {
        status = "added";
        if (doc.contents === null) doc.set("format", line);
        else
          (doc.contents as unknown as { items: unknown[] }).items.unshift(
            doc.createPair("format", line),
          );
      } else {
        const result = readFormat(kind, value, file);
        if (result.migratedFrom === undefined) {
          status = "current";
        } else {
          status = "migrated";
          from = result.migratedFrom;
          for (const key of Object.keys(value)) if (!(key in result.value)) doc.delete(key);
          for (const [key, entry] of Object.entries(result.value)) doc.set(key, entry);
        }
      }
      output = `---\n${doc.toString()}---\n${prose}`;
    } else {
      let value: unknown;
      try {
        value = JSON.parse(source);
      } catch (error) {
        throw new InputError(`${file} is not valid JSON: ${(error as Error).message}`);
      }
      if (!isRecord(value)) throw new InputError(`${file}: expected a JSON object`);
      let next: Record<string, unknown> = value;
      if (value["format"] === undefined) {
        status = "added";
        next = { format: line, ...value };
      } else {
        const result = readFormat(kind, value, file);
        if (result.migratedFrom === undefined) {
          status = "current";
        } else {
          status = "migrated";
          from = result.migratedFrom;
          next = result.value;
        }
      }
      output = `${JSON.stringify(next, null, 2)}\n`;
    }
    if (status !== "current") await writeFile(file, output);
    const human =
      status === "current"
        ? `${file} is already ${line}`
        : `${status === "added" ? "added" : `migrated from ${from} to`} ${line} in ${file}`;
    return { exitCode: 0, fields: { file, kind, status, from, format: line }, human };
  },
});
