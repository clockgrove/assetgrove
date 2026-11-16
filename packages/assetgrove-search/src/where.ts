import { SearchError } from "./errors.ts";
import type { FilterTerm, Scalar } from "./store.ts";

export const FILTER_FIELDS = [
  "kind",
  "subject",
  "state",
  "bible",
  "license",
  "source",
  "game",
  "id",
  "address",
  "path",
  "view",
  "title",
] as const;

const ALLOWED = `${FILTER_FIELDS.join(", ")}, tag`;
const OPS = ["!=", "=", "<", ">"] as const;

function bad(filter: string, why: string): SearchError {
  return new SearchError("invalid_input", `${why}. Allowed fields: ${ALLOWED}.`, {
    details: { filter },
  });
}

function parseOne(raw: string): FilterTerm {
  const m = /[=<>!]/.exec(raw);
  if (!m) throw bad(raw, `Filter "${raw}" has no operator (=, !=, <, >)`);
  const rest = raw.slice(m.index);
  const op = OPS.find((o) => rest.startsWith(o));
  if (!op) throw bad(raw, `Filter "${raw}" has no valid operator (=, !=, <, >)`);
  const field = raw.slice(0, m.index).trim();
  const value = rest.slice(op.length).trim();
  if (field === "") throw bad(raw, `Filter "${raw}" has an empty field`);
  if (field === "tag") {
    if (op !== "=") throw bad(raw, `Filter "${raw}": tag only supports =`);
    return { field: "tags", op: "has", value };
  }
  if (!(FILTER_FIELDS as readonly string[]).includes(field)) {
    throw bad(raw, `Unknown filter field "${field}"`);
  }
  return { field, op, value };
}

export function parseWhere(filters: string | string[]): FilterTerm[] {
  return (Array.isArray(filters) ? filters : [filters]).map(parseOne);
}

function literal(value: unknown, filter: FilterTerm): string {
  if (typeof value === "string") {
    if (value.includes("\u0000")) {
      throw new SearchError("invalid_input", "Filter value contains a NUL character.", {
        details: { filter },
      });
    }
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new SearchError("invalid_input", `Unsupported filter value for "${filter.field}".`, {
    details: { filter },
  });
}

export function compileFilter(terms: FilterTerm[]): string | undefined {
  if (terms.length === 0) return undefined;
  return terms
    .map((t) => {
      const isTags = t.field === "tags" && t.op === "has";
      const known =
        isTags ||
        t.field === "tree" ||
        t.field === "sha256" ||
        (FILTER_FIELDS as readonly string[]).includes(t.field);
      if (!known) {
        throw new SearchError(
          "invalid_input",
          `Unknown filter field. Allowed fields: ${ALLOWED}.`,
          {
            details: { filter: t },
          },
        );
      }
      if (t.op === "in") {
        if (isTags) {
          throw new SearchError("invalid_input", "tags only supports the has operator.", {
            details: { filter: t },
          });
        }
        // An empty list keeps no row; SQL has no empty IN list.
        if (t.value.length === 0) return `(${t.field} IS NULL AND ${t.field} IS NOT NULL)`;
        return `${t.field} IN (${t.value.map((v) => literal(v, t)).join(", ")})`;
      }
      const lit = literal(t.value, t);
      if (t.op === "has") {
        if (!isTags) {
          throw new SearchError("invalid_input", "Operator has only applies to tags.", {
            details: { filter: t },
          });
        }
        return `array_has(tags, ${lit})`;
      }
      if (isTags) {
        throw new SearchError("invalid_input", "tags only supports the has operator.", {
          details: { filter: t },
        });
      }
      if (t.op === "!=") return `(${t.field} IS NULL OR ${t.field} != ${lit})`;
      return `${t.field} ${t.op} ${lit}`;
    })
    .join(" AND ");
}

/**
 * The order `<` and `>` filters compare values in: numeric collation, so "2" comes before "10" and
 * "v3" before "v10". It is core's `newer()` (src/library/write.ts), the order of the stale view.
 */
export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

/**
 * Replaces each `<` and `>` term with `field IN (...)`: of the values `valuesOf` finds for that
 * field, those before (`<`) or after (`>`) the term's value by `compareVersions`. SQL and
 * JavaScript compare strings character by character, which puts "10" before "9".
 */
export async function resolveOrdered(
  terms: FilterTerm[],
  valuesOf: (field: string, others: FilterTerm[]) => Promise<Scalar[]>,
): Promise<FilterTerm[]> {
  const others = terms.filter((t) => t.op !== "<" && t.op !== ">");
  const out: FilterTerm[] = [];
  for (const t of terms) {
    if (t.op !== "<" && t.op !== ">") {
      out.push(t);
      continue;
    }
    const sign = t.op === "<" ? -1 : 1;
    const keep = [...new Set(await valuesOf(t.field, others))].filter(
      (v) => Math.sign(compareVersions(String(v), String(t.value))) === sign,
    );
    out.push({
      field: t.field,
      op: "in",
      value: keep.sort((a, b) => compareVersions(String(a), String(b))),
    });
  }
  return out;
}
