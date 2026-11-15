/**
 * Canonical JSON and hashing for library records: object keys sorted recursively, no whitespace,
 * so the same content always yields the same bytes and the same id.
 */
import { createHash } from "node:crypto";

/** JSON with object keys in code-unit order, arrays in order and `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    const members = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Lower-case hex SHA-256 of text (UTF-8) or bytes. */
export function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}
