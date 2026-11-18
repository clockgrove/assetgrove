/**
 * `ls` and `cat` (tools `ls`, `cat`; design section 2): walk the asset tree through the MCP
 * server's own resolver, so a harness without resource support browses through tools. `cat`
 * returns the contents `resources/read` returns; `ls` returns a folder's JSON document. Free and
 * read-only: no provider call, no ledger entry, no write but `cat --out` and the thumbnail cache.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { InputError } from "../errors.ts";
import { openProject, projectDir } from "../tree/project.ts";
import { readTree } from "../tree/read.ts";
import type { Child, ReadResult } from "../tree/read.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";

const ADDRESS = {
  type: "string",
  description: "the asset:// address to read, for example asset://my-game/",
  placeholder: "<address>",
} as const;

const TARGET = {
  type: "string",
  description:
    "the project whose library to read; the working directory's Git top level by default",
  placeholder: "<dir>",
} as const;

interface BrowseArgs {
  address?: string;
  target?: string;
  out?: string;
}

/** Reads `address` in the project `target` names, as the MCP server reads it. */
export async function browse(args: BrowseArgs, ctx: RunContext): Promise<ReadResult> {
  if (args.address === undefined) throw new InputError("missing <address>");
  const project = await openProject(projectDir(args.target), ctx.settings.stateDir);
  return readTree(project, args.address, ctx.extensions);
}

function describe(result: ReadResult): string {
  return result.contents
    .map((c) =>
      "text" in c
        ? c.text
        : `${c.uri}: ${c.mimeType}, ${c.blob.length} base64 bytes (cat --out <file> writes it)`,
    )
    .join("\n\n");
}

export const lsCommand = defineCommand<BrowseArgs>({
  name: "ls",
  tool: "ls",
  summary: "list a folder of the asset:// tree",
  details: `Reads a folder address of the library's asset:// tree (the game root, by-kind/<kind>/,
by-subject/<subject>/, by-tag/<tag>/, stale/, runs/, runs/<run>/, <asset>/ or <asset>/versions/)
and returns its JSON document: {address, kind: "folder", children: [{address, name, kind, state?}],
next?}, at most 200 children per read; read the next address for more. The same document the MCP
server's resources/read returns. Spends nothing and writes nothing.`,
  input: {
    type: "object",
    properties: { address: ADDRESS, target: TARGET },
    required: ["address"],
    additionalProperties: false,
  },
  positionals: [{ name: "address" }],
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args, ctx) {
    const result = await browse(args, ctx);
    if (!result.folder || result.document === undefined) {
      throw new InputError(`${result.address} is not a folder; read it with cat`);
    }
    const children = (result.document["children"] ?? []) as Child[];
    const next = result.document["next"];
    const human = [
      ...children.map((c) => `${c.address}${c.state ? `  ${c.state}` : ""}`),
      ...(typeof next === "string" ? [`next: ${next}`] : []),
    ].join("\n");
    return { exitCode: 0, fields: result.document, human: human || `${result.address} is empty` };
  },
});

export const catCommand = defineCommand<BrowseArgs>({
  name: "cat",
  tool: "cat",
  summary: "read any address of the asset:// tree",
  details: `Reads an address of the library's asset:// tree and returns {address, contents}: the
contents the MCP server's resources/read returns, each {uri, mimeType, text} or {uri, mimeType,
blob}. A folder gives its JSON document (and the root its index.md); <asset>/card and log give
Markdown, provenance and review JSON, image a PNG thumbnail of at most 512 px, image/full the file,
versions/<n> the version record with its image while its bytes are local. No read exceeds 64 KB.
--out (CLI only; the cat tool is read-only and takes no out) writes the file a file address names
(the whole file, for image/full) instead.`,
  input: {
    type: "object",
    properties: {
      address: ADDRESS,
      target: TARGET,
      // CLI only: the cat tool is read-only, so it never writes a file on the server's machine.
      out: {
        type: "string",
        description: "write the file's bytes here",
        placeholder: "<file>",
        cliOnly: true,
      },
    },
    required: ["address"],
    additionalProperties: false,
  },
  positionals: [{ name: "address" }],
  effect: { readOnly: true, spends: "never", writes: "out" },
  async run(args, ctx) {
    const result = await browse(args, ctx);
    const fields: Record<string, unknown> = { address: result.address, contents: result.contents };
    if (args.out !== undefined) {
      const bytes =
        result.bytes ??
        (result.contents.length === 1 && "text" in result.contents[0]!
          ? new TextEncoder().encode(result.contents[0].text)
          : undefined);
      if (bytes === undefined)
        throw new InputError(`${result.address} has no single file to write`);
      const out = resolve(args.out);
      await writeFile(out, bytes);
      return { exitCode: 0, fields: { ...fields, out }, human: `wrote ${out}` };
    }
    return { exitCode: 0, fields, human: describe(result) };
  },
});
