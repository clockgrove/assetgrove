/**
 * What a kind may declare to check its own input: `specSchema` for every spec of the kind and
 * `profileSchema` for `kinds.<kind>` in the target profile. Neither may declare a routing field:
 * model, tier and price stay on the route in settings.
 */
import { z } from "zod";
import type { ZodType } from "zod";
import { InputError } from "./errors.ts";
import type { Generator } from "./generators/generator.ts";
import type { AssetSpec, TargetProfile } from "./types.ts";

/** Property names (lower-cased, without `-` and `_`) no kind schema may declare. */
export const FORBIDDEN_SCHEMA_FIELDS: readonly string[] = [
  "endpoint",
  "endpoints",
  "baseurl",
  "url",
  "urls",
  "model",
  "models",
  "provider",
  "providers",
  "provideroptions",
  "graph",
  "graphs",
  "command",
  "commands",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function walk(node: unknown, path: string[]): string | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = walk(item, path);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(node)) return undefined;
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && isRecord(value)) {
      for (const [name, child] of Object.entries(value)) {
        if (FORBIDDEN_SCHEMA_FIELDS.includes(name.toLowerCase().replace(/[-_]/g, "")))
          return [...path, name].join(".");
        const found = walk(child, [...path, name]);
        if (found !== undefined) return found;
      }
    } else if (key === "$defs" || key === "definitions") {
      if (isRecord(value))
        for (const child of Object.values(value)) {
          const found = walk(child, path);
          if (found !== undefined) return found;
        }
    } else {
      const found = walk(value, path);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The dotted path of the first routing field a schema declares, or undefined when it has none. */
export function forbiddenSchemaField(schema: ZodType): string | undefined {
  const json = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  return walk(json, []);
}

const isZod = (schema: unknown): schema is ZodType =>
  typeof schema === "object" &&
  schema !== null &&
  typeof (schema as { safeParse?: unknown }).safeParse === "function";

/** Refuses, at load, a kind whose schemas are not zod schemas or declare a routing field. */
export function checkKindSchemas(kind: Generator, refuse: (why: string) => Error): void {
  for (const name of ["specSchema", "profileSchema"] as const) {
    const schema: unknown = kind[name];
    if (schema === undefined) continue;
    if (!isZod(schema)) throw refuse(`the ${name} of kind ${kind.kind} must be a zod schema`);
    let field: string | undefined;
    try {
      field = forbiddenSchemaField(schema);
    } catch (cause) {
      throw refuse(
        `the ${name} of kind ${kind.kind} cannot be inspected: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (field !== undefined)
      throw refuse(
        `the ${name} of kind ${kind.kind} declares "${field}", a routing field: model, tier and price stay on the route in settings (an endpoint, model, provider options, graph or command is never a spec or profile field)`,
      );
  }
}

/** Refuses a spec its kind's `specSchema` does not accept, naming each field. */
export function validateKindSpec(kind: Generator, spec: AssetSpec): void {
  if (kind.specSchema === undefined) return;
  const parsed = kind.specSchema.safeParse(spec);
  if (parsed.success) return;
  const issues = parsed.error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  throw new InputError(`the ${kind.kind} spec is invalid: ${issues.join("; ")}`, {
    cause: parsed.error,
  });
}

/** Refuses a `kinds.<kind>` profile block its kind's `profileSchema` does not accept. */
export function validateKindProfile(
  kind: Generator,
  profile: TargetProfile,
  source?: string,
): void {
  const block: unknown = profile.kinds?.[kind.kind];
  if (block === undefined) return;
  const where = `target profile${source !== undefined ? ` ${source}` : ""}`;
  if (!isRecord(block)) throw new InputError(`${where} kinds.${kind.kind} must be an object`);
  const { values, ...rest } = block;
  if (values !== undefined && !isRecord(values))
    throw new InputError(`${where} kinds.${kind.kind}.values must be an object`);
  if (kind.profileSchema !== undefined) {
    const parsed = kind.profileSchema.safeParse(rest);
    if (parsed.success) return;
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.map(String).join(".");
      return `${where} kinds.${kind.kind}${path ? `.${path}` : ""}: ${issue.message}`;
    });
    throw new InputError(issues.join("; "), { cause: parsed.error });
  }
  const [unknown] = Object.keys(rest);
  if (unknown !== undefined)
    throw new InputError(
      `${where} kinds.${kind.kind} has unknown field "${unknown}"; kind ${kind.kind} declares no profile fields, so the block accepts only values`,
    );
}
