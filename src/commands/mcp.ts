import { serveMcp } from "../mcp.ts";
import { defineCommand } from "./types.ts";

interface McpArgs {
  target?: string;
  readOnly?: boolean;
  workItem?: string;
  providerScript?: string;
}

export const mcpCommand = defineCommand<McpArgs>({
  name: "mcp",
  tool: null,
  summary: "serve every command as an MCP tool, and the library as resources, over stdio",
  details: `Serves MCP over stdio with the official MCP SDK: one tool per command other than mcp, each
returning the command's --json document, and the project's library as asset:// resources (the
same tree ls and cat read; --target names the project, the working directory's Git top level by
default). Model keys come from the environment. File paths are
local to this server. Refuses to start (exit 2) when a proxy or TLS variable is set that the
settings' environment.allow does not list. With --read-only, registers only read-only tools that\nnever spend and write nothing (cat's CLI-only --out is unavailable over MCP); direct calls to\nedit, spend and pick tools are refused. Resources include library facets and hash-bound staged\ncandidate links, verified before their bytes are read.`,
  json: false,
  input: {
    type: "object",
    properties: {
      readOnly: {
        type: "boolean",
        description: "expose only tools that read without spending or writing",
      },
      target: {
        type: "string",
        description: "the project whose library to serve as resources",
        placeholder: "<dir>",
      },
      workItem: {
        type: "string",
        description: "the work item the spend ledger counts against",
        placeholder: "<label>",
      },
      providerScript: {
        type: "string",
        description: "answer every model call from this module instead of a provider",
        placeholder: "<module>",
      },
    },
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "conditional", writes: "target" },
  async run(args, ctx) {
    // Decision-call log lines go to stderr; stdout carries only JSON-RPC.
    await serveMcp(
      {
        ...ctx,
        ...(args.providerScript !== undefined && { providerScript: args.providerScript }),
        ...(args.workItem !== undefined && { workItem: args.workItem }),
      },
      process.stdin,
      process.stdout,
      {
        ...(args.target !== undefined && { target: args.target }),
        ...(args.readOnly && { readOnly: true }),
      },
    );
    return { exitCode: 0, fields: {}, human: "" };
  },
});
