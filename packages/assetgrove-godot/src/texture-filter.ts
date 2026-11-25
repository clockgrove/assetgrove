/**
 * The default texture filter warning of the 2D presets. A pixel-art game wants Nearest filtering,
 * and in Godot 4 that is a project setting (`rendering/textures/canvas_textures/default_texture_filter`),
 * not an import option. When the target profile's style is pixel art, the hand-off reads the
 * game's `project.godot` as data and warns when the setting is not Nearest. The pack never edits
 * `project.godot`.
 */
import type { TargetProfile, TargetRead } from "@clockgrove/assetgrove/extension";

const SECTION = "rendering";
const KEY = "textures/canvas_textures/default_texture_filter";
/** The setting as the Project Settings dialog names it, and as `project.godot` holds it. */
export const TEXTURE_FILTER_SETTING = `${SECTION}/${KEY}`;
const NEAREST = 0;
const LINEAR = 1;
const FILTER_NAMES = ["Nearest", "Linear", "Linear Mipmap", "Nearest Mipmap"];

const filterName = (value: number) => FILTER_NAMES[value] ?? "an unknown filter";

/** Whether the profile's style is pixel art: crisp edges with a palette colour rule. */
export function isPixelArt(profile: Pick<TargetProfile, "style">): boolean {
  return profile.style?.edges === "crisp" && profile.style.color?.rule === "palette";
}

/**
 * The default texture filter a `project.godot` sets: the integer under `[rendering]`, or
 * undefined when the file leaves it unset (Godot's default is then Linear). Lines are read as
 * data: `[section]` headers, `key=value` pairs and `;` comments; a value that is not an integer
 * counts as unset.
 */
export function defaultTextureFilter(content: string): number | undefined {
  let section = "";
  let value: number | undefined;
  for (const raw of content.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith(";")) continue;
    const header = /^\[([^\]]*)\]$/.exec(line);
    if (header !== null) {
      section = header[1]!.trim();
      continue;
    }
    if (section !== SECTION) continue;
    // Split at the first `=` without a pattern, so the read stays linear in the line's length.
    const equals = line.indexOf("=");
    if (equals <= 0 || line.slice(0, equals).trimEnd() !== KEY) continue;
    const text = line.slice(equals + 1).trim();
    value = /^-?\d+$/.test(text) ? Number(text) : undefined;
  }
  return value;
}

/**
 * The warning for a pixel-art profile whose project's default texture filter is not Nearest, as
 * one line in a list; none for another style, a project without a `project.godot`, or Nearest.
 * `project` is the Godot project's directory relative to the target.
 */
export async function textureFilterWarning(
  profile: Pick<TargetProfile, "style">,
  project: string,
  read: TargetRead,
): Promise<string[]> {
  if (!isPixelArt(profile)) return [];
  const path = project === "" ? "project.godot" : `${project}/project.godot`;
  const bytes = await read(path);
  if (bytes === undefined) return [];
  const value = defaultTextureFilter(new TextDecoder().decode(bytes));
  if (value === NEAREST) return [];
  const has =
    value === undefined
      ? `leaves ${TEXTURE_FILTER_SETTING} at Godot's default, ${filterName(LINEAR)} (${LINEAR})`
      : `sets ${TEXTURE_FILTER_SETTING} to ${filterName(value)} (${value})`;
  return [
    `${path} ${has}; a pixel-art profile (style.edges crisp, a palette) wants Nearest (${NEAREST}): set it in Project Settings > Rendering > Textures > Canvas Textures > Default Texture Filter, or add ${KEY}=${NEAREST} under [${SECTION}]`,
  ];
}
