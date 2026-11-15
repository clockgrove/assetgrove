/**
 * Command approvals (design section 8): a command a developer wrote — a profile validator, a
 * profile style's material compression or preview command, a `--provider-script` module — runs
 * only when its `commandHash` is approved in settings (`commands.approved`) or in
 * `<configDir>/approvals/<hex>.json`. Otherwise a person on a TTY is asked and the approval is
 * written on yes; headless runs only what settings list; with no one to ask the command exits 8
 * `confirmation_required`, saved for `assetgrove confirm <hex>`.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { savePending } from "./confirm/pending.ts";
import { NO_TTY, type TtyPort } from "./confirm/prompt.ts";
import type { Settings } from "./settings.ts";

/** The kinds of command Assetgrove gates. */
export const COMMAND_KINDS = [
  "validator",
  "material-compression",
  "material-preview",
  "provider-script",
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** A command as declared: its argv template and the directory it runs in. */
export interface GatedCommand {
  kind: CommandKind;
  /** The argv template, placeholders unexpanded. */
  argv: string[];
  /** The absolute directory the command runs in. */
  cwd: string;
  /** Files whose bytes the command runs regardless of argv (the provider-script module). */
  modules?: string[];
}

/** What the hash covers: the kind, the argv template, the cwd and the named files' hashes. */
export interface CommandIdentity {
  kind: CommandKind;
  argv: string[];
  /** Relative (POSIX separators) to the Git top level of the cwd, or absolute outside one. */
  cwd: string;
  files: Array<{ path: string; sha256: string }>;
  /** sha256 hex of the canonical identity without this field. */
  hash: string;
}

/** How a command came to be approved. */
export type ApprovalMethod = "settings" | "tty" | "terminal";

export interface ApprovedCommand {
  command: CommandIdentity;
  method: ApprovalMethod;
}

/** What an approval check reads and asks through. */
export interface ApprovalContext {
  settings: Settings;
  tty?: TtyPort;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** An approval file: the command it approves, how and when. */
export interface ApprovalRecord {
  format: "assetgrove-approval/1";
  kind: "command";
  hash: string;
  command: Omit<CommandIdentity, "hash">;
  method: ApprovalMethod;
  at: string;
  selfReported: true;
}

/** Exit 8: no approval and no one to ask; `confirmation` names the command and how to approve it. */
export class ConfirmationRequiredError extends Error {
  readonly code = "confirmation_required";
  readonly confirmation: Record<string, unknown>;
  constructor(message: string, confirmation: Record<string, unknown>) {
    super(message);
    this.name = "ConfirmationRequiredError";
    this.confirmation = confirmation;
  }
}

/** Exit 8: the person asked said no. */
export class ConfirmationDeclinedError extends Error {
  readonly code = "confirmation_declined";
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationDeclinedError";
  }
}

/** Exit 2: a command Assetgrove will not run, such as a Windows shim. */
export class CommandRefusedError extends Error {
  readonly code = "command_refused";
  constructor(message: string) {
    super(message);
    this.name = "CommandRefusedError";
  }
}

/** JSON with every object's keys sorted, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The real path of `dir`, or of its nearest existing ancestor joined with the rest. */
function real(dir: string): string {
  const full = path.resolve(dir);
  if (existsSync(full)) return realpathSync.native(full);
  const parent = path.dirname(full);
  return parent === full ? full : path.join(real(parent), path.basename(full));
}

/** The nearest directory at or above `dir` holding `.git` (a directory or a file). */
export function gitTopLevel(dir: string): string | undefined {
  for (let at = real(dir); ; at = path.dirname(at)) {
    if (existsSync(path.join(at, ".git"))) return at;
    if (path.dirname(at) === at) return undefined;
  }
}

/** `dir` relative to its Git top level with POSIX separators (`.` at the top), else absolute. */
function repoRelative(dir: string): string {
  const full = real(dir);
  const top = gitTopLevel(full);
  if (top === undefined) return full;
  return path.relative(top, full).split(path.sep).join("/") || ".";
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The identity and `commandHash` of a command. */
export function identifyCommand(command: GatedCommand): CommandIdentity {
  const cwd = real(command.cwd);
  const files: CommandIdentity["files"] = [];
  for (const arg of command.argv) {
    if (arg === "" || arg.includes("{{")) continue;
    const full = path.resolve(cwd, arg);
    if (!isInside(full, cwd)) continue;
    try {
      if (statSync(full).isFile()) files.push({ path: arg, sha256: sha256File(full) });
    } catch {
      // Not a file: hashed as written in argv.
    }
  }
  for (const module of command.modules ?? []) {
    if (files.some((f) => f.path === module)) continue;
    files.push({ path: module, sha256: sha256File(path.resolve(cwd, module)) });
  }
  const identity = { kind: command.kind, argv: command.argv, cwd: repoRelative(cwd), files };
  return { ...identity, hash: hashIdentity(identity) };
}

/** The commandHash of an identity: sha256 hex of canonical `{kind, argv, cwd, files}`. */
export function hashIdentity(identity: Omit<CommandIdentity, "hash">): string {
  const { kind, argv, cwd, files } = identity;
  return createHash("sha256").update(canonicalJson({ kind, argv, cwd, files })).digest("hex");
}

/**
 * The command of a `--provider-script` module: it runs from its own Git top level (its own
 * directory outside one), named relative to it, so the approval holds from any working
 * directory and any checkout of the repository.
 */
export function providerScriptCommand(script: string): GatedCommand {
  const file = real(path.resolve(script));
  const top = gitTopLevel(path.dirname(file)) ?? path.dirname(file);
  const name = path.relative(top, file).split(path.sep).join("/");
  return { kind: "provider-script", argv: [name], cwd: top, modules: [name] };
}

function approvalPath(settings: Settings, hash: string): string {
  return path.join(settings.configDir, "approvals", `${hash}.json`);
}

/** The approval file for this hash, when one exists and names it. */
export function readApproval(settings: Settings, hash: string): ApprovalRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(approvalPath(settings, hash), "utf8"));
  } catch {
    return undefined;
  }
  const record = raw as Partial<ApprovalRecord>;
  return record.kind === "command" && record.hash === hash ? (record as ApprovalRecord) : undefined;
}

/** Writes `<configDir>/approvals/<hex>.json` for a command. Returns its path. */
export function writeApproval(
  settings: Settings,
  command: CommandIdentity,
  method: ApprovalMethod,
  now: () => Date = () => new Date(),
): string {
  const { hash, ...rest } = command;
  const record: ApprovalRecord = {
    format: "assetgrove-approval/1",
    kind: "command",
    hash,
    command: rest,
    method,
    at: now().toISOString(),
    selfReported: true,
  };
  const file = approvalPath(settings, hash);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

/** A command as a person reads it before approving: kind, argv, cwd and file hashes. */
export function describeForPerson(command: CommandIdentity): string {
  return [
    `Assetgrove wants to run a ${command.kind} command it has no approval for:`,
    `  argv: ${JSON.stringify(command.argv)}`,
    `  cwd:  ${command.cwd}`,
    ...command.files.map((f) => `  file: ${f.path} sha256 ${f.sha256}`),
    `  hash: ${command.hash}`,
  ].join("\n");
}

const SHIMS = new Set([".cmd", ".bat"]);

/**
 * On Windows, resolves argv[0] through PATH and PATHEXT and refuses a `.cmd` or `.bat` result
 * (exit 2 `command_refused`): those run through cmd.exe, a shell. Elsewhere does nothing.
 * Returns the resolved file, when one was found.
 */
export function refuseShims(
  argv: readonly string[],
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (platform !== "win32") return undefined;
  const first = argv[0];
  if (first === undefined || first === "" || first.includes("{{")) return undefined;
  const win = path.win32;
  const lookup = (name: string) =>
    Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] ?? "";
  const exts = (lookup("PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const named = win.extname(first).toLowerCase();
  const names = [...(named && exts.includes(named) ? [first] : []), ...exts.map((e) => first + e)];
  const dirs =
    first.includes("/") || first.includes("\\") || win.isAbsolute(first)
      ? [""]
      : lookup("PATH").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir === "" ? name : win.join(dir, name);
      let isFile: boolean;
      try {
        isFile = statSync(candidate).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) continue;
      if (SHIMS.has(win.extname(candidate).toLowerCase())) {
        throw new CommandRefusedError(
          `${first} resolves to ${candidate}, a ${win.extname(candidate)} file that runs through a shell; Assetgrove never runs commands through a shell. Name the program itself, for a script \`node <script>\`.`,
        );
      }
      return candidate;
    }
  }
  return undefined;
}

/**
 * Returns how the command is approved, asking a person on a TTY when nothing approves it yet, or
 * throws: exit 8 `confirmation_required` (the request saved for `assetgrove confirm <hex>`),
 * exit 8 `confirmation_declined`, or exit 2 `command_refused` for a Windows shim.
 */
export async function requireApproval(
  gated: GatedCommand,
  ctx: ApprovalContext,
): Promise<ApprovedCommand> {
  if (gated.kind !== "provider-script") refuseShims(gated.argv, ctx.platform, ctx.env);
  const command = identifyCommand(gated);
  const { settings } = ctx;
  if (settings.commands.approved.some((a) => a.hash.toLowerCase() === command.hash)) {
    return { command, method: "settings" };
  }
  const headless = settings.mode === "headless";
  if (!headless) {
    const record = readApproval(settings, command.hash);
    if (record) return { command, method: record.method };
    const tty = ctx.tty ?? NO_TTY;
    if (tty.interactive) {
      if (await tty.ask(describeForPerson(command), "Approve and run this command?")) {
        writeApproval(settings, command, "tty", ctx.now);
        return { command, method: "tty" };
      }
      throw new ConfirmationDeclinedError(`the ${command.kind} command was not approved`);
    }
  }
  const confirmCommand = `assetgrove confirm ${command.hash}`;
  const summary = `run the ${command.kind} command ${JSON.stringify(command.argv)} in ${command.cwd}`;
  const confirmation = {
    kind: "command",
    id: command.hash,
    summary,
    confirmCommand,
    command: {
      kind: command.kind,
      hash: command.hash,
      argv: command.argv,
      cwd: command.cwd,
      files: command.files,
    },
  };
  savePending(settings.stateDir, {
    kind: "command",
    id: command.hash,
    summary,
    createdAt: (ctx.now ?? (() => new Date()))().toISOString(),
    command,
  });
  throw new ConfirmationRequiredError(
    headless
      ? `the ${command.kind} command ${command.hash} is not in settings.commands.approved; headless runs only commands listed there`
      : `the ${command.kind} command ${command.hash} needs approval; run \`${confirmCommand}\` on a terminal, or list its hash in settings.commands.approved`,
    confirmation,
  );
}
