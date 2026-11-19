import { z } from "zod";
import { InputError } from "./errors.ts";
import { DIGITAL_SOURCE_TYPES, parseDigitalSourceType } from "./metadata.ts";
import type { DigitalSourceType, SourceDeclaration } from "./metadata.ts";

export const originSchema = z
  .strictObject({
    kind: z.enum(["human-made", "third-party"]),
    evidence: z.string().refine((value) => value.trim().length > 0, "must not be empty"),
    source: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
  })
  .superRefine((record, ctx) => {
    if (record.kind === "third-party" && !record.source)
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: "third-party origin needs its source",
      });
  });
export type OriginRecord = z.infer<typeof originSchema>;
export interface LibraryOrigin {
  kind: "unknown" | "ai-generated" | "human-made" | "third-party";
  declaredKind?: OriginRecord["kind"];
  evidence?: string;
  source?: string;
  license?: string;
  digitalSourceType?: DigitalSourceType;
}
export const libraryOriginSchema = z.object({
  kind: z.enum(["unknown", "ai-generated", "human-made", "third-party"]),
  declaredKind: z.enum(["human-made", "third-party"]).optional(),
  evidence: z.string().optional(),
  source: z.string().optional(),
  license: z.string().optional(),
  digitalSourceType: z
    .custom<DigitalSourceType>((value) => originSourceType(value) !== undefined)
    .optional(),
});
export function parseOrigin(value: unknown, label = "origin"): OriginRecord {
  const result = originSchema.safeParse(value);
  if (!result.success) throw new InputError(`invalid ${label}: ${result.error.message}`);
  return result.data;
}
export function originOf(provenance: {
  origin?: OriginRecord;
  digitalSourceType?: DigitalSourceType;
  sourceDeclaration?: SourceDeclaration;
}): LibraryOrigin {
  const digitalSourceType = provenance.digitalSourceType;
  const ai =
    digitalSourceType === DIGITAL_SOURCE_TYPES.generated ||
    digitalSourceType === DIGITAL_SOURCE_TYPES.composite;
  const humanDeclaration = provenance.sourceDeclaration?.value === DIGITAL_SOURCE_TYPES.human;
  return {
    ...provenance.origin,
    ...(provenance.origin !== undefined && { declaredKind: provenance.origin.kind }),
    kind: ai
      ? "ai-generated"
      : (provenance.origin?.kind ?? (humanDeclaration ? "human-made" : "unknown")),
    ...(provenance.origin === undefined &&
      humanDeclaration && {
        evidence: `Declared ${provenance.sourceDeclaration!.value} by ${provenance.sourceDeclaration!.declaredBy}`,
      }),
    ...(digitalSourceType !== undefined && { digitalSourceType }),
  };
}
export function originSourceType(value: unknown): DigitalSourceType | undefined {
  return value === "undeclared"
    ? value
    : typeof value === "string"
      ? parseDigitalSourceType(value)
      : undefined;
}
