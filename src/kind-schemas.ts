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

const isForbidden = (name: string): boolean =>
  FORBIDDEN_SCHEMA_FIELDS.includes(name.toLowerCase().replace(/[-_]/g, ""));

/** The spellings a key pattern is tried against: each forbidden field and its usual camel and snake forms. */
const FORBIDDEN_SPELLINGS: readonly string[] = [
  ...FORBIDDEN_SCHEMA_FIELDS,
  "baseURL",
  "baseUrl",
  "base_url",
  "base-url",
  "providerOptions",
  "provider_options",
  "provider-options",
];

/**
 * Names no routing field: a key pattern that matches these as well admits any name, like
 * `additionalProperties`, and so declares no field.
 */
const NEUTRAL_NAMES: readonly string[] = ["zzzz", "palette", "frames", "x1"];

/** The forbidden spelling a key pattern names, when it names one rather than admitting any key. */
function forbiddenByPattern(pattern: unknown): string | undefined {
  if (typeof pattern !== "string") return undefined;
  const regex = new RegExp(pattern, "u");
  if (NEUTRAL_NAMES.some((name) => regex.test(name))) return undefined;
  return FORBIDDEN_SPELLINGS.find((name) => regex.test(name));
}

/** The forbidden names a `propertyNames` schema admits: its `const`, `enum` and `pattern`. */
function forbiddenKeyNames(node: Record<string, unknown>): string | undefined {
  const names = [
    ...(typeof node["const"] === "string" ? [node["const"]] : []),
    ...(Array.isArray(node["enum"]) ? node["enum"].filter((v) => typeof v === "string") : []),
  ];
  return names.find(isForbidden) ?? forbiddenByPattern(node["pattern"]);
}

/**
 * The dotted path of the first field a JSON Schema node declares with a routing name: through
 * `properties`, `required`, `propertyNames` (const, enum, pattern) and `patternProperties`, at any
 * depth.
 */
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
    let found: string | undefined;
    if (key === "properties" && isRecord(value)) {
      for (const [name, child] of Object.entries(value)) {
        if (isForbidden(name)) return [...path, name].join(".");
        found = walk(child, [...path, name]);
        if (found !== undefined) return found;
      }
    } else if (key === "patternProperties" && isRecord(value)) {
      for (const [pattern, child] of Object.entries(value)) {
        const name = forbiddenByPattern(pattern);
        if (name !== undefined) return [...path, name].join(".");
        found = walk(child, [...path, `/${pattern}/`]);
        if (found !== undefined) return found;
      }
    } else if (key === "propertyNames" && isRecord(value)) {
      const name = forbiddenKeyNames(value);
      if (name !== undefined) return [...path, name].join(".");
      found = walk(value, path);
    } else if (key === "required" && Array.isArray(value)) {
      const name = value.find((v): v is string => typeof v === "string" && isForbidden(v));
      if (name !== undefined) return [...path, name].join(".");
    } else if (key === "$defs" || key === "definitions") {
      if (isRecord(value))
        for (const child of Object.values(value)) {
          found = walk(child, path);
          if (found !== undefined) return found;
        }
    } else {
      found = walk(value, path);
    }
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The dotted path of the first routing field a schema declares, or undefined when it has none.
 * Both sides are read: what the schema accepts (`io: "input"`) and what it gives (`io: "output"`),
 * so a pipe or transform cannot hide a field on either side.
 */
export function forbiddenSchemaField(schema: ZodType): string | undefined {
  for (const io of ["input", "output"] as const) {
    const found = walk(z.toJSONSchema(schema, { unrepresentable: "any", io }), []);
    if (found !== undefined) return found;
  }
  return undefined;
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
