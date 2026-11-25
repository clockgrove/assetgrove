/**
 * The files an existing resource references, put into scratch as data so Godot loads the resource
 * as the game does. Shared by the presets that load a resource the developer may have extended.
 */
import type { TargetRead } from "@clockgrove/assetgrove/extension";
import { externalReferences } from "./godot-text.ts";
import { relativePath } from "./run.ts";

/** A text resource that can reference other files: its references reach scratch too. */
export const TEXT_RESOURCE = /\.(tres|tscn)$/;

/**
 * Puts every file an existing resource references into scratch as data, with its `.import`, so
 * Godot loads the resource as the game does; text resources are followed. A referenced file the
 * target lacks stays out, and Godot's load error fails the run. A path in `seen` (relative to the
 * project) is skipped: the caller already put it there, with the bytes it wants. Returns the
 * `res://` paths whose `.import` came along, which the editor must have imported before the build
 * loads anything.
 */
export async function dependencies(
  project: string,
  bytes: Uint8Array,
  read: TargetRead,
  files: Record<string, Uint8Array | string>,
  seen: Set<string>,
): Promise<string[]> {
  const imports: string[] = [];
  for (const reference of externalReferences(bytes)) {
    const res = reference.path;
    if (res === undefined || !res.startsWith("res://")) continue;
    const at = relativePath(res.slice("res://".length), `the referenced file ${res}`);
    if (seen.has(at)) continue;
    seen.add(at);
    const target = project === "" ? at : `${project}/${at}`;
    const content = await read(target);
    if (content === undefined) continue;
    files[at] = content;
    const imported = await read(`${target}.import`);
    if (imported !== undefined) {
      files[`${at}.import`] = imported;
      imports.push(res);
    }
    if (TEXT_RESOURCE.test(at))
      imports.push(...(await dependencies(project, content, read, files, seen)));
  }
  return imports;
}
