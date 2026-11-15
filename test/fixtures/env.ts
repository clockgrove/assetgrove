/**
 * Imported first by every test that runs the CLI. Under one fresh temp root outside any repository
 * it points the cross-run spend ledger at a new file, ASSETGROVE_CONFIG at a settings file whose
 * stateDir is a new directory, so tests never read or write the user's own ledger, settings or
 * state. It unsets every variable `checkEnvironment` refuses, so a proxy on the machine never
 * refuses a test. Child processes inherit all of this through process.env. The removed values stay
 * in `machineProxyEnv`, for children such as `npm install` that need the machine's proxy.
 *
 * Every top-level test starts from the base settings; the helpers rewrite the file for tests that
 * need a headless operator, approved commands or declared limits, and the change ends with that
 * test. `approveScript` is the exception: it approves a --provider-script module for every later
 * test of the file, so scripted suites run without a person and offline.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { identifyCommand, providerScriptCommand } from "../../src/approvals.ts";
import type { GatedCommand } from "../../src/approvals.ts";
import { REFUSED_VARIABLES } from "../../src/env.ts";

const FORMAT = "assetgrove-settings/1";

const root = mkdtempSync(join(realpathSync(tmpdir()), "assetgrove-test-"));

process.env["ASSETGROVE_SPEND_LEDGER"] = join(root, "spend.jsonl");
// The caller's own work item and limits would change what the tests measure; a Factory worker's
// FACTORY_ISSUE would name a work item too.
for (const name of [
  "ASSETGROVE_WORK_ITEM",
  "FACTORY_ISSUE",
  "ASSETGROVE_DAILY_LIMIT_USD",
  "ASSETGROVE_WORK_ITEM_LIMIT_USD",
])
  delete process.env[name];
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

/** The approved commands every test of this file starts with (`approveScript`). */
const standing: Settings[] = [];

/** Writes the base settings (format, stateDir, standing approvals) with `settings` over them. */
export function writeSettings(settings: Settings): Settings {
  const base: Settings = { format: FORMAT, stateDir };
  if (standing.length > 0) base["commands"] = { approved: [...standing] };
  return save({ ...base, ...settings });
}

/**
 * Approves a --provider-script module in settings for the current test and every later test of
 * this file (headless ones too). Returns its commandHash.
 */
export function approveScript(path: string): string {
  const command = identifyCommand(providerScriptCommand(path));
  const entry = { hash: command.hash, kind: command.kind, argv: command.argv, cwd: command.cwd };
  if (!standing.some((s) => s["hash"] === command.hash)) {
    standing.push(entry);
    approveCommand(entry);
  }
  return command.hash;
}

/**
 * Approves one gated command (a validator, a material command) in settings for the current test.
 * Returns its commandHash.
 */
export function approve(command: GatedCommand): string {
  const identity = identifyCommand(command);
  approveCommand({
    hash: identity.hash,
    kind: identity.kind,
    argv: identity.argv,
    cwd: identity.cwd,
  });
  return identity.hash;
}

/** Restores the base settings and standing approvals. Runs before every top-level test. */
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
