/**
 * Where settings and the refusal rule read the environment: settings location, config and state homes, and the
 * variables that can redirect or unwrap the TLS carrying a key.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { SettingsError } from "./errors.ts";
import type { Settings } from "./settings.ts";

export type Env = Record<string, string | undefined>;

export { SettingsError };

/** The key variable each adapter reads by default; settings may name more with `keyEnv`. */
export const DEFAULT_KEY_ENV = [
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "TRIPO_API_KEY",
] as const;

/** The one spend variable read: the work item when `--work-item` names none. */
export const WORK_ITEM_ENV = "ASSETGROVE_WORK_ITEM";

/** The value of the key variable `name` as set, untrimmed; undefined when unset. */
export function keyValue(name: string, env: Env = process.env): string | undefined {
  return env[name];
}

/** `$ASSETGROVE_WORK_ITEM` as set, untrimmed; undefined when unset. */
export function workItemEnv(env: Env = process.env): string | undefined {
  return env["ASSETGROVE_WORK_ITEM"];
}

/**
 * Sets `CBOR_NATIVE_ACCELERATION_DISABLED` to `true` unless it is set, so cbor-x (which
 * `@auth0/cose` uses) never loads the optional `cbor-extract` native addon (src/pure-cbor.ts).
 */
export function disableNativeCbor(env: Env = process.env): void {
  env["CBOR_NATIVE_ACCELERATION_DISABLED"] ??= "true";
}

/** Whether `$GIT_DIR` is set to a non-empty value. */
export function gitDirSet(env: Env = process.env): boolean {
  return Boolean(env["GIT_DIR"]);
}

/**
 * The Windows search path: `PATH` and `PATHEXT` as set, each found case-insensitively since the
 * Windows environment is; undefined when unset.
 */
export function windowsSearchPath(env: Env = process.env): {
  path: string | undefined;
  pathext: string | undefined;
} {
  const lookup = (name: string): string | undefined => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name);
    return key === undefined ? undefined : env[key];
  };
  return { path: lookup("PATH"), pathext: lookup("PATHEXT") };
}

/** Variables that redirect or unwrap the TLS carrying a key; refused whatever is configured. */
export const TLS_PROXY_VARIABLES = [
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
] as const;

/** The AWS variables Lance's object store reads; refused when the search store is s3://. */
export const AWS_STORE_VARIABLES = [
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_S3",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ALLOW_HTTP",
] as const;

/** The Anthropic SDK's endpoint variable; refused when an anthropic adapter is configured. */
export const ANTHROPIC_BASE_URL_VARIABLE = "ANTHROPIC_BASE_URL";

/** The OpenAI SDK's endpoint variable; refused when an openai adapter is configured. */
export const OPENAI_BASE_URL_VARIABLE = "OPENAI_BASE_URL";

/**
 * Every variable that can redirect or unwrap the TLS carrying a key, or redirect search index data
 * (design section 7.2); each is refused in either case unless allowed, and the conditional ones
 * only when the configuration uses what reads them.
 */
export const REFUSED_VARIABLES = [
  ...TLS_PROXY_VARIABLES,
  ANTHROPIC_BASE_URL_VARIABLE,
  OPENAI_BASE_URL_VARIABLE,
  ...AWS_STORE_VARIABLES,
] as const;

/** What the configuration uses, so the variables only those read are refused only then. */
export interface EnvUses {
  s3Store: boolean;
  /** The adapter name of each configured provider. */
  adapters: readonly string[];
}

/** The uses of `settings`: an s3:// search store, and each provider's adapter (`adapter`, else its id). */
export function envUses(settings: Pick<Settings, "providers" | "search">): EnvUses {
  return {
    s3Store: settings.search?.store?.uri.startsWith("s3://") ?? false,
    adapters: Object.entries(settings.providers).map(([id, entry]) => entry.adapter ?? id),
  };
}

function inUse(name: string, uses: EnvUses | undefined): boolean {
  if (uses === undefined) return true;
  if ((AWS_STORE_VARIABLES as readonly string[]).includes(name)) return uses.s3Store;
  if (name === ANTHROPIC_BASE_URL_VARIABLE) return uses.adapters.includes("anthropic");
  if (name === OPENAI_BASE_URL_VARIABLE) return uses.adapters.includes("openai");
  return true;
}

/**
 * The set variables `checkEnvironment` would refuse, by the name they are set under. Without
 * `uses`, every variable is refused.
 */
export function refusedVariables(
  allow: readonly string[] = [],
  env: Env = process.env,
  uses?: EnvUses,
): string[] {
  const allowed = new Set(allow.map((name) => name.toUpperCase()));
  const refused: string[] = [];
  for (const name of REFUSED_VARIABLES) {
    if (allowed.has(name) || !inUse(name, uses)) continue;
    // One report per variable: on Windows the environment is case-insensitive, so both spellings
    // read the same value.
    const set = [name, name.toLowerCase()].find((variant) => env[variant]);
    if (set !== undefined) refused.push(set);
  }
  return refused;
}

/**
 * Throws `settings_invalid` when a refused variable is set and `environment.allow` does not list
 * it. Run at server start and before every command that sends a key.
 */
export function checkEnvironment(
  allow: readonly string[] = [],
  env: Env = process.env,
  uses?: EnvUses,
): void {
  const refused = refusedVariables(allow, env, uses);
  if (refused.length === 0) return;
  throw new SettingsError(
    `${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} set; each can redirect a key or index data, or unwrap the TLS that carries a key. Unset ${refused.length === 1 ? "it" : "them"}, or list ${refused.length === 1 ? "it" : "them"} in the settings file's environment.allow.`,
  );
}

/**
 * The environment without the variables `names`, matched case-insensitively (the Windows
 * environment is case-insensitive): what a command a developer wrote is started with, so it never
 * holds a key.
 */
export function withoutVariables(names: Iterable<string>, env: Env = process.env): Env {
  const removed = new Set([...names].map((name) => name.toUpperCase()));
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !removed.has(name.toUpperCase())),
  );
}

/** The environment with Git told to take no optional lock, so a read such as `ls-files` writes nothing in `.git`. */
export function gitReadOnlyEnv(env: Env = process.env): Env {
  return { ...env, GIT_OPTIONAL_LOCKS: "0" };
}

/** `$ASSETGROVE_CONFIG` when set (empty counts as unset). */
export function configOverride(env: Env = process.env): string | undefined {
  return env["ASSETGROVE_CONFIG"] || undefined;
}

/** The environment with `$ASSETGROVE_CONFIG` set to `path`, to load a settings file in trial. */
export function withConfigOverride(path: string, env: Env = process.env): Env {
  return { ...env, ASSETGROVE_CONFIG: path };
}

/** `$XDG_CONFIG_HOME` or `~/.config`; `%APPDATA%` on Windows. */
export function configHome(env: Env = process.env, platform: string = process.platform): string {
  if (platform === "win32" && env["APPDATA"] && isAbsolute(env["APPDATA"])) return env["APPDATA"];
  const xdg = env["XDG_CONFIG_HOME"];
  if (platform !== "win32" && xdg && isAbsolute(xdg)) return xdg;
  return join(homeDir(env), platform === "win32" ? join("AppData", "Roaming") : ".config");
}

/** `$XDG_STATE_HOME` or `~/.local/state`; `%LOCALAPPDATA%` on Windows. */
export function stateHome(env: Env = process.env, platform: string = process.platform): string {
  if (platform === "win32" && env["LOCALAPPDATA"] && isAbsolute(env["LOCALAPPDATA"])) {
    return env["LOCALAPPDATA"];
  }
  const xdg = env["XDG_STATE_HOME"];
  if (platform !== "win32" && xdg && isAbsolute(xdg)) return xdg;
  return join(
    homeDir(env),
    platform === "win32" ? join("AppData", "Local") : join(".local", "state"),
  );
}

/** The user's home directory: `$HOME`, else `%USERPROFILE%`, else the system's answer. */
export function homeDir(env: Env = process.env): string {
  const home = env["HOME"] || env["USERPROFILE"];
  return home && isAbsolute(home) ? home : homedir();
}

/**
 * Points `$ASSETGROVE_CONFIG` at `settingsPath` and unsets `$ASSETGROVE_WORK_ITEM` and every
 * refused variable (in either spelling), so a command run in this process reads only that settings
 * file; returns a function that puts back what each held. The test kit's temporary project
 * (src/testing/project.ts) holds the environment so while it is open.
 */
export function isolateForSettings(settingsPath: string, env: Env = process.env): () => void {
  const saved = {
    config: env["ASSETGROVE_CONFIG"],
    workItem: env["ASSETGROVE_WORK_ITEM"],
    refused: new Map<string, string | undefined>(),
  };
  env["ASSETGROVE_CONFIG"] = settingsPath;
  delete env["ASSETGROVE_WORK_ITEM"];
  for (const name of REFUSED_VARIABLES)
    for (const variant of [name, name.toLowerCase()]) {
      if (!saved.refused.has(variant)) saved.refused.set(variant, env[variant]);
      delete env[variant];
    }
  return () => {
    if (saved.config === undefined) delete env["ASSETGROVE_CONFIG"];
    else env["ASSETGROVE_CONFIG"] = saved.config;
    if (saved.workItem === undefined) delete env["ASSETGROVE_WORK_ITEM"];
    else env["ASSETGROVE_WORK_ITEM"] = saved.workItem;
    for (const [variant, value] of saved.refused) {
      if (value === undefined) delete env[variant];
      else env[variant] = value;
    }
  };
}
