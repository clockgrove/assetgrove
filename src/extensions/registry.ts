/**
 * The registry of asset kinds, hand-off presets and provider adapters (design section 11). Core
 * registers its own (src/extensions/core.ts); an extension package is loaded only when the
 * developer settings' `extensions` list names it, it resolves from the project, its declared `api`
 * matches (read from its package.json before anything is imported), and the project's Git does not
 * track its entry file. A package.json dependency or a shared file alone never loads anything.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { EXTENSION_API } from "../extension/api.ts";
import type {
  AssetKind,
  EnginePreset,
  Extension,
  ExtensionContext,
  ProviderAdapter,
} from "../extension/api.ts";
import type { Settings } from "../settings.ts";
import { CORE_EXTENSION_NAME, coreExtension } from "./core.ts";
import { ExtensionError, extensionOf, unavailableId } from "./errors.ts";

export { ExtensionError, unavailableId } from "./errors.ts";

/** One loaded extension as `extensions` lists it. */
export interface LoadedExtension {
  name: string;
  /** The package it came from; core is this package. */
  package: string;
  version: string | null;
  /** The entry file's absolute path; null for core. */
  entry: string | null;
  kinds: string[];
  presets: string[];
  adapters: string[];
}

const EXTENSION_NAME = /^[a-z][a-z0-9-]*$/;
/** An npm package name, with no path parts beyond its scope. */
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Every kind, preset and adapter of core and the loaded extensions. */
export class ExtensionRegistry {
  readonly loaded: readonly LoadedExtension[];
  readonly kinds: readonly AssetKind[];
  readonly presets: ReadonlyMap<string, EnginePreset>;
  readonly adapters: readonly ProviderAdapter[];
  /** The settings file, named when an id's extension is not loaded. */
  readonly settingsPath: string | undefined;

  constructor(
    extensions: ReadonlyArray<{
      extension: Extension;
      info: Omit<LoadedExtension, "name" | "kinds" | "presets" | "adapters">;
    }>,
    settingsPath?: string,
  ) {
    const names = new Set<string>();
    const kinds = new Map<string, AssetKind>();
    const presets = new Map<string, EnginePreset>();
    const adapters = new Map<string, ProviderAdapter>();
    const loaded: LoadedExtension[] = [];
    const add = <T>(table: Map<string, T>, what: string, id: string, value: T, ext: string) => {
      if (table.has(id))
        throw new ExtensionError(
          "extension_conflict",
          `${what} "${id}" of extension "${ext}" is already registered`,
        );
      table.set(id, value);
    };
    for (const { extension, info } of extensions) {
      if (names.has(extension.name))
        throw new ExtensionError(
          "extension_conflict",
          `two extensions are named "${extension.name}" (the second from ${info.package})`,
        );
      names.add(extension.name);
      for (const k of extension.kinds ?? []) add(kinds, "asset kind", k.kind, k, extension.name);
      for (const p of extension.presets ?? []) add(presets, "preset", p.name, p, extension.name);
      for (const a of extension.adapters ?? []) add(adapters, "adapter", a.id, a, extension.name);
      loaded.push({
        name: extension.name,
        ...info,
        kinds: (extension.kinds ?? []).map((k) => k.kind),
        presets: (extension.presets ?? []).map((p) => p.name),
        adapters: (extension.adapters ?? []).map((a) => a.id),
      });
    }
    this.loaded = loaded;
    this.kinds = [...kinds.values()];
    this.presets = presets;
    this.adapters = [...adapters.values()];
    this.settingsPath = settingsPath;
  }

  /**
   * Throws `extension_unavailable` for an `<ext>:<name>` asset kind no loaded extension provides;
   * an unknown core kind is left to the stage plan (`invalid_input`).
   */
  requireKind(kind: string): void {
    if (extensionOf(kind) !== undefined && !this.kinds.some((k) => k.kind === kind))
      throw unavailableId(kind, "asset kind", this.settingsPath);
  }
}

function coreVersion(): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

const CORE_ENTRY = {
  extension: coreExtension,
  info: { package: "@clockgrove/assetgrove", version: coreVersion(), entry: null },
};

/** Core alone, for code that runs without loaded settings (tests, library use). */
export const CORE_REGISTRY: ExtensionRegistry = new ExtensionRegistry([CORE_ENTRY]);

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

/** The package's directory, found the way Node resolves a bare name from `cwd`. */
function resolvePackage(name: string, cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Whether any Git work tree at or above the file at each of `paths` tracks it: the repository
 * holding the entry is asked, and every one around it (an outer project of a nested repository or
 * a linked worktree), not only the cwd's.
 */
function trackedByAnyProject(paths: readonly string[]): boolean {
  for (const path of new Set(paths)) {
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      if (existsSync(join(dir, ".git"))) {
        const rel = relative(dir, path);
        const result = spawnSync("git", ["ls-files", "-z", "--", rel], {
          cwd: dir,
          encoding: "utf8",
        });
        if (result.status !== 0 || result.error) {
          throw new ExtensionError(
            "extension_refused",
            `cannot ask Git whether ${dir} tracks ${rel}`,
          );
        }
        if (result.stdout.length > 0) return true;
      }
      if (dirname(dir) === dir) break;
    }
  }
  return false;
}

interface Manifest {
  version?: unknown;
  assetgrove?: { api?: unknown; entry?: unknown };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Checks one listed package and imports its entry; every refusal is before the import. */
async function loadOne(
  name: string,
  index: number,
  cwd: string,
  settingsPath: string,
): Promise<{
  extension: Extension;
  info: Omit<LoadedExtension, "name" | "kinds" | "presets" | "adapters">;
}> {
  const line = `extensions[${index}] "${name}" of ${settingsPath}`;
  if (!PACKAGE_NAME.test(name)) {
    throw new ExtensionError("extension_unavailable", `${line} is not a package name`);
  }
  const dir = resolvePackage(name, cwd);
  if (dir === undefined) {
    throw new ExtensionError(
      "extension_unavailable",
      `${line} does not resolve from the project ${cwd}: install the package there, or remove it from the list`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch (error) {
    throw new ExtensionError("extension_refused", `${line}: its package.json cannot be read`, {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ExtensionError("extension_refused", `${line}: its package.json is not a JSON object`);
  }
  const manifest = parsed as Manifest;
  const declared = manifest.assetgrove;
  if (declared === null || typeof declared !== "object") {
    throw new ExtensionError(
      "extension_refused",
      `${line}: its package.json declares no "assetgrove": {"api", "entry"}`,
    );
  }
  if (declared.api !== EXTENSION_API) {
    throw new ExtensionError(
      "extension_refused",
      `${line} declares extension api ${JSON.stringify(declared.api)}; this Assetgrove loads api ${EXTENSION_API}`,
    );
  }
  if (typeof declared.entry !== "string" || declared.entry === "") {
    throw new ExtensionError("extension_refused", `${line}: assetgrove.entry must name a file`);
  }
  const entry = resolve(dir, declared.entry);
  const realDir = realpathSync.native(dir);
  let realEntry: string;
  try {
    realEntry = realpathSync.native(entry);
  } catch (error) {
    throw new ExtensionError("extension_refused", `${line}: its entry ${entry} does not exist`, {
      cause: error,
    });
  }
  if (!isInside(realEntry, realDir) || !statSync(realEntry).isFile()) {
    throw new ExtensionError(
      "extension_refused",
      `${line}: its entry ${declared.entry} must be a file inside the package`,
    );
  }
  if (trackedByAnyProject([entry, realEntry])) {
    throw new ExtensionError(
      "extension_refused",
      `${line}: the project's Git tracks its entry ${entry}, so the project could supply its code; install it as a dependency instead of committing it`,
    );
  }
  // A failing import or factory is refused naming the settings line and the package.
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(realEntry).href)) as { default?: unknown };
  } catch (error) {
    throw new ExtensionError(
      "extension_refused",
      `${line}: importing its entry ${realEntry} failed: ${messageOf(error)}`,
      { cause: error },
    );
  }
  const context: ExtensionContext = { api: EXTENSION_API, z };
  let exported: unknown;
  try {
    exported =
      typeof module.default === "function"
        ? await (module.default as (c: ExtensionContext) => unknown)(context)
        : module.default;
  } catch (error) {
    throw new ExtensionError(
      "extension_refused",
      `${line}: its entry's default export threw: ${messageOf(error)}`,
      { cause: error },
    );
  }
  const extension = checkExtension(exported, line);
  return {
    extension,
    info: {
      package: name,
      version: typeof manifest.version === "string" ? manifest.version : null,
      entry: realEntry,
    },
  };
}

/** The entry's extension, refused unless its shape and every id hold. */
function checkExtension(value: unknown, line: string): Extension {
  const refuse = (why: string) => new ExtensionError("extension_refused", `${line}: ${why}`);
  if (value === null || typeof value !== "object")
    throw refuse("its entry's default export is not an extension");
  const ext = value as Partial<Extension>;
  if (ext.api !== EXTENSION_API)
    throw refuse(`its extension declares api ${JSON.stringify(ext.api)}, not ${EXTENSION_API}`);
  if (typeof ext.name !== "string" || !EXTENSION_NAME.test(ext.name))
    throw refuse("its extension name must be lower-case letters, digits and hyphens");
  if (ext.name === CORE_EXTENSION_NAME)
    throw new ExtensionError("extension_conflict", `${line}: the name "core" is core's`);
  const ids: Array<[string, unknown[] | undefined, string]> = [
    ["kinds", ext.kinds, "kind"],
    ["presets", ext.presets, "name"],
    ["adapters", ext.adapters, "id"],
  ];
  for (const [field, list, key] of ids) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw refuse(`its ${field} must be a list`);
    for (const item of list) {
      const id = (item as Record<string, unknown> | null)?.[key];
      if (
        typeof id !== "string" ||
        !id.startsWith(`${ext.name}:`) ||
        id.length <= ext.name.length + 1
      )
        throw refuse(
          `every id of its ${field} must be "${ext.name}:<name>", got ${JSON.stringify(id)}`,
        );
    }
  }
  return ext as Extension;
}

/**
 * Core and every extension the settings list, each loaded from the project at `cwd`. Throws an
 * `ExtensionError` (exit 2) for a listed package that does not resolve (`extension_unavailable`),
 * one core will not load (`extension_refused`), or a repeated name or id (`extension_conflict`).
 */
export async function loadExtensions(
  settings: Pick<Settings, "extensions" | "path">,
  cwd: string = process.cwd(),
): Promise<ExtensionRegistry> {
  const listed = settings.extensions;
  const seen = new Set<string>();
  for (const [i, name] of listed.entries()) {
    if (seen.has(name))
      throw new ExtensionError(
        "extension_conflict",
        `extensions[${i}] "${name}" of ${settings.path} is listed twice`,
      );
    seen.add(name);
  }
  const loaded = [];
  for (const [i, name] of listed.entries()) loaded.push(await loadOne(name, i, cwd, settings.path));
  return new ExtensionRegistry([CORE_ENTRY, ...loaded], settings.path);
}
