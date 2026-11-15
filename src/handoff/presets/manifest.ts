/**
 * The `manifest` preset: the JSON manifest rendered from the profile's `manifest` template at
 * `layout.manifest`, with the review field set to the profile's pending value. It writes the same
 * bytes hand-off wrote before presets. It takes no options.
 */
import { z } from "zod";
import { InputError } from "../../errors.ts";
import { lookup, render, setPath } from "../../template.ts";
import type { HandoffPreset } from "./index.ts";

export const manifestPreset: HandoffPreset<Record<string, never>> = {
  name: "manifest",
  optionsSchema: z.strictObject({}),
  write({ profile, context, manifestRel }) {
    const manifest = render(profile.manifest, context);
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new InputError("the profile's manifest template must render to a JSON object");
    }
    setPath(manifest as Record<string, unknown>, profile.review.path, profile.review.pending);
    return [{ path: manifestRel, content: `${JSON.stringify(manifest, null, 2)}\n` }];
  },
  async check({ profile }, _options, files, read) {
    const problems: string[] = [];
    for (const file of files) {
      const bytes = await read(file.path);
      if (bytes === undefined) {
        problems.push(`${file.path} is missing`);
        continue;
      }
      const text = new TextDecoder().decode(bytes);
      if (text !== file.content) problems.push(`${file.path} does not read back as written`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        problems.push(`${file.path} is not JSON`);
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        problems.push(`${file.path} is not a JSON object`);
        continue;
      }
      if (lookup(parsed, profile.review.path) !== profile.review.pending) {
        problems.push(
          `${file.path} does not hold ${profile.review.path} = ${JSON.stringify(profile.review.pending)}`,
        );
      }
    }
    return problems;
  },
};
