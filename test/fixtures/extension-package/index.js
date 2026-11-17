/**
 * A synthetic Assetgrove extension: the asset kind `fixture:tile` (one PNG and one text
 * artifact per candidate), the hand-off preset
 * `fixture:list` and the provider adapter `fixture:echo`, which answers every image call with one
 * small PNG and reaches no host. Importing it writes `imported.marker` beside it, so a test can
 * tell whether core imported it. It imports nothing from core: zod comes through the context.
 */
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { URL } from "node:url";

writeFileSync(new URL("./imported.marker", import.meta.url), "imported\n");

/** An 8x8 PNG of the synthetic subject. */
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAhElEQVR4AQXBoZWDAAAFQYpBRFAUAk2J0dFXyDf7Vu/NHLJkyZIlS5YsWYcsWbJkyZIlS9YhS5YsWbJkyZJ1yJIlS5YsWbJkHbJkfc6rz3n1Oa8+59XnvJJ1yJJ1P2/383Y/b/fzdj9vsg5ZsmR9f399f399f3/JknXIkiVLlixZsmT9A1RB371ll+fVAAAAAElFTkSuQmCC",
    "base64",
  ),
);

/** @param {{ api: number, z: typeof import("zod").z }} context */
export default function extension({ z }) {
  return {
    api: 1,
    name: "fixture",
    kinds: [
      {
        kind: "fixture:tile",
        planCandidate(_spec, _profile, routes) {
          const route = routes.still;
          return [
            { operation: "still", model: route.model, estimatedCostUsd: route.estimatedCostUsd },
          ];
        },
        async generate(ctx) {
          const prompt = `a tile named ${ctx.spec.assetId}`;
          const image = await ctx.call.image("still", prompt, [], ctx.seed);
          return {
            output: {
              mediaType: image.mediaType,
              extension: "png",
              bytes: image.bytes,
              fields: {},
            },
            qa: {
              passed: true,
              reasons: [
                { check: "tile", passed: true, reason: "a fixture tile", source: "deterministic" },
              ],
            },
            prompt,
            parameters: {},
            // Written beside the candidate, in a directory named after the kind.
            artifacts: [{ name: "tile.txt", bytes: new Uint8Array(Buffer.from(`${prompt}\n`)) }],
          };
        },
      },
    ],
    presets: [
      {
        name: "fixture:list",
        optionsSchema: z.strictObject({ file: z.string().default("tiles.txt") }),
        write(ctx, options) {
          return [{ path: options.file, content: `${ctx.context.spec.assetId}\n` }];
        },
        async check(_ctx, options, _files, read) {
          return (await read(options.file)) === undefined ? [`${options.file} is missing`] : [];
        },
      },
    ],
    adapters: [
      {
        id: "fixture:echo",
        capabilities: ["image"],
        fixedHosts: [],
        // Free only as core allows: settings mark it `free` on a loopback baseURL.
        endpointFromSettings: true,
        defaultRoutes: {
          still: {
            model: "echo-1",
            estimatedCostUsd: 0,
            providerTerms: "fixture terms",
            outputGrant: { license: "MIT", plan: "fixture", commercial: true, relabel: true },
          },
        },
        create(c) {
          return {
            billing: {
              adapter: "fixture:echo",
              providerId: c.providerId,
              // Core replaces it: a pack cannot declare itself free.
              paid: false,
              hosts: [],
              settle: "declared",
              reconcile: "unavailable",
            },
            async generateImage() {
              return {
                requestId: "fixture-1",
                requestIdSource: "local",
                images: [{ mediaType: "image/png", bytes: PNG }],
              };
            },
            async analyzeImages() {
              throw new Error("fixture:echo answers image calls only");
            },
          };
        },
      },
    ],
  };
}
