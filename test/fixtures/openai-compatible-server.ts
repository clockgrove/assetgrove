/**
 * A loopback OpenAI-compatible server for tests: the images API and chat completions, answered
 * with fixed content. It binds 127.0.0.1 only and records each request it receives.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { encodePng } from "../../src/image/raster.ts";
import { PROMPT_POLICY_QUESTION } from "../../src/policy/model.ts";
import { drawSubject } from "./synthetic.ts";

/** What a vision QA of a still accepts: every check passes. */
const PASSING_QA = JSON.stringify({
  checks: ["transparency", "frame-count", "identity", "perspective"].map((check) => ({
    check,
    passed: true,
    reason: "matches the reference",
  })),
});

export interface OpenAiServerOptions {
  /** The PNG every image request is answered with. */
  png?: Uint8Array;
  /** The chat reply when the request names no response_format schema. */
  chatText?: string;
}

export interface OpenAiServer {
  baseURL: string;
  requests: Array<{ method: string; path: string }>;
  close(): Promise<void>;
}

interface Schema {
  properties?: Record<string, { maximum?: number }>;
}

function structuredReply(body: unknown): string | undefined {
  const format = (
    body as { response_format?: { type?: string; json_schema?: { schema?: Schema } } }
  ).response_format;
  if (format?.type !== "json_schema") return undefined;
  const properties = format.json_schema?.schema?.properties ?? {};
  if ("score" in properties) return JSON.stringify({ score: properties["score"]?.maximum ?? 1 });
  // The prompt policy's model check allows the fixture's synthetic prompts; other Boolean
  // questions answer true.
  if ("probability" in properties)
    return JSON.stringify({
      probability: JSON.stringify(body).includes(PROMPT_POLICY_QUESTION.instructions) ? 0.05 : 0.9,
    });
  return "{}";
}

function send(res: ServerResponse, status: number, id: string, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("x-request-id", id);
  res.end(JSON.stringify(body));
}

export async function startOpenAiCompatibleServer(
  options: OpenAiServerOptions = {},
): Promise<OpenAiServer> {
  const png = options.png ?? encodePng(drawSubject(96, 0));
  const chatText = options.chatText ?? PASSING_QA;
  const requests: OpenAiServer["requests"] = [];
  let count = 0;

  const handle = (req: IncomingMessage, res: ServerResponse, raw: string): void => {
    const path = (req.url ?? "").split("?")[0]!;
    requests.push({ method: req.method ?? "", path });
    const id = `req-fixture-${++count}`;
    if (
      req.method === "POST" &&
      (path === "/v1/images/generations" || path === "/v1/images/edits")
    ) {
      send(res, 200, id, { created: 0, data: [{ b64_json: Buffer.from(png).toString("base64") }] });
    } else if (req.method === "POST" && path === "/v1/chat/completions") {
      let body: unknown = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // an unreadable body is answered as plain chat
      }
      const model = (body as { model?: string }).model ?? "fixture";
      send(res, 200, id, {
        id: `chatcmpl-${id}`,
        object: "chat.completion",
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: structuredReply(body) ?? chatText },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    } else {
      send(res, 404, id, {
        error: { message: `no route ${req.method} ${path}`, type: "not_found" },
      });
    }
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => handle(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
