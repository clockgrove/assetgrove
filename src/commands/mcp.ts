import { serveMcp } from "../mcp.ts";
import { defineCommand } from "./types.ts";

interface McpArgs {
  workItem?: string;
  providerScript?: string;
}

export const mcpCommand = defineCommand<McpArgs>({
  name: "mcp",
  tool: null,
  summary: "serve every command as an MCP tool over stdio",
  details: `Serves MCP over stdio with the official MCP SDK: one tool per command other than mcp, each
returning the command's --json document. Model keys come from the environment. File paths are
local to this server. Refuses to start (exit 2) when a proxy or TLS variable is set that the
settings' environment.allow does not list.`,
  json: false,
  input: {
    type: "object",
    properties: {
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
    await serveMcp({
      ...ctx,
      ...(args.providerScript !== undefined && { providerScript: args.providerScript }),
      ...(args.workItem !== undefined && { workItem: args.workItem }),
    });
    return { exitCode: 0, fields: {}, human: "" };
  },
});
