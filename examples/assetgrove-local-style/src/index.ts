import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
  ExtensionContext,
  ImageRequest,
  ProviderAdapter,
} from "../../../src/extension/api.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export default function localStyle(ctx: ExtensionContext) {
  const z = ctx.z;
  const configuration = z.strictObject({
    executable: z.string().refine(isAbsolute),
    graph: z.string().refine(isAbsolute),
    model: z.string().min(1),
    endpoint: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
    source: z.string().optional(),
  });
  const settings = () => configuration.parse(ctx.settings);
  const adapter: ProviderAdapter = {
    id: "local-style:image",
    capabilities: ["image", "edit"],
    fixedHosts: [],
    endpointFromSettings: true,
    create(c) {
      return {
        billing: {
          adapter: "local-style:image",
          providerId: c.providerId,
          paid: false,
          hosts: [],
          settle: "declared",
          reconcile: "unavailable",
        },
        async generateImage(request: ImageRequest) {
          const selected = settings();
          if (c.baseURL !== selected.endpoint || c.settings.free !== true)
            throw new Error(
              "local style requires free: true and baseURL equal to the configured loopback endpoint",
            );
          if (request.model !== selected.model)
            throw new Error("route model differs from the settings-selected local style model");
          if (!c.run) throw new Error("local style requires core's approved command runner");
          const graph = await readFile(selected.graph);
          const identity = {
            model: selected.model,
            graph: selected.graph,
            graphSha256: sha256(graph),
            endpoint: selected.endpoint,
            source: selected.source ?? "unknown",
          };
          const result = await c.run("local-style:runner", {
            args: [selected.graph, selected.endpoint, selected.model],
            files: {
              "input/request.json": JSON.stringify({
                ...request,
                providerOptions: undefined,
                identity,
                references: request.references.map((ref) => ({
                  mediaType: ref.mediaType,
                  base64: Buffer.from(ref.bytes).toString("base64"),
                })),
              }),
            },
          });
          if (result.exitCode !== 0)
            throw new Error(`local style command failed (${result.exitCode})`);
          const output = result.files.find((file) => file.path === "output/image.png");
          if (!output) throw new Error("local style command did not produce output/image.png");
          return {
            images: [{ mediaType: "image/png", bytes: output.content }],
            requestId: JSON.stringify({
              ...identity,
              commandHash: result.step.hash,
              outputSha256: sha256(output.content),
            }),
            requestIdSource: "local" as const,
            costUsd: 0,
          };
        },
        async analyzeImages() {
          throw new Error("local style does not provide vision");
        },
      };
    },
  };
  return {
    api: ctx.api,
    name: "local-style",
    settingsSchema: configuration,
    tools: [{ id: "local-style:runner", setting: "executable" }],
    adapters: [adapter],
  };
}

export function doctor(settings: {
  endpoint: string;
  model: string;
  graph: string;
  source?: string;
}) {
  return {
    mediaEndpoint: settings.endpoint,
    model: settings.model,
    graph: settings.graph,
    source: settings.source ?? "unknown",
  };
}
