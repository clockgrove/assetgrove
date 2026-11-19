/** Project labels are stored in cards' OKF tags; this vocabulary supplies their canonical names. */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { InputError } from "../errors.ts";

export const LABELS_PATH = ".assetgrove/labels.json";
const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((s) => !/[\r\n\t]/.test(s));
const schema = z.object({
  format: z.literal("assetgrove-labels/1"),
  labels: z.array(z.object({ name, aliases: z.array(name).default([]) })),
});
export interface Vocabulary {
  path: string;
  labels: { name: string; aliases: string[] }[];
  mappings: Map<string, string>;
  collisions: { value: string; labels: string[] }[];
}
const key = (value: string) => value.trim().normalize("NFKC").toLowerCase();

export function parseVocabulary(text: string, path: string): Vocabulary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InputError(`${path}: invalid JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success)
    throw new InputError(`${path}: invalid label vocabulary: ${result.error.message}`);
  const claims = new Map<string, string[]>();
  for (const label of result.data.labels) {
    for (const value of [label.name, ...label.aliases]) {
      const names = claims.get(key(value)) ?? [];
      names.push(label.name);
      claims.set(key(value), names);
    }
  }
  const collisions = [...claims].flatMap(([value, labels]) => {
    const unique = [...new Set(labels)];
    // Repeated canonical names also make the vocabulary ambiguous.
    const duplicates = result.data.labels.filter((l) => key(l.name) === value).length > 1;
    return unique.length > 1 || duplicates ? [{ value, labels: unique }] : [];
  });
  return {
    path,
    labels: result.data.labels,
    collisions,
    mappings: new Map(
      [...claims]
        .filter(([value]) => !collisions.some((c) => c.value === value))
        .map(([value, names]) => [value, names[0]!]),
    ),
  };
}

export function loadVocabulary(dir: string): Vocabulary | undefined {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const path = join(at, LABELS_PATH);
    if (existsSync(path)) return parseVocabulary(readFileSync(path, "utf8"), path);
    if (dirname(at) === at) return undefined;
  }
}
export function checkedVocabulary(dir: string): Vocabulary | undefined {
  const vocabulary = loadVocabulary(dir);
  if (vocabulary?.collisions.length)
    throw new InputError(
      `${vocabulary.path}: label collisions: ${vocabulary.collisions.map((c) => c.value).join(", ")}`,
    );
  return vocabulary;
}
export function canonicalLabel(
  value: string,
  vocabulary: Vocabulary | undefined,
): string | undefined {
  return vocabulary ? vocabulary.mappings.get(key(value)) : value;
}
/** Existing unknown values remain data; machine suggestions are restricted to the vocabulary. */
export function canonicalLabels(
  values: string[],
  vocabulary: Vocabulary | undefined,
  unknown: "keep" | "omit" = "keep",
): string[] {
  return [
    ...new Set(
      values.flatMap((value) => {
        const canonical = canonicalLabel(value, vocabulary);
        return canonical !== undefined ? [canonical] : unknown === "keep" ? [value] : [];
      }),
    ),
  ];
}
export function editLabels(
  values: unknown,
  existing: unknown,
  vocabulary: Vocabulary | undefined,
): string[] {
  if (!Array.isArray(values) || !values.every((v): v is string => typeof v === "string"))
    throw new InputError("tags must be an array of label names; use --label <name>");
  const prior = Array.isArray(existing) ? existing : [];
  for (const value of values)
    if (canonicalLabel(value, vocabulary) === undefined && !prior.includes(value))
      throw new InputError(`unknown label "${value}"; add it to ${vocabulary!.path} first`);
  return canonicalLabels(values, vocabulary);
}
export function labelFilters(filters: string[], vocabulary: Vocabulary | undefined): string[] {
  return filters.map((filter) =>
    filter.replace(
      /^\s*(tag|label)\s*=(.*)$/s,
      (_all, _field: string, value: string) =>
        `tag=${canonicalLabel(value.trim(), vocabulary) ?? value.trim()}`,
    ),
  );
}
