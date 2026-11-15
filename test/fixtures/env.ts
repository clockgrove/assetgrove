/**
 * Imported first by every test that runs the CLI. Under one fresh temp root outside any repository
 * it points ASSETGROVE_CONFIG at a settings file whose stateDir is a new directory, so tests never
 * read or write the user's own settings, spend ledger (`<stateDir>/spend.jsonl`) or state. The base
 * settings declare a limit for the scripted provider, so a script that sets `paid` can spend. It unsets every variable `checkEnvironment` refuses, so a proxy on the machine never
 * refuses a test. Child processes inherit all of this through process.env. The removed values stay
 * in `machineProxyEnv`, for children such as `npm install` that need the machine's proxy.
 *
 * Every top-level test starts from the base settings; the helpers rewrite the file for tests that
 * need a headless operator, approved commands or declared limits, and the change ends with that
 * test.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { REFUSED_VARIABLES } from "../../src/env.ts";

const FORMAT = "assetgrove-settings/1";

const root = mkdtempSync(join(realpathSync(tmpdir()), "assetgrove-test-"));

// The caller's own work item would change what the tests measure.
delete process.env["ASSETGROVE_WORK_ITEM"];
/** The refused variables as the machine set them, removed from process.env below. */
export const machineProxyEnv: Record<string, string> = {};
for (const name of REFUSED_VARIABLES) {
  for (const key of [name, name.toLowerCase()]) {
    const value = process.env[key];
    if (value !== undefined) machineProxyEnv[key] = value;
    delete process.env[key];
  }
}

export const stateDir: string = join(root, "state");
mkdirSync(stateDir);
mkdirSync(join(root, "config"));
export const settingsPath: string = join(root, "config", "settings.json");
process.env["ASSETGROVE_CONFIG"] = settingsPath;

type Settings = Record<string, unknown>;

function save(settings: Settings): Settings {
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

function load(): Settings {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
}

function child(parent: Settings, key: string): Settings {
  const existing = parent[key];
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing))
    return existing as Settings;
  const created: Settings = {};
  parent[key] = created;
  return created;
}

/** The limit the base settings declare for the scripted provider. */
export const SCRIPTED_LIMIT = { kind: "prepaid", usd: 100 } as const;

/**
 * Writes the base settings (format, stateDir and the scripted provider's limit) with `settings`
 * over them.
 */
export function writeSettings(settings: Settings): Settings {
  return save({
    format: FORMAT,
    stateDir,
    providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } },
    ...settings,
  });
}

/** The spend ledger of the base settings. */
export const ledgerPath: string = join(stateDir, "spend.jsonl");

/** Restores the base settings. Runs before every top-level test. */
export function resetSettings(): Settings {
  return writeSettings({});
}

export function useHeadless(operator = "ci:example/repo"): Settings {
  return save({ ...load(), headless: { operator } });
}

export function approveCommand(command: {
  hash: string;
  kind: string;
  argv: string[];
  cwd?: string;
  note?: string;
}): Settings {
  const settings = load();
  const commands = child(settings, "commands");
  const approved = Array.isArray(commands["approved"]) ? (commands["approved"] as unknown[]) : [];
  commands["approved"] = [...approved, command];
  return save(settings);
}

export function declareLimit(
  providerId: string,
  limit: { kind: string; usd?: number; period?: string; acceptUnlimited?: boolean },
): Settings {
  const settings = load();
  const providers = child(settings, "providers");
  providers[providerId] = { ...child(providers, providerId), limit };
  return save(settings);
}

resetSettings();

// Root hooks run for subtests too; the depth keeps a subtest from resetting what its parent set.
let depth = 0;
beforeEach(() => {
  if (depth++ === 0) resetSettings();
});
afterEach(() => {
  depth--;
});
