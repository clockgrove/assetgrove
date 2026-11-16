import { SearchError } from "./errors.ts";
import type { FilterTerm } from "./store.ts";

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
