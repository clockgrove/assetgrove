import { checkDeclaredView } from "./model3d/views.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadBible } from "./bible.ts";
import { styleBibleOf } from "./bible-view.ts";
import { InputError } from "./errors.ts";
import { readFormat } from "./formats.ts";
import {
  identitySettings,
  identitySettingsWithRecord,
  loadCast,
  loadIdentity,
} from "./identity.ts";
import { readJson } from "./json.ts";
import { parseDigitalSourceType } from "./metadata.ts";
import type { DigitalSourceType } from "./metadata.ts";
import type { SliceOptions } from "./sheet/types.ts";
import { validateProfile } from "./profile.ts";
import { resolveStyle } from "./style.ts";
import { readRecipe } from "./transform/run.ts";
import type { Recipe } from "./transform/types.ts";
import type { AssetSpec, StyleBible, TargetProfile } from "./types.ts";

export { readJson } from "./json.ts";

/*
 * Shared files (target profile, style bible, style preset, recipe) load here: each must carry its
 * format line (`readFormat`, exit 2 `format_unsupported`) and pass its validator. Request inputs
 * (specs, briefs, groupings) carry none and load with `readJson`.
 */

/** A target profile file: format line `assetgrove-target-profile/<n>` and its top-level fields. */
export async function loadProfile(path: string): Promise<{ value: TargetProfile; dir: string }> {
  const { value, dir } = await readJson<unknown>(path);
  const current = readFormat("target-profile", value, path).value;
  return { value: validateProfile(current, path), dir };
}

/**
 * The style bible every generation command reads: BIBLE.md, the one style bible, as `init` writes
 * it. It is loaded and validated as `plan` loads it, and its style view (`styleBibleOf`) is
 * returned with every reference's declared view checked (exit 2 before any provider call). A JSON
 * file is refused, naming BIBLE.md: there is no other style bible format.
 */
export async function loadStyleBible(path: string): Promise<{ value: StyleBible; dir: string }> {
  let source: string;
  try {
    source = await readFile(resolve(path), "utf8");
  } catch (error) {
    throw new InputError(`cannot read style bible ${resolve(path)}`, { cause: error });
  }
  if (/^\s*[{[]/.test(source)) {
    throw new InputError(
      `style bible ${resolve(path)} is JSON; Assetgrove reads only BIBLE.md, the Markdown style bible that \`assetgrove init\` writes (docs/target-profile.md#style-bible)`,
    );
  }
  const doc = await loadBible(path);
  const bible = styleBibleOf(doc);
  for (const reference of bible.references) checkDeclaredView(reference, doc.path);
  return { value: bible, dir: doc.dir };
}

/** A recipe file: format line `assetgrove-recipe/<n>`, then the recipe's own validation. */
export async function loadRecipe(path: string): Promise<Recipe> {
  return readRecipe((await readJson<unknown>(path)).value, path);
}

/** The bytes of a file; an unreadable file is an InputError naming what it is. */
export async function readBytes(path: string, what: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    throw new InputError(`cannot read ${what} ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/** A 3D model file's bytes and path. */
export async function readModel(path: string): Promise<{ bytes: Uint8Array; path: string }> {
  try {
    return { bytes: new Uint8Array(await readFile(path)), path };
  } catch {
    throw new InputError(`cannot read the model ${path}`);
  }
}

/**
 * The identity lock of `subject` from `--lock-bible`, with the run's identity settings
 * (`--identity-mode` over the profile's). Undefined when the subject has no lock or scoring is off.
 * `recordPath` is the bible's identity-thresholds.json when its threshold is the one used, for the
 * request to hash among its reads: a re-recorded threshold then changes the request.
 */
export async function lockFor(
  lockBible: string | undefined,
  identityMode: string | undefined,
  subject: string,
  profile: TargetProfile,
  routes: Record<string, { model: string }>,
) {
  identitySettings(profile, identityMode);
  if (lockBible === undefined) {
    if (identityMode !== undefined)
      throw new InputError("--identity-mode needs --lock-bible <BIBLE.md>");
    return undefined;
  }
  const doc = await loadBible(lockBible);
  const loaded = await loadIdentity(doc, subject);
  if (!loaded) return undefined;
  const { settings, recordPath } = await identitySettingsWithRecord(
    profile,
    identityMode,
    doc,
    routes,
  );
  if (settings.mode === "off") return undefined;
  return {
    ...loaded,
    settings,
    ...(recordPath !== undefined && { recordPath }),
    ...(settings.question === "cast" && { cast: await loadCast(doc) }),
  };
}

/**
 * The subject, gait, family and motion template an asset spec given with `--spec` declares, for
 * animation QA. The gait picks each motion template's rule for it (the spec's over the profile's
 * `animation.gait`); the template is the one its `animationFamily` is judged by.
 */
export async function specForQa(
  specPath: string | undefined,
): Promise<{ subject?: string; gait?: string; family?: string; template?: string }> {
  if (specPath === undefined) return {};
  const spec = (await readJson<AssetSpec>(specPath)).value;
  if (spec.gait !== undefined && typeof spec.gait !== "string") {
    throw new InputError(`the spec's gait must be text, for example "quadruped"`);
  }
  if (spec.template !== undefined && typeof spec.template !== "string") {
    throw new InputError(`the spec's template must be a motion template's name, or "none"`);
  }
  return {
    ...(typeof spec.subject === "string" && { subject: spec.subject }),
    ...(spec.gait !== undefined && { gait: spec.gait }),
    ...(typeof spec.animationFamily === "string" && { family: spec.animationFamily }),
    ...(spec.template !== undefined && { template: spec.template }),
  };
}

/** The style and frame size a target profile supplies to a transformation, when it has them. */
export async function profileContext(path: string | undefined) {
  if (path === undefined) return {};
  const profile = (await loadProfile(path)).value;
  const frames = profile.frames as Partial<TargetProfile["frames"]> | undefined;
  return {
    ...(profile.style !== undefined && { style: resolveStyle(profile.style) }),
    ...(frames?.width !== undefined &&
      frames.height !== undefined && { frame: { width: frames.width, height: frames.height } }),
  };
}

/** The IPTC digital source type of `--digital-source-type`, when given. */
export function declarationOption(code: string | undefined): DigitalSourceType | undefined {
  if (code === undefined) return undefined;
  const value = parseDigitalSourceType(code);
  if (!value) throw new InputError(`invalid --digital-source-type: ${code}`);
  return value;
}

/** How to slice a sheet: by `--components`, a `--grid` of columns or detection, with a count. */
export function sliceOptions(
  grid: number | undefined,
  components: boolean | undefined,
  count: number | undefined,
): SliceOptions {
  const counted = count !== undefined ? { count } : {};
  if (components) return { components: true, ...counted };
  if (grid === undefined) return counted;
  return { grid: { columns: grid }, ...counted };
}
