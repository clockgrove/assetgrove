/** A loopback OpenAI-compatible server: images, chat completions and structured output, with synthetic answers. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { encodePng } from "../../src/image/raster.ts";
import { drawSubject } from "./synthetic.ts";

const CHECKS = ["transparency", "frame-count", "identity", "perspective"];

export interface RecordedRequest {
  method: string;
  path: string;
  model: string | undefined;
}

export interface OpenAICompatibleServer {
  baseURL: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

/** A value matching one JSON-schema property. */
function valueFor(schema: { type?: string } | undefined): unknown {
  switch (schema?.type) {
    case "number":
    case "integer":
      return 0.5;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "ok";
  }
}

function answer(body: {
  response_format?: { json_schema?: { schema?: { properties?: Record<string, never> } } };
}): string {
  const format = body.response_format;
  if (format === undefined) {
    return (
      "```json\n" +
      JSON.stringify({ checks: CHECKS.map((check) => ({ check, passed: true, reason: "ok" })) }) +
      "\n```"
    );
  }
  const properties = format.json_schema?.schema?.properties ?? {};
  return JSON.stringify(
    Object.fromEntries(Object.entries(properties).map(([key, p]) => [key, valueFor(p)])),
  );
}

export async function openAICompatibleServer(): Promise<OpenAICompatibleServer> {
  const png = Buffer.from(encodePng(drawSubject(96, 0))).toString("base64");
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        // Not JSON: recorded without a model.
      }
      requests.push({
        method: req.method ?? "",
        path,
        model: typeof body["model"] === "string" ? body["model"] : undefined,
      });
      res.setHeader("content-type", "application/json");
      if (
        req.method === "POST" &&
        (path === "/v1/images/generations" || path === "/v1/images/edits")
      ) {
        res.end(JSON.stringify({ created: 0, data: [{ b64_json: png }] }));
      } else if (req.method === "POST" && path === "/v1/chat/completions") {
        res.end(
          JSON.stringify({
            id: "chatcmpl-local",
            object: "chat.completion",
            created: 0,
            model: body["model"],
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: answer(body) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${path}` } }));
      }
    });
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
