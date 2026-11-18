/**
 * The registry of asset kinds, hand-off presets and provider adapters (design section 11). Core
 * registers its own (src/extensions/core.ts); an extension package is loaded only when the
 * developer settings' `extensions` list names it, it resolves from the project, its declared `api`
 * is one core speaks and its peer range on `@clockgrove/assetgrove` admits core's version (both read
 * from its package.json before anything is imported, src/extensions/version.ts), and the project's
 * Git does not track its entry file. A package.json dependency or a shared file alone never loads anything.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { EXTENSION_API } from "../extension/api.ts";
import { createExtensionContext } from "../extension/context.ts";
import type {
  AssetKind,
  EnginePreset,
  Extension,
  ExtensionContext,
  ProviderAdapter,
  SearchSlot,
} from "../extension/api.ts";
import { SettingsError } from "../env.ts";
import { FRAMES_TRAITS } from "../frames.ts";
import { checkKindSchemas } from "../kind-schemas.ts";
import { OPERATION_ROLES, ROLE_CAPABILITY } from "../routes.ts";
import type { Settings } from "../settings.ts";
import { CORE_EXTENSION_NAME, coreExtension } from "./core.ts";
import { compatibilityProblem, CORE_PACKAGE, coreVersion } from "./version.ts";
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
  /** True when the extension fills the search slot. */
  search?: true;
}

/** The package that fills the search slot, named when a search-only command is refused. */
export const SEARCH_PACKAGE = "@clockgrove/assetgrove-search";

const EXTENSION_NAME = /^[a-z][a-z0-9-]*$/;
/** An npm package name, with no path parts beyond its scope. */
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Every kind, preset and adapter of core and the loaded extensions. */
export class ExtensionRegistry {
  readonly loaded: readonly LoadedExtension[];
  readonly kinds: readonly AssetKind[];
  readonly presets: ReadonlyMap<string, EnginePreset>;
  readonly adapters: readonly ProviderAdapter[];
  /** The search slot (design section 7.1), when a loaded extension fills it. */
  readonly search: SearchSlot | undefined;
  /** The settings file, named when an id's extension is not loaded. */
  readonly settingsPath: string | undefined;
  /** Every operation with its role: core's table plus the operations the kinds declare. */
  readonly operations: Readonly<Record<string, string>>;

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
    let search: { slot: SearchSlot; by: string } | undefined;
    const operations: Record<string, string> = { ...OPERATION_ROLES };
    const declared = new Map<string, { role: string; by: string }>();
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
      for (const k of extension.kinds ?? []) {
        add(kinds, "asset kind", k.kind, k, extension.name);
        for (const [op, role] of Object.entries(k.operations ?? {})) {
          if (extension.name === CORE_EXTENSION_NAME && OPERATION_ROLES[op] !== role)
            throw new ExtensionError(
              "extension_conflict",
              `kind "${k.kind}" of core declares operation "${op}" with role "${role}", which core's operations do not have`,
            );
          const before = declared.get(op);
          if (before !== undefined && before.role !== role)
            throw new ExtensionError(
              "extension_conflict",
              `operation "${op}" is declared with role "${role}" by kind "${k.kind}" and role "${before.role}" by "${before.by}"`,
            );
          declared.set(op, { role, by: k.kind });
          operations[op] = role;
        }
      }
      for (const p of extension.presets ?? []) add(presets, "preset", p.name, p, extension.name);
      for (const a of extension.adapters ?? []) add(adapters, "adapter", a.id, a, extension.name);
      if (extension.search !== undefined) {
        if (search !== undefined)
          throw new ExtensionError(
            "extension_conflict",
            `the search slot of extension "${extension.name}" is already filled by "${search.by}"`,
          );
        search = { slot: extension.search, by: extension.name };
      }
      loaded.push({
        name: extension.name,
        ...info,
        kinds: (extension.kinds ?? []).map((k) => k.kind),
        presets: (extension.presets ?? []).map((p) => p.name),
        adapters: (extension.adapters ?? []).map((a) => a.id),
        ...(extension.search !== undefined && { search: true as const }),
      });
    }
    this.loaded = loaded;
    this.kinds = [...kinds.values()];
    this.presets = presets;
    this.adapters = [...adapters.values()];
    this.search = search?.slot;
    this.settingsPath = settingsPath;
    this.operations = operations;
  }

  /**
   * Throws `SettingsError` (exit 2 `settings_invalid`) for a `settings.routes` key of a loaded
   * extension that no kind declares. A key of an extension that is not loaded is left alone.
   */
  checkRoutes(settings: Pick<Settings, "routes" | "path">): void {
    for (const key of Object.keys(settings.routes)) {
      const name = extensionOf(key);
      if (name === undefined || name === CORE_EXTENSION_NAME) continue;
      if (!this.loaded.some((l) => l.name === name) || Object.hasOwn(this.operations, key))
        continue;
      const declared = Object.keys(this.operations).filter((op) => extensionOf(op) === name);
      throw new SettingsError(
        `settings.routes[${JSON.stringify(key)}] of ${settings.path} routes an operation extension "${name}" does not declare; its kinds declare: ${declared.length > 0 ? declared.join(", ") : "none"}`,
      );
    }
  }

  /**
   * Throws `extension_unavailable` for an `<ext>:<name>` asset kind no loaded extension provides;
   * an unknown core kind is left to the stage plan (`invalid_input`).
   */
  requireKind(kind: string): void {
    if (extensionOf(kind) !== undefined && !this.kinds.some((k) => k.kind === kind))
      throw unavailableId(kind, "asset kind", this.settingsPath);
  }

  /**
   * The search slot; throws `extension_unavailable` naming the settings line that would load it
   * when no loaded extension fills it (design section 7.1).
   */
  requireSearch(command: string): SearchSlot {
    if (this.search !== undefined) return this.search;
    const where = this.settingsPath ?? "the developer settings";
    throw new ExtensionError(
      "extension_unavailable",
      `${command} needs the search package, which is not loaded; add "${SEARCH_PACKAGE}" to the extensions list in ${where} (install it in the project first)`,
    );
  }
}

/** Core's own entry in a registry: its extension and package. */
export const CORE_ENTRY = {
  extension: coreExtension,
  info: { package: CORE_PACKAGE, version: coreVersion(), entry: null },
};

/** Core alone, for code that runs without loaded settings (tests, library use). */
export const CORE_REGISTRY: ExtensionRegistry = new ExtensionRegistry([CORE_ENTRY]);

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

/** The package's directory, found the way Node resolves a bare name from `cwd`. */
export function resolvePackage(name: string, cwd: string): string | undefined {
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
  peerDependencies?: unknown;
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
  const problem = compatibilityProblem(declared.api, manifest.peerDependencies, coreVersion());
  if (problem !== undefined) throw new ExtensionError("extension_refused", `${line} ${problem}`);
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
  const context: ExtensionContext = createExtensionContext(name);
  let exported: unknown;
  try {
    exported =
      typeof module.default === "function"
        ? await (module.default as (c: ExtensionContext) => unknown)(context)
        : module.default;
  } catch (error) {
    // An extension that cannot run here (the search package on darwin-x64) says so itself.
    if ((error as { code?: unknown } | null)?.code === "extension_unavailable")
      throw new ExtensionError("extension_unavailable", `${line}: ${messageOf(error)}`, {
        cause: error,
      });
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
export function checkExtension(value: unknown, line: string): Extension {
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
  for (const kind of ext.kinds ?? []) {
    const checks = (kind as { checks?: unknown }).checks;
    if (checks === undefined) continue;
    if (!Array.isArray(checks)) throw refuse(`the checks of kind ${kind.kind} must be a list`);
    for (const check of checks as Array<Record<string, unknown> | null>) {
      if (
        typeof check?.["name"] !== "string" ||
        (check["mode"] !== "exact" && check["mode"] !== "judged") ||
        typeof check["run"] !== "function"
      )
        throw refuse(
          `every check of kind ${kind.kind} must have a name, a mode "exact" or "judged" and a run function`,
        );
    }
  }
  for (const kind of ext.kinds ?? []) {
    const frames = (kind as { frames?: unknown }).frames;
    if (frames !== undefined && !(FRAMES_TRAITS as readonly unknown[]).includes(frames))
      throw refuse(
        `kind ${kind.kind} declares frames ${JSON.stringify(frames)}; a kind's frames are ${FRAMES_TRAITS.map((t) => JSON.stringify(t)).join(" or ")}`,
      );
    checkKindSchemas(kind, refuse);
    const operations = (kind as { operations?: unknown }).operations;
    if (operations === undefined) continue;
    if (operations === null || typeof operations !== "object" || Array.isArray(operations))
      throw refuse(`the operations of kind ${kind.kind} must be an object of operation to role`);
    for (const [op, role] of Object.entries(operations)) {
      if (!op.startsWith(`${ext.name}:`) || op.length <= ext.name.length + 1)
        throw refuse(
          `the operations of kind ${kind.kind} must be named "${ext.name}:<op>", got ${JSON.stringify(op)}`,
        );
      if (typeof role !== "string" || !Object.hasOwn(ROLE_CAPABILITY, role))
        throw refuse(
          `operation "${op}" of kind ${kind.kind} has role ${JSON.stringify(role)}; the roles are ${Object.keys(ROLE_CAPABILITY).join(", ")}`,
        );
    }
  }
  if (ext.search !== undefined) {
    const slot = ext.search as unknown as Record<string, unknown> | null;
    for (const op of ["find", "index", "status", "setup"])
      if (slot === null || typeof slot !== "object" || typeof slot[op] !== "function")
        throw refuse(`its search slot must have a ${op} function`);
  }
  return ext as Extension;
}

/**
 * Core and every extension the settings list, each loaded from the project at `cwd`. Throws an
 * `ExtensionError` (exit 2) for a listed package that does not resolve (`extension_unavailable`),
 * one core will not load (`extension_refused`), or a repeated name or id (`extension_conflict`).
 */
export async function loadExtensions(
  settings: Pick<Settings, "extensions" | "path"> & Partial<Pick<Settings, "routes">>,
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
  const registry = new ExtensionRegistry([CORE_ENTRY, ...loaded], settings.path);
  if (settings.routes !== undefined)
    registry.checkRoutes({ routes: settings.routes, path: settings.path });
  return registry;
}
