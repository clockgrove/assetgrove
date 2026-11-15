/**
 * Imported first by every test that runs the CLI. Under one fresh temp root outside any repository
 * it points ASSETGROVE_CONFIG at a settings file whose stateDir is a new directory, so tests never
 * read or write the user's own settings, spend ledger (`<stateDir>/spend.jsonl`) or state. The base
 * settings declare a limit for the scripted provider, so a script that sets `paid` can spend. It unsets every variable `checkEnvironment` refuses, so a proxy on the machine never
 * refuses a test. Child processes inherit all of this through process.env. The removed values stay
 * in `machineProxyEnv`, for children such as `npm install` that need the machine's proxy.
 *
 * The base settings are headless with an operator (`HEADLESS_OPERATOR`), so a paid command spends
 * and a pick names its candidate without a person (design section 7); `useAttended()` removes it
 * for a test that asks a person. Every top-level test starts from the base settings; the helpers
 * rewrite the file for tests that need attended settings, approved commands or declared limits,
 * and the change ends with that test.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { commandIdentity, scriptIdentity } from "../../src/approvals.ts";
import type { CommandIdentity, CommandKind } from "../../src/approvals.ts";
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

/** The operator the base settings' headless mode names. */
export const HEADLESS_OPERATOR = "test:fixture";

/**
 * Commands `approve` approved for this test file: headless settings run only commands listed in
 * `settings.commands.approved`, so the base settings list them too.
 */
const approvedCommands: Array<{ hash: string; kind: string; argv: string[]; cwd: string }> = [];

/**
 * Writes the base settings (format, stateDir, the scripted provider's limit, headless with
 * `HEADLESS_OPERATOR` and the commands `approve` approved) with `settings` over them.
 */
export function writeSettings(settings: Settings): Settings {
  return save({
    format: FORMAT,
    stateDir,
    headless: { operator: HEADLESS_OPERATOR },
    providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } },
    ...(approvedCommands.length > 0 && {
      commands: { approved: approvedCommands.map((c) => ({ ...c })) },
    }),
    ...settings,
  });
}

/** Attended settings: no headless operator, so a person is asked (a TTY, a record, or exit 8). */
export function useAttended(): Settings {
  const settings = load();
  delete settings["headless"];
  return save(settings);
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

/** Where the approval records of the test's config directory go: `<configDir>/approvals`. */
export const approvalsDir: string = join(root, "config", "approvals");

/** Where the confirmation records of the test's config directory go: `<configDir>/confirmations`. */
export const confirmationsDir: string = join(root, "config", "confirmations");

/**
 * Approves commands for this test file the way a person's terminal accept does: one record per
 * hash at `<configDir>/approvals/<hex>.json` (method `terminal`). Records live beside the settings
 * file, so they survive each test's settings reset; the commands are also listed in the base
 * settings' `commands.approved`, which headless settings read. Each
 * argument is a --provider-script module path, or a command `{kind, argv, cwd}`. A profile's
 * validator (`approveProfile`) and material commands are commands too. Returns the identities.
 */
export function approve(
  ...commands: Array<string | { kind: CommandKind; argv: string[]; cwd: string }>
): CommandIdentity[] {
  mkdirSync(approvalsDir, { recursive: true });
  return commands.map((command) => {
    const identity =
      typeof command === "string"
        ? scriptIdentity(command)
        : commandIdentity(command.kind, command.argv, command.cwd);
    const { hash, kind, argv, cwd, files } = identity;
    const record = {
      kind,
      hash,
      argv,
      cwd,
      files,
      method: "terminal",
      at: new Date(0).toISOString(),
    };
    writeFileSync(join(approvalsDir, `${hash}.json`), `${JSON.stringify(record, null, 2)}\n`);
    if (!approvedCommands.some((c) => c.hash === hash)) {
      approvedCommands.push({ hash, kind, argv, cwd });
      approveCommand({ hash, kind, argv, cwd });
    }
    return identity;
  });
}

interface ProfileCommands {
  validator?: { command: string[] };
  style?: { materials?: { compression?: { command: string[] }; preview?: { command: string[] } } };
}

/**
 * Approves every command a target profile names: its validator, run in `targetDir`, and its
 * style's material compression and preview, run in `profileDir` (the profile's directory).
 */
export function approveProfile(
  profile: ProfileCommands,
  dirs: { targetDir?: string; profileDir?: string },
): CommandIdentity[] {
  const commands: Array<{ kind: CommandKind; argv: string[]; cwd: string }> = [];
  if (profile.validator && dirs.targetDir !== undefined)
    commands.push({ kind: "validator", argv: profile.validator.command, cwd: dirs.targetDir });
  const materials = profile.style?.materials;
  if (materials?.compression && dirs.profileDir !== undefined)
    commands.push({
      kind: "material-compression",
      argv: materials.compression.command,
      cwd: dirs.profileDir,
    });
  if (materials?.preview && dirs.profileDir !== undefined)
    commands.push({
      kind: "material-preview",
      argv: materials.preview.command,
      cwd: dirs.profileDir,
    });
  return approve(...commands);
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
