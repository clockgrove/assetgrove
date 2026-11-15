/**
 * Commands a developer writes (design section 8): the profile's validator, the profile style's
 * material compression and preview commands, and the CLI's --provider-script module. Each runs only
 * with an approval tied to its exact `commandHash`: listed in `settings.commands.approved`, or a
 * record at `<configDir>/approvals/<hex>.json`. Otherwise a person is asked (kind `command`) and the
 * accept is recorded; with no channel the command exits 8 `confirmation_required` carrying it, and
 * `assetgrove confirm <hex>` approves it. Commands never run through a shell; on Windows a `.cmd`
 * or `.bat` shim is refused (exit 2 `command_refused`).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { Env } from "./env.ts";
import { savePending } from "./confirm/pending.ts";
import type { ConfirmPort, ConfirmRequest } from "./confirm/prompt.ts";
import { loadSettings } from "./settings.ts";
import type { Settings } from "./settings.ts";

/** The gated kinds. There is no `material-encode` operation. */
export const COMMAND_KINDS = [
  "validator",
  "material-compression",
  "material-preview",
  "provider-script",
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** What a command's hash covers, and the hash. */
export interface CommandIdentity {
  kind: CommandKind;
  /** The argv template, before placeholders are filled. */
  argv: string[];
  /** Relative to the Git top level with `/` (`.` for the top level), or absolute outside one. */
  cwd: string;
  /** The sha256 of each argv element that is a regular file under cwd, by its `/` path from cwd. */
  files: Record<string, string>;
  /** sha256 hex of the canonical `{kind, argv, cwd, files}`. */
  hash: string;
}

/** How a command came to be approved. */
export type ApprovalMethod = "settings" | "tty" | "terminal";

/** A command step as provenance records it. */
export interface CommandStep {
  kind: CommandKind;
  hash: string;
  method: ApprovalMethod;
}

/** What deciding an approval reads: the settings, and a channel to ask a person when there is one. */
export interface ApprovalGate {
  settings: Pick<Settings, "configDir" | "stateDir" | "mode" | "commands">;
  prompt?: ConfirmPort;
}

/** An approval record as written to `<configDir>/approvals/<hex>.json`. */
export interface ApprovalRecord {
  kind: CommandKind;
  hash: string;
  argv: string[];
  cwd: string;
  files: Record<string, string>;
  method: "tty" | "terminal";
  at: string;
}

/** The `error.confirmation` of a gated command no one approved. */
export interface CommandConfirmation {
  kind: "command";
  id: string;
  summary: string;
  confirmCommand: string;
  command: Omit<CommandIdentity, "hash"> & { hash: string };
}

/** Exit 8: the command needs a person's approval (`confirmation_required` or `_declined`). */
export class ConfirmationError extends Error {
  readonly code: "confirmation_required" | "confirmation_declined";
  readonly confirmation: CommandConfirmation;
  constructor(
    code: "confirmation_required" | "confirmation_declined",
    message: string,
    confirmation: CommandConfirmation,
  ) {
    super(message);
    this.name = "ConfirmationError";
    this.code = code;
    this.confirmation = confirmation;
  }
}

/** Exit 2 `command_refused`: a command Assetgrove will not start. */
export class CommandRefusedError extends Error {
  readonly code = "command_refused";
  constructor(message: string) {
    super(message);
    this.name = "CommandRefusedError";
  }
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The real path, or its nearest existing ancestor's real path joined with the rest. */
function real(path: string): string {
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  return parent === path ? path : join(real(parent), basename(path));
}

/** The nearest directory at or above `dir` holding a `.git` entry (a directory or a file). */
export function gitTopLevel(dir: string): string | undefined {
  for (let at = real(resolve(dir)); ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return undefined;
  }
}

const toPosix = (path: string) => path.split(sep).join("/");

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The canonical JSON of an identity: fixed key order, files sorted by path. */
function canonical(identity: Omit<CommandIdentity, "hash">): string {
  const files = Object.fromEntries(
    Object.entries(identity.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return JSON.stringify({ kind: identity.kind, argv: identity.argv, cwd: identity.cwd, files });
}

/**
 * The identity a stored `{kind, argv, cwd, files}` describes, when it is well formed and hashes to
 * `hash`; otherwise undefined. `assetgrove confirm` approves only a pending request whose shown
 * command is the one its id names.
 */
export function verifiedIdentity(details: unknown, hash: string): CommandIdentity | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const d = details as Record<string, unknown>;
  const kind = d.kind;
  if (typeof kind !== "string" || !(COMMAND_KINDS as readonly string[]).includes(kind)) {
    return undefined;
  }
  if (!Array.isArray(d.argv) || !d.argv.every((a) => typeof a === "string")) return undefined;
  if (typeof d.cwd !== "string") return undefined;
  if (typeof d.files !== "object" || d.files === null || Array.isArray(d.files)) return undefined;
  const files = d.files as Record<string, unknown>;
  if (!Object.values(files).every((v) => typeof v === "string")) return undefined;
  const identity = {
    kind: kind as CommandKind,
    argv: [...(d.argv as string[])],
    cwd: d.cwd,
    files: { ...(files as Record<string, string>) },
  };
  return sha256Hex(canonical(identity)) === hash ? { ...identity, hash } : undefined;
}

/** The cwd as hashed: relative to its Git top level with `/`, or absolute outside a repository. */
export function hashedCwd(cwd: string): string {
  const full = real(resolve(cwd));
  const top = gitTopLevel(full);
  if (top === undefined) return toPosix(full);
  return toPosix(relative(top, full)) || ".";
}

/**
 * The identity of a command run in `cwd` from an argv template. Every argv element without a
 * placeholder that names a regular file under cwd is hashed into `files`.
 */
export function commandIdentity(kind: CommandKind, argv: string[], cwd: string): CommandIdentity {
  const full = real(resolve(cwd));
  const files: Record<string, string> = {};
  for (const arg of argv) {
    if (arg === "" || arg.includes("{{")) continue;
    const path = resolve(full, arg);
    const rel = relative(full, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || !isFile(path)) continue;
    files[toPosix(rel)] = sha256Hex(readFileSync(path));
  }
  const identity = { kind, argv: [...argv], cwd: hashedCwd(full), files };
  return { ...identity, hash: sha256Hex(canonical(identity)) };
}

/**
 * The identity of a --provider-script module: argv is its file name, cwd its directory and files
 * its sha256, so the hash follows the module's place in its repository and its bytes.
 */
export function scriptIdentity(modulePath: string): CommandIdentity {
  const full = real(resolve(modulePath));
  if (!isFile(full)) {
    // An unreadable module still gets a stable identity; loading it then fails as invalid input.
    const identity = {
      kind: "provider-script" as const,
      argv: [basename(full)],
      cwd: hashedCwd(dirname(full)),
      files: {},
    };
    return { ...identity, hash: sha256Hex(canonical(identity)) };
  }
  return commandIdentity("provider-script", [basename(full)], dirname(full));
}

function confirmation(identity: CommandIdentity): CommandConfirmation {
  return {
    kind: "command",
    id: identity.hash,
    summary: `run the ${identity.kind} command ${JSON.stringify(identity.argv)} in ${identity.cwd}`,
    confirmCommand: `assetgrove confirm ${identity.hash}`,
    command: {
      kind: identity.kind,
      hash: identity.hash,
      argv: identity.argv,
      cwd: identity.cwd,
      files: identity.files,
    },
  };
}

/** The confirmation request of a command, as a form or a prompt shows it. */
export function commandRequest(identity: CommandIdentity): ConfirmRequest {
  return {
    kind: "command",
    id: identity.hash,
    summary: `Assetgrove wants to run a ${identity.kind} command a file names:`,
    details: {
      kind: identity.kind,
      argv: identity.argv,
      cwd: identity.cwd,
      files: identity.files,
      hash: identity.hash,
    },
  };
}

/** Where a command's approval record lives. */
export function approvalPath(configDir: string, hash: string): string {
  return join(configDir, "approvals", `${hash}.json`);
}

/** Writes an approval record for a command a person accepted. */
export async function writeApproval(
  configDir: string,
  identity: CommandIdentity,
  method: ApprovalRecord["method"],
): Promise<string> {
  const record: ApprovalRecord = {
    kind: identity.kind,
    hash: identity.hash,
    argv: identity.argv,
    cwd: identity.cwd,
    files: identity.files,
    method,
    at: new Date().toISOString(),
  };
  const path = approvalPath(configDir, identity.hash);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/** The approval record of a hash, when one exists and names that hash. */
export async function readApproval(
  configDir: string,
  hash: string,
): Promise<ApprovalRecord | undefined> {
  let record: Partial<ApprovalRecord>;
  try {
    record = JSON.parse(await readFile(approvalPath(configDir, hash), "utf8")) as ApprovalRecord;
  } catch {
    return undefined;
  }
  return record.hash === hash ? (record as ApprovalRecord) : undefined;
}

/**
 * Returns how a command is approved, asking a person when no approval exists and a channel can.
 * Sources, in order: `settings.commands.approved`; under headless settings nothing else counts;
 * the record at `<configDir>/approvals/<hex>.json`; the prompt, whose accept writes that record.
 * Otherwise the request is saved to `<stateDir>/pending/<hex>.json` and exit 8 carries the command.
 */
export async function requireApproval(
  identity: CommandIdentity,
  gate: ApprovalGate,
): Promise<CommandStep> {
  const { settings } = gate;
  const step = (method: ApprovalMethod): CommandStep => ({
    kind: identity.kind,
    hash: identity.hash,
    method,
  });
  if (settings.commands.approved.some((entry) => entry.hash.toLowerCase() === identity.hash))
    return step("settings");
  const asked = confirmation(identity);
  if (settings.mode === "headless") {
    throw new ConfirmationError(
      "confirmation_required",
      `the ${identity.kind} command ${JSON.stringify(identity.argv)} (hash ${identity.hash}) is not in settings.commands.approved; headless settings run only commands listed there`,
      asked,
    );
  }
  const record = await readApproval(settings.configDir, identity.hash);
  if (record !== undefined) return step(record.method);
  const request = commandRequest(identity);
  if (gate.prompt) {
    if (!(await gate.prompt.confirm(request))) {
      throw new ConfirmationError(
        "confirmation_declined",
        `the ${identity.kind} command ${JSON.stringify(identity.argv)} was declined`,
        asked,
      );
    }
    await writeApproval(settings.configDir, identity, gate.prompt.method);
    return step(gate.prompt.method);
  }
  await savePending(settings.stateDir, request);
  throw new ConfirmationError(
    "confirmation_required",
    `the ${identity.kind} command ${JSON.stringify(identity.argv)} in ${identity.cwd} needs approval; run: ${asked.confirmCommand}`,
    asked,
  );
}

/** The gate of a library call given none: the developer settings, and no one to ask. */
export function defaultGate(): ApprovalGate {
  return { settings: loadSettings() };
}

function envValue(env: Env, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * The program a command starts. On Windows `argv[0]` is resolved through the cwd, PATH and PATHEXT
 * the way the process would be found, and a `.cmd` or `.bat` result is refused (exit 2
 * `command_refused`): a shim runs through cmd.exe, a shell. Elsewhere `argv[0]` is returned as is.
 */
export function resolveProgram(
  argv0: string,
  cwd: string,
  options: { platform?: string; env?: Env } = {},
): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return argv0;
  const env = options.env ?? process.env;
  const exts = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const bases =
    /[\\/]/.test(argv0) || win32.isAbsolute(argv0)
      ? [win32.resolve(cwd, argv0)]
      : [
          win32.join(cwd, argv0),
          ...(envValue(env, "PATH") ?? "")
            .split(";")
            .filter(Boolean)
            .map((dir) => win32.join(dir, argv0)),
        ];
  const hasExt = exts.includes(win32.extname(argv0).toLowerCase());
  for (const base of bases) {
    const candidates = hasExt ? [base] : exts.map((ext) => base + ext);
    const found = candidates.find(isFile);
    if (found === undefined) continue;
    if (/\.(cmd|bat)$/i.test(found)) {
      throw new CommandRefusedError(
        `"${argv0}" resolves to ${found}, a .cmd or .bat shim, which runs through a shell; name the program itself, for example ["node", "<script>"]`,
      );
    }
    return found;
  }
  return argv0;
}
