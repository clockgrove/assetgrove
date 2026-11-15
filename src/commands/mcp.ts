import { serveMcp } from "../mcp.ts";
import { defineCommand } from "./types.ts";

interface McpArgs {
  target?: string;
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
settings' environment.allow does not list.`,
  json: false,
  input: {
    type: "object",
    properties: {
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
      { ...(args.target !== undefined && { target: args.target }) },
    );
    return { exitCode: 0, fields: {}, human: "" };
  },
});
