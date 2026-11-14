/**
 * Throwaway probe for how an MCP host treats a long, interactive tool call.
 * Run over stdio: `node scripts/host-probe.ts`, then call the `probe` tool.
 * The tool asks a form (approve + colour), then sends progress every
 * `intervalSeconds` for `durationSeconds`, then returns an image of the colour.
 */
import {
  McpServer,
  fromJsonSchema,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { PNG } from "pngjs";
import { setTimeout as sleep } from "node:timers/promises";

type Arguments = { intervalSeconds?: number; durationSeconds?: number };

const COLOURS = {
  red: [255, 0, 0],
  green: [0, 160, 0],
  blue: [0, 0, 255],
} as const;

const log = (message: string): void => {
  process.stderr.write(`host-probe: ${message}\n`);
};

function swatch(colour: keyof typeof COLOURS): string {
  const png = new PNG({ width: 64, height: 64 });
  const [r, g, b] = COLOURS[colour];
  for (let i = 0; i < png.data.length; i += 4) png.data.set([r, g, b, 255], i);
  return PNG.sync.write(png).toString("base64");
}

function createServer(): McpServer {
  const server = new McpServer({ name: "assetgrove-host-probe", version: "0.0.0" });
  server.registerTool(
    "probe",
    {
      description: "Asks a form, sends progress for a while, then returns an image.",
      inputSchema: fromJsonSchema<Arguments>({
        type: "object",
        properties: {
          intervalSeconds: { type: "number", exclusiveMinimum: 0, default: 5 },
          durationSeconds: { type: "number", exclusiveMinimum: 0, default: 120 },
        },
      }),
      _meta: { "anthropic/requiresUserInteraction": true },
    },
    async (args, ctx) => {
      const answer = inputResponse(ctx.mcpReq.inputResponses, "confirm");
      if (answer.kind !== "elicit") {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: "Run the host probe?",
              requestedSchema: {
                type: "object",
                properties: {
                  approve: { type: "boolean", title: "Approve" },
                  choice: { type: "string", title: "Colour", enum: ["red", "green", "blue"] },
                },
                required: ["approve", "choice"],
              },
            }),
          },
        });
      }
      const choice = answer.content?.choice;
      if (
        answer.action !== "accept" ||
        answer.content?.approve !== true ||
        !(typeof choice === "string" && choice in COLOURS)
      ) {
        return {
          content: [{ type: "text", text: `probe: ${answer.action}` }],
          isError: true,
        };
      }

      const intervalSeconds = args.intervalSeconds ?? 5;
      const durationSeconds = args.durationSeconds ?? 120;
      const progressToken = ctx.mcpReq._meta?.progressToken;
      const started = Date.now();
      for (;;) {
        const elapsed = Math.min((Date.now() - started) / 1000, durationSeconds);
        log(`tick ${elapsed.toFixed(1)}s of ${durationSeconds}s`);
        if (progressToken !== undefined) {
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: elapsed,
              total: durationSeconds,
              message: `${elapsed.toFixed(1)}s of ${durationSeconds}s`,
            },
          });
        }
        if (elapsed >= durationSeconds) break;
        try {
          await sleep(Math.min(intervalSeconds, durationSeconds - elapsed) * 1000, undefined, {
            signal: ctx.mcpReq.signal,
          });
        } catch {
          log("cancelled");
          return { content: [{ type: "text", text: "probe: cancelled" }], isError: true };
        }
      }

      return {
        content: [
          { type: "text", text: `choice: ${choice}` },
          { type: "image", mimeType: "image/png", data: swatch(choice as keyof typeof COLOURS) },
        ],
      };
    },
  );
  return server;
}

const handle = serveStdio(createServer, {
  transport: new StdioServerTransport(),
  onerror: (error) => log(error.message),
});
process.stdin.once("close", () => void handle.close());
