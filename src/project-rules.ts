import { measureMediaBytes } from "./library/media-metadata.ts";
import { sha256Hex } from "./library/canonical.ts";
import { z } from "zod";
import { InputError } from "./errors.ts";

const base = { id: z.string().min(1), severity: z.enum(["error", "warning"]).default("error") };
const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/);
export const projectRulesSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        ...base,
        kind: z.literal("required"),
        source: z.enum(["spec", "card"]),
        field,
        values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
      }),
      z.strictObject({
        ...base,
        kind: z.literal("labels"),
        required: z.array(z.string()).default([]),
        allowed: z.array(z.string()).optional(),
      }),
      z.strictObject({
        ...base,
        kind: z.literal("media"),
        metric: z.enum(["bytes", "width", "height"]),
        max: z.number().finite().nonnegative(),
      }),
    ]),
  )
  .superRefine((rules, ctx) => {
    const ids = new Set<string>();
    rules.forEach((rule, index) => {
      if (ids.has(rule.id))
        ctx.addIssue({ code: "custom", path: [index, "id"], message: "duplicate rule id" });
      ids.add(rule.id);
    });
  });
export type ProjectRule = z.infer<typeof projectRulesSchema>[number];
export interface RuleFinding {
  rule: string;
  asset: string;
  severity: "error" | "warning";
  evidence: "spec" | "card" | "media";
  status: "passed" | "failed" | "unavailable";
}
function at(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key))
      return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
export function evaluateProjectRules(input: {
  rules?: ProjectRule[];
  asset: string;
  spec?: Record<string, unknown>;
  card?: Record<string, unknown>;
  media?: Partial<Record<"bytes" | "width" | "height", number>>;
}): RuleFinding[] {
  return (input.rules ?? []).map((rule) => {
    let evidence: RuleFinding["evidence"];
    let pass: boolean | undefined;
    if (rule.kind === "required") {
      evidence = rule.source;
      const source = input[rule.source];
      if (source !== undefined) {
        const value = at(source, rule.field);
        pass =
          value !== undefined &&
          value !== null &&
          value !== "" &&
          (rule.values === undefined || rule.values.some((allowed) => Object.is(allowed, value)));
      }
    } else if (rule.kind === "labels") {
      evidence = "card";
      if (input.card !== undefined) {
        const tags = input.card["tags"] ?? [];
        pass =
          Array.isArray(tags) &&
          tags.every((tag) => typeof tag === "string") &&
          rule.required.every((tag) => tags.includes(tag)) &&
          (rule.allowed === undefined ||
            tags.every((tag) => rule.allowed!.includes(tag as string)));
      }
    } else {
      evidence = "media";
      const value = input.media?.[rule.metric];
      if (value !== undefined) pass = value <= rule.max;
    }
    return {
      rule: rule.id,
      asset: input.asset,
      severity: rule.severity,
      evidence,
      status: pass === undefined ? "unavailable" : pass ? "passed" : "failed",
    };
  });
}
export function enforceProjectRules(findings: RuleFinding[]): void {
  const errors = findings.filter(
    (finding) => finding.status === "failed" && finding.severity === "error",
  );
  if (errors.length)
    throw new InputError(
      errors
        .map((finding) => `project rule ${finding.rule}: ${finding.asset} (${finding.evidence})`)
        .join("; "),
    );
}

export function measuredRuleMedia(
  bytes: Uint8Array,
): Partial<Record<"bytes" | "width" | "height", number>> {
  const evidence = measureMediaBytes(bytes, sha256Hex(bytes));
  return {
    bytes: bytes.byteLength,
    ...(evidence.status === "available" &&
      evidence.width !== undefined && { width: evidence.width }),
    ...(evidence.status === "available" &&
      evidence.height !== undefined && { height: evidence.height }),
  };
}
