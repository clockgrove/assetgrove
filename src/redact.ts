/**
 * Redaction (design section 4): key values and credential header values never reach a message
 * Assetgrove writes. `redact` runs in ProviderError, the one result builder and the log.
 */
import { DEFAULT_KEY_ENV, keyValue, withoutVariables, type Env } from "./env.ts";

export { DEFAULT_KEY_ENV };

/** Values shorter than this are not redacted: they would mangle ordinary text. */
const MIN_REDACTED_LENGTH = 8;

const registered = new Set<string>();

/**
 * Adds key variable names to those redacted: each provider's `keyEnv` and each adapter's default,
 * registered when the run context is made (src/commands/context.ts).
 */
export function registerKeyEnv(names: Iterable<string>): void {
  for (const name of names) registered.add(name);
}

/** Every key variable name redaction knows: the defaults and those registered from settings. */
export function keyEnvNames(): string[] {
  return [...new Set<string>([...DEFAULT_KEY_ENV, ...registered])];
}

/**
 * The environment a command a developer wrote runs in (a validator, a material command): this
 * process's, without any key variable redaction knows.
 */
export function keyFreeEnv(env?: Env): Env {
  return withoutVariables(keyEnvNames(), env);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Credential header values, each masked whole. */
const HEADER_PATTERNS: [RegExp, string][] = [
  // Authorization: <scheme> <value>, or a bare value; as a header, JSON member or assignment.
  [
    /(\bauthorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Key|Token)\s+)?[^\s"',;]+/gi,
    "$1[redacted:authorization]",
  ],
  [/(\bx-api-key["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1[redacted:x-api-key]"],
  [/(\bBearer\s+)(?!\[redacted:)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted:bearer]"],
  [/(\bKey\s+)(?!\[redacted:)[A-Za-z0-9._~+/:=-]{16,}/g, "$1[redacted:key]"],
];

/**
 * The text with each configured key variable's value replaced by `[redacted:<ENV>]` and the
 * values of Authorization, Bearer, Key and x-api-key masked.
 */
export function redact(text: string, env?: Env): string {
  let out = text;
  const values = keyEnvNames()
    .map((name) => [name, keyValue(name, env)] as const)
    .filter((entry): entry is readonly [string, string] => {
      const value = entry[1];
      return value !== undefined && value.trim().length >= MIN_REDACTED_LENGTH;
    })
    // Longer values first, so a value that contains another is replaced whole.
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of values) {
    out = out.replace(new RegExp(escape(value), "g"), `[redacted:${name}]`);
  }
  for (const [pattern, replacement] of HEADER_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
