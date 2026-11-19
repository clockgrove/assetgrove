/**
 * The schemas core's own kinds declare (#416), through the same `specSchema` and `profileSchema`
 * fields a pack's kind uses. They are permissive on purpose: every spec and profile block core's
 * kinds accepted before still passes, and each kind keeps its own checks where it reads a field.
 */
import { z } from "zod";

/** The spec fields every core kind reads, typed; any other field is kept. */
export const CORE_SPEC_SCHEMA = z.looseObject({
  kind: z.string(),
  assetId: z.string().optional(),
  subject: z.string().optional(),
  look: z.string().optional(),
  animationFamily: z.string().optional(),
  keyPose: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
});

/** Core's kinds declare no profile block fields: `kinds.<kind>` also accepts core-owned `values` and `layout`. */
export const CORE_PROFILE_SCHEMA = z.strictObject({});
