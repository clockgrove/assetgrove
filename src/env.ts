/**
 * Where settings and the refusal rule read the environment: settings location, config and state homes, and the
 * variables that can redirect or unwrap the TLS carrying a key.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { SettingsError } from "./errors.ts";

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

/**
 * Variables that redirect or unwrap the TLS carrying a key (a CA, the system CA store, TLS checks
 * off, a proxy) or the provider SDKs' endpoint variables; each is refused in either case unless
 * allowed.
 */
export const REFUSED_VARIABLES = [
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
] as const;

/** The set variables `checkEnvironment` would refuse, by the name they are set under. */
export function refusedVariables(allow: readonly string[] = [], env: Env = process.env): string[] {
  const allowed = new Set(allow.map((name) => name.toUpperCase()));
  const refused: string[] = [];
  for (const name of REFUSED_VARIABLES) {
    if (allowed.has(name)) continue;
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
export function checkEnvironment(allow: readonly string[] = [], env: Env = process.env): void {
  const refused = refusedVariables(allow, env);
  if (refused.length === 0) return;
  throw new SettingsError(
    `${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} set; each can redirect a key or unwrap the TLS that carries it. Unset ${refused.length === 1 ? "it" : "them"}, or list ${refused.length === 1 ? "it" : "them"} in the settings file's environment.allow.`,
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
