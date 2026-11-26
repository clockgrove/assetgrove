/**
 * What the pack reads from Godot's text files as data: the UID in an `.import` file's `[remap]`
 * section, the `[params]` of an `.import`, the UID in a text resource's `[gd_resource ...]` header, and a text resource's
 * `ext_resource` references. It reads them only to hand them to Godot and to check what Godot
 * wrote; Godot writes every file the target receives.
 */

/** A Godot UID as text: `uid://` and its base-34 id. */
const UID = /^uid:\/\/[a-z0-9]+$/;

/** The value of `key="..."` inside one bracketed header line, or undefined. */
function attribute(line: string, key: string): string | undefined {
  const match = new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(line);
  return match?.[1];
}

const text = (content: Uint8Array | string) =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

/** The UID an `.import` file gives its source file (`uid="uid://..."` under `[remap]`). */
export function importUid(content: Uint8Array | string): string | undefined {
  let section = "";
  for (const raw of text(content).split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1] ?? "";
      continue;
    }
    if (section !== "remap") continue;
    const match = /^uid\s*=\s*"([^"]*)"$/.exec(line);
    if (match && UID.test(match[1] ?? "")) return match[1];
  }
  return undefined;
}

/** The `[params]` section of an `.import` file: each key's value as written, quotes removed. */
export function importParams(content: Uint8Array | string): Record<string, string> {
  const params: Record<string, string> = {};
  let section = "";
  for (const raw of text(content).split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1] ?? "";
      continue;
    }
    if (section !== "params") continue;
    const match = /^([^=\s;][^=]*?)\s*=\s*(.*)$/.exec(line);
    if (match) params[match[1] ?? ""] = (match[2] ?? "").replace(/^"(.*)"$/, "$1");
  }
  return params;
}

/** A text resource's header: its type and UID. */
export interface ResourceHeader {
  type: string | undefined;
  uid: string | undefined;
}

/** The `[gd_resource ...]` header of a text resource, or undefined when it has none. */
export function resourceHeader(content: Uint8Array | string): ResourceHeader | undefined {
  const first = text(content)
    .split(/\r?\n/)
    .find((line) => line.trim() !== "");
  if (first === undefined || !first.startsWith("[gd_resource")) return undefined;
  const uid = attribute(first, "uid");
  return {
    type: attribute(first, "type"),
    uid: uid !== undefined && UID.test(uid) ? uid : undefined,
  };
}

/** One `[ext_resource ...]` line of a text resource. */
export interface ExternalReference {
  type: string | undefined;
  uid: string | undefined;
  path: string | undefined;
}

/** A section header of a text resource, as Godot's parser reads it: whitespace may come first. */
export function headerTag(line: string): string | undefined {
  return /^\s*\[\s*([A-Za-z_]+)/.exec(line)?.[1];
}

/** Every external resource a text resource references. */
export function externalReferences(content: Uint8Array | string): ExternalReference[] {
  return text(content)
    .split(/\r?\n/)
    .filter((line) => headerTag(line) === "ext_resource")
    .map((line) => ({
      type: attribute(line, "type"),
      uid: attribute(line, "uid"),
      path: attribute(line, "path"),
    }));
}

/** The value of `key="..."` inside one bracketed header line, or undefined. */
export const headerAttribute = attribute;

/** The UID in the first line of a text scene (`[gd_scene ...]`) or resource (`[gd_resource ...]`). */
export function textHeaderUid(content: Uint8Array | string): string | undefined {
  const first = text(content)
    .split(/\r?\n/)
    .find((line) => line.trim() !== "");
  if (first === undefined || !/^\[gd_(scene|resource)\b/.test(first)) return undefined;
  const uid = attribute(first, "uid");
  return uid !== undefined && UID.test(uid) ? uid : undefined;
}
