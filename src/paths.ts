/**
 * Path rules for every OS (design section 14). Relative paths in records and JSON output use `/`,
 * and readers accept `/` only. A set of writes in which two name the same file or differ only by
 * case, or a written path segment Windows cannot hold, is refused as invalid input before anything
 * is written, so a run behaves the same on case-insensitive file systems and on Windows, where `:`
 * names an alternate data stream. Long paths need nothing here: on Windows, Node's fs namespaces
 * absolute paths itself.
 */
import { posix, relative, sep } from "node:path";
import { InputError } from "./errors.ts";
import { lookup } from "./template.ts";
import type { AssetSpec, TargetProfile } from "./types.ts";

/** `rel` as records and JSON output carry it: `/`-separated. */
export function recordPath(rel: string): string {
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** `path` relative to `root`, as a record path. */
export function relativeRecordPath(root: string, path: string): string {
  return recordPath(relative(root, path));
}

/** A relative path read from a record: `/`-separated only. */
export function readRecordPath(rel: string, what = "record path"): string {
  if (rel.includes("\\")) {
    throw new InputError(`${what} "${rel}" must use "/" separators`);
  }
  return rel;
}

/**
 * `name` as one file-name segment: lower-case letters, digits and hyphens, every other run of
 * characters (`:` and `/` included) one hyphen. Core asset kinds pass unchanged; `ext:tile`
 * becomes `ext-tile`; a name with nothing left becomes `kind`.
 */
export function safeSegment(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "kind"
  );
}

/** Windows device names, which name no file with or without an extension. */
const RESERVED_NAME =
  /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(\..*)?$/i;

/** Why Windows cannot hold `segment` as a file or directory name, or undefined when it can. */
function windowsProblem(segment: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const bad = /[<>:"|?*\\\u0000-\u001f]/.exec(segment);
  if (bad) return `has ${JSON.stringify(bad[0])} in "${segment}"`;
  if (/[. ]$/.test(segment) && segment !== "." && segment !== "..") {
    return `ends "${segment}" with a dot or a space`;
  }
  if (RESERVED_NAME.test(segment)) return `names the reserved device "${segment}"`;
  return undefined;
}

/**
 * `name` as one file-name segment `windowsProblem` accepts: each character Windows refuses
 * (`<>:"|?*`, a backslash, a control character) and `/` becomes `-`, a trailing dot or space
 * becomes `-`, a device name gets a `_` prefix, and `""`, `.` and `..` become `artifact`.
 */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let safe = name.replace(/[<>:"|?*\\/\u0000-\u001f]/g, "-");
  if (safe === "" || safe === "." || safe === "..") return "artifact";
  safe = safe.replace(/[. ]$/, "-");
  if (RESERVED_NAME.test(safe)) safe = `_${safe}`;
  return safe;
}

/**
 * Refuses, before anything is written, a set of `/`-separated relative paths in which two name the
 * same file or differ only by case, or a segment Windows cannot hold: one with `<>:"|?*`, a
 * backslash or a control character, one ending in a dot or a space, or a device name such as `con`
 * or `lpt1.txt`. The rules hold on every OS, so a target checked out anywhere holds every file.
 */
export function checkWrites(rels: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const rel of rels) {
    for (const segment of rel.split("/")) {
      const problem = windowsProblem(segment);
      if (problem !== undefined) throw new InputError(`written path "${rel}" ${problem}`);
    }
    const normal = posix.normalize(rel);
    const key = normal.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined) {
      throw new InputError(
        other === normal
          ? `two writes name the same path "${normal}"`
          : `written paths "${other}" and "${normal}" differ only by case`,
      );
    }
    seen.set(key, normal);
  }
}

/** Whether the manifest template embeds the whole provenance record as `"{{provenance}}"`. */
export function embedsProvenance(template: unknown): boolean {
  if (typeof template === "string") return /^\{\{\s*provenance\s*\}\}$/.test(template);
  if (Array.isArray(template)) return template.some(embedsProvenance);
  if (template !== null && typeof template === "object") {
    return Object.values(template).some(embedsProvenance);
  }
  return false;
}

/**
 * Refuses, before any paid call, a profile layout whose paths for this spec could never be written:
 * `media`, `manifest` and `provenance` are rendered from the spec and the profile, with each value
 * only known at hand-off standing in as its own name, and checked as the hand-off checks them.
 */
export function checkLayout(profile: TargetProfile, spec: AssetSpec): void {
  const layout = profile.layout as Partial<TargetProfile["layout"]> | undefined;
  if (typeof layout?.media !== "string" || typeof layout.manifest !== "string") return;
  const context = {
    spec: { ...spec.fields, ...spec },
    profile: { ...profile.values, name: profile.name },
  };
  const stub = (template: string) =>
    template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, path: string) => {
      const value = /^(spec|profile)\./.test(path) ? lookup(context, path) : undefined;
      if (value === undefined) return path;
      return typeof value === "string" ? value : JSON.stringify(value);
    });
  const media = stub(layout.media);
  const rels = [media, stub(layout.manifest)];
  if (typeof layout.provenance === "string") rels.push(stub(layout.provenance));
  else if (!embedsProvenance(profile.manifest)) rels.push(`${media}.provenance.json`);
  const git = rels.find(inGitDir);
  if (git !== undefined) throw new InputError(`profile layout path "${git}" writes into .git`);
  checkWrites(rels);
}

/** Whether a relative path has a `.git` segment, in any case. */
export function inGitDir(rel: string): boolean {
  return rel.split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git");
}
