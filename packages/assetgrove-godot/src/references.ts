/**
 * The files an existing resource references, put into scratch as data so Godot loads the resource
 * as the game does. Shared by the presets that load a resource the developer may have extended.
 */
import type { TargetRead } from "@clockgrove/assetgrove/extension";
import { externalReferences } from "./godot-text.ts";
import { GodotInputError, relativePath } from "./run.ts";

/** A text resource that can reference other files: its references reach scratch too. */
export const TEXT_RESOURCE = /\.(tres|tscn)$/;

/** A file Godot runs as code, or a binary resource that could embed it unseen. */
const CODE_FILE = /\.(gd|cs|gdextension|so|dll|dylib|res|scn)$/i;

/** A script resource type, in an `[ext_resource]` or `[sub_resource]` header. */
const SCRIPT_TYPE =
  /^\[(ext|sub)_resource\b[^\]]*\btype="(Script|GDScript|CSharpScript|GDExtension)"/;

/**
 * Refuses a text resource from the target that carries code: a script resource, or a `script`
 * property. Scratch runs Godot's editor, which runs a resource's tool script as it loads it, so the
 * game's code would run; the project never makes Assetgrove run its code.
 */
export function refuseCode(at: string, bytes: Uint8Array | string): void {
  const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
  for (const line of text.split(/\r?\n/))
    if (SCRIPT_TYPE.test(line) || /^script\s*=/.test(line))
      throw new GodotInputError(
        `${at} carries a script, and the pack never loads the project's code: remove the script from it, or hand off to a new resource`,
      );
}

/**
 * Puts every file an existing resource references into scratch as data, with its `.import`, so
 * Godot loads the resource as the game does; text resources are followed. A referenced file the
 * target lacks stays out, and Godot's load error fails the run. A path in `seen` (relative to the
 * project) is skipped: the caller already put it there, with the bytes it wants. Returns the
 * `res://` paths whose `.import` came along, which the editor must have imported before the build
 * loads anything. A resource that carries a script, or references a script, a native library or a
 * binary resource, is refused before anything runs (`refuseCode`).
 */
export async function dependencies(
  project: string,
  at: string,
  bytes: Uint8Array,
  read: TargetRead,
  files: Record<string, Uint8Array | string>,
  seen: Set<string>,
): Promise<string[]> {
  refuseCode(at, bytes);
  const imports: string[] = [];
  for (const reference of externalReferences(bytes)) {
    const res = reference.path;
    if (res === undefined || !res.startsWith("res://")) continue;
    const path = relativePath(res.slice("res://".length), `the referenced file ${res}`);
    if (CODE_FILE.test(path))
      throw new GodotInputError(
        `${at} references ${path}, which Godot would load as code or as a binary resource the pack cannot read, and the pack never loads the project's code`,
      );
    if (seen.has(path)) continue;
    seen.add(path);
    const target = project === "" ? path : `${project}/${path}`;
    const content = await read(target);
    if (content === undefined) continue;
    files[path] = content;
    const imported = await read(`${target}.import`);
    if (imported !== undefined) {
      files[`${path}.import`] = imported;
      imports.push(res);
    }
    if (TEXT_RESOURCE.test(path))
      imports.push(...(await dependencies(project, path, content, read, files, seen)));
  }
  return imports;
}
