/**
 * Path rules for every OS (design section 14). Relative paths in records and JSON output use `/`,
 * and readers accept `/` only. A set of writes in which two name the same file or differ only by
 * case, or a written path segment Windows cannot hold, is refused as invalid input before anything
 * is written, so a run behaves the same on case-insensitive file systems and on Windows, where `:`
 * names an alternate data stream. Long paths need nothing here: on Windows, Node's fs namespaces
 * absolute paths itself.
 */
import { posix, relative, resolve, sep } from "node:path";
import { InputError } from "./errors.ts";
import { DEFAULT_HANDOFF } from "./handoff/presets/index.ts";
import { lookup } from "./template.ts";
import { libraryConfig, within } from "./library/write.ts";
import { libraryPath } from "./library/paths.ts";
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

/** The shared layout with this kind's media and optional manifest override. */
export function layoutFor(profile: TargetProfile, kind: string): TargetProfile["layout"] {
  const override = profile.kinds?.[kind]?.layout;
  return override === undefined ? profile.layout : { ...profile.layout, ...override };
}

/** Checks only overridden fields; the library root always comes from the global layout. */
export function checkKindLayoutPaths(
  profile: TargetProfile,
  kind: string,
  render: (template: string) => string = (template) => template.replace(/\{\{[^{}]*\}\}/g, "value"),
  targetDir?: string,
): void {
  const override = profile.kinds?.[kind]?.layout;
  if (override === undefined) return;
  const base = resolve(targetDir ?? ".");
  const root = libraryConfig(profile, base).root;
  for (const field of ["media", "manifest"] as const) {
    const template = override[field];
    if (template === undefined) continue;
    const path = render(template);
    const normalized = path.replaceAll("\\", "/");
    if (
      posix.isAbsolute(normalized) ||
      /^[a-z]:/i.test(normalized) ||
      !within(root, resolve(base, normalized)) ||
      resolve(base, normalized) === root
    ) {
      throw new InputError(`kinds.${kind}.layout.${field} path "${path}" leaves the library root`);
    }
    if (targetDir !== undefined) {
      libraryPath(root, base, path, `kinds.${kind}.layout.${field}`);
    }
  }
}

const SPEC_VALUE = /\{\{\s*spec\.([\w.-]+)(\?)?\s*\}\}/g;
const WHOLE_OPTIONAL = /^\{\{\s*[\w.-]+\?\s*\}\}$/;

/**
 * Refuses a profile whose layout (`media`, `manifest`, `provenance`) or manifest template names a
 * spec value this spec does not set, as `layout.media needs spec.animationFamily`. The manifest
 * template is checked only when the profile's hand-off lists the `manifest` preset, the one preset
 * that renders it. A whole-string `"{{spec.x?}}"` in the manifest is optional and passes. The hand-off renders the same values, so
 * this refusal comes before any paid call instead of as a render error at pick.
 */
export function checkSpecValues(profile: TargetProfile, spec: AssetSpec): void {
  const values = { ...spec.fields, ...spec };
  const check = (field: string, template: unknown): void => {
    if (typeof template === "string") {
      if (WHOLE_OPTIONAL.test(template)) return;
      // Inline, `{{spec.x?}}` is not a template value and renders as written.
      for (const [, path, optional] of template.matchAll(SPEC_VALUE)) {
        if (path !== undefined && !optional && lookup(values, path) === undefined) {
          throw new InputError(`${field} needs spec.${path}, which the spec does not set`);
        }
      }
    } else if (Array.isArray(template)) {
      template.forEach((item, i) => check(`${field}.${i}`, item));
    } else if (template !== null && typeof template === "object") {
      for (const [key, item] of Object.entries(template)) check(`${field}.${key}`, item);
    }
  };
  const layout = layoutFor(profile, spec.kind) as Partial<TargetProfile["layout"]> | undefined;
  for (const key of ["media", "manifest", "provenance"] as const) {
    if (typeof layout?.[key] === "string") {
      const overridden =
        key !== "provenance" && profile.kinds?.[spec.kind]?.layout?.[key] !== undefined;
      check(overridden ? `kinds.${spec.kind}.layout.${key}` : `layout.${key}`, layout[key]);
    }
  }
  const handoff: unknown = profile.handoff ?? DEFAULT_HANDOFF;
  const rendersManifest =
    Array.isArray(handoff) &&
    handoff.some(
      (entry: unknown) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { preset?: unknown }).preset === "manifest",
    );
  if (rendersManifest) check("manifest", profile.manifest);
}

/**
 * Refuses, before any paid call, a profile layout whose paths for this spec could never be written:
 * `media`, `manifest` and `provenance` are rendered from the spec and the profile, with each value
 * only known at hand-off standing in as its own name, and checked as the hand-off checks them.
 */
export function checkLayout(profile: TargetProfile, spec: AssetSpec): void {
  checkSpecValues(profile, spec);
  const layout = layoutFor(profile, spec.kind) as Partial<TargetProfile["layout"]> | undefined;
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
  checkKindLayoutPaths(profile, spec.kind, stub);
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
