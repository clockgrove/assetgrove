/**
 * The target profile's top-level validator. A profile is a shared file: it travels between
 * developers, so an unknown or mistyped top-level field is refused (exit 2 `invalid_input`)
 * instead of being silently ignored. Nested sections keep their own validators where they are read.
 */
import { z } from "zod";
import { InputError } from "./errors.ts";
import { refuseSettingsBlocks } from "./shared-settings.ts";
import type { TargetProfile } from "./types.ts";

import { projectRulesSchema } from "./project-rules.ts";

const section = z.record(z.string(), z.unknown());

const profileSchema = z.strictObject({
  format: z.string(),
  name: z.string().optional(),
  rules: projectRulesSchema.optional(),
  license: z.string().optional(),
  acceptedLicenses: z.array(z.string()).optional(),
  style: section.optional(),
  values: section.optional(),
  frames: section.optional(),
  layout: section.optional(),
  manifest: z.unknown().optional(),
  review: section.optional(),
  validator: section.optional(),
  identity: section.optional(),
  spend: section.optional(),
  model3d: section.optional(),
  animation: section.optional(),
  kinds: z.record(z.string(), section).optional(),
  // Each preset's options are checked against its own schema at hand-off (src/handoff/presets).
  library: z
    .strictObject({
      root: z.string().optional(),
      game: z.string().optional(),
      log: z.boolean().optional(),
    })
    .optional(),
  handoff: z.array(z.strictObject({ preset: z.string(), options: section.optional() })).optional(),
});

/** The top-level fields a target profile may carry. */
export const PROFILE_FIELDS = Object.keys(profileSchema.shape);

/** Checks a target profile's top-level fields; `source` names the file in the message. */
export function validateProfile(value: Record<string, unknown>, source: string): TargetProfile {
  refuseSettingsBlocks(value, `target profile ${source}`);
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      if (issue.code === "unrecognized_keys")
        return `unknown top-level field${issue.keys.length > 1 ? "s" : ""} ${issue.keys
          .map((key) => `"${key}"`)
          .join(", ")} (known: ${PROFILE_FIELDS.join(", ")})`;
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    throw new InputError(`target profile ${source} is invalid: ${issues.join("; ")}`, {
      cause: parsed.error,
    });
  }
  return parsed.data as unknown as TargetProfile;
}
