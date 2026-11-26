/**
 * A temporary project for pack tests (`@clockgrove/assetgrove/testing`): a Git work tree with its
 * own developer settings and state directory, outside any repository, so a test never reads or
 * writes the developer's own settings, spend ledger or state. It runs core's commands on the CLI
 * (a child process), in process (with the pack's extension objects) and as an MCP server.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { commands } from "../commands/registry.ts";
import { runCommand } from "../commands/runner.ts";
import type { Outcome, RunContext } from "../commands/types.ts";
import type { ConfirmPort, ConfirmRequest } from "../confirm/prompt.ts";
import { isolateForSettings, withConfigOverride } from "../env.ts";
import type { Extension, ExtensionEntry } from "../extension/api.ts";
import { CORE_ENTRY, CORE_REGISTRY, ExtensionRegistry } from "../extensions/registry.ts";
import { formatLine } from "../formats.ts";
import { serveMcp } from "../mcp.ts";
import { loadSettings } from "../settings.ts";
import { resolveEntry } from "./conformance.ts";

/** The operator the base settings' headless mode names, so a paid command spends unattended. */
export const TEST_OPERATOR = "test:pack";

/** The limit the base settings declare for the scripted provider. */
export const SCRIPTED_LIMIT = { kind: "prepaid", usd: 100 } as const;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON, when it is JSON. */
  json?: Record<string, unknown>;
}

/** An MCP server, in process or a child process: JSON-RPC requests in, answers out. */
export interface McpSession {
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
  notify(method: string, params?: unknown): void;
  /** Ends the session and waits for the server. */
  close(): Promise<void>;
}

export interface RunOptions {
  /** The packs to register beside core: extension objects or entries (factories). */
  extensions?: ReadonlyArray<Extension | ExtensionEntry>;
  /** Answers each confirmation as a person on a TTY would; absent, no one can be asked. */
  confirm?: (request: ConfirmRequest) => boolean | Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export interface TempProject {
  /** The project's directory (a real path, a Git work tree with one commit). */
  dir: string;
  /** The developer settings file, outside the project. */
  settingsPath: string;
  /** The settings' stateDir; the spend ledger is `<stateDir>/spend.jsonl`. */
  stateDir: string;
  /** The environment a child process runs with: `ASSETGROVE_CONFIG` names `settingsPath`. */
  env: NodeJS.ProcessEnv;
  /**
   * Writes the settings: the base (format, stateDir, headless with `TEST_OPERATOR`, the scripted
   * provider's limit) with `settings` over it. `attended: true` leaves headless out.
   */
  writeSettings(settings?: Record<string, unknown>, options?: { attended?: boolean }): void;
  /** Copies a package directory to `node_modules/<name>`, as an install would leave it. */
  install(packageDir: string, name: string): string;
  /** Runs core's CLI in the project, as a child process. */
  cli(args: readonly string[], options?: { env?: NodeJS.ProcessEnv }): Promise<CliResult>;
  /**
   * Runs one core command in process, with the packs given registered beside core. `args` are the
   * command's own (its MCP tool's input); pass `target: project.dir` to a command that takes one.
   */
  run(command: string, args?: Record<string, unknown>, options?: RunOptions): Promise<Outcome>;
  /** Serves core's MCP server in process, with the packs given registered beside core. */
  mcp(options?: RunOptions & { providerScript?: string }): Promise<McpSession>;
  /**
   * Serves core's MCP server as a child process (`assetgrove mcp` in the project), so core loads
   * the packs the settings list, as an installed pack is loaded.
   */
  mcpServer(options?: { env?: NodeJS.ProcessEnv }): Promise<McpSession>;
  /** Removes the project and its settings, and restores the process environment. */
  close(): void;
}

const CLI = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../cli.ts" : "../cli.js", import.meta.url),
);

async function registryOf(extensions: RunOptions["extensions"] = []): Promise<ExtensionRegistry> {
  if (extensions.length === 0) return CORE_REGISTRY;
  const loaded = [];
  for (const entry of extensions) {
    const extension = await resolveEntry(entry as ExtensionEntry);
    loaded.push({
      extension,
      info: { package: extension.name, version: null, entry: null },
    });
  }
  return new ExtensionRegistry([CORE_ENTRY, ...loaded]);
}

function portOf(options: RunOptions): ConfirmPort | undefined {
  const confirm = options.confirm;
  if (confirm === undefined) return undefined;
  return { method: "tty", confirm: async (request) => confirm(request) };
}

/**
 * Makes a temporary project. While it is open, `ASSETGROVE_CONFIG` in this process names its
 * settings and the variables core refuses are unset, so in-process runs read only its settings;
 * `close()` restores both. Open one at a time per process.
 */
export function tempProject(options: { settings?: Record<string, unknown> } = {}): TempProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-pack-")));
  const dir = join(root, "project");
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  for (const d of [dir, stateDir, configDir]) mkdirSync(d, { recursive: true });
  const settingsPath = join(configDir, "settings.json");
  const restore = isolateForSettings(settingsPath);
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.email", "pack@example.test");
  git("config", "user.name", "Pack Test");
  git("config", "commit.gpgsign", "false");
  // No background maintenance: git's auto gc and maintenance, detached after a commit, write lock
  // files under .git while a test may be reading or hashing it.
  git("config", "gc.auto", "0");
  git("config", "maintenance.auto", "false");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  git("add", ".gitignore");
  git("commit", "--quiet", "-m", "a temporary project");

  const writeSettings: TempProject["writeSettings"] = (settings = {}, opts = {}) => {
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          format: formatLine("settings"),
          stateDir,
          ...(opts.attended !== true && { headless: { operator: TEST_OPERATOR } }),
          providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } },
          ...settings,
        },
        null,
        2,
      )}\n`,
    );
  };
  writeSettings(options.settings);

  const env = (): NodeJS.ProcessEnv => withConfigOverride(settingsPath);

  return {
    dir,
    settingsPath,
    stateDir,
    get env() {
      return env();
    },
    writeSettings,
    install(packageDir, name) {
      const target = join(dir, "node_modules", ...name.split("/"));
      cpSync(packageDir, target, {
        recursive: true,
        filter: (src) => !src.split(/[\\/]/).includes("node_modules"),
      });
      return target;
    },
    cli(args, opts = {}) {
      return new Promise((resolve) => {
        const child = execFile(
          process.execPath,
          [CLI, ...args],
          { cwd: dir, env: { ...env(), ...opts.env }, maxBuffer: 64 * 1024 * 1024 },
          (error, stdout, stderr) => {
            let json: Record<string, unknown> | undefined;
            try {
              json = JSON.parse(stdout) as Record<string, unknown>;
            } catch {
              json = undefined;
            }
            const code = error ? (error.code as unknown as number) : 0;
            resolve({ code, stdout, stderr, ...(json !== undefined && { json }) });
          },
        );
        child.stdin?.end();
      });
    },
    async run(command, args = {}, opts = {}) {
      const spec = commands.find((c) => c.name === command);
      if (spec === undefined) throw new Error(`no core command is named "${command}"`);
      const prompt = portOf(opts);
      const ctx: RunContext = {
        settings: loadSettings({ cwd: dir }),
        extensions: await registryOf(opts.extensions),
        log: opts.log ?? (() => {}),
        ...(prompt !== undefined && { prompt }),
        ...(opts.env !== undefined && { env: opts.env }),
      };
      return runCommand(spec, args, ctx);
    },
    async mcp(opts = {}) {
      const input = new PassThrough();
      const output = new PassThrough();
      const prompt = portOf(opts);
      const ctx: RunContext = {
        settings: loadSettings({ cwd: dir }),
        extensions: await registryOf(opts.extensions),
        log: opts.log ?? (() => {}),
        ...(prompt !== undefined && { prompt }),
        ...(opts.env !== undefined && { env: opts.env }),
        ...(opts.providerScript !== undefined && { providerScript: opts.providerScript }),
      };
      const served = serveMcp(ctx, input, output, { target: dir });
      return rpcSession(input, output, served);
    },
    async mcpServer(opts = {}) {
      const child = spawn(process.execPath, [CLI, "mcp"], {
        cwd: dir,
        env: { ...env(), ...opts.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      const exited = new Promise<void>((done) => child.once("close", () => done()));
      return rpcSession(child.stdin, child.stdout, exited, () => stderr);
    },
    close() {
      restore();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A JSON-RPC session over newline-delimited messages: requests written to `input`, answers read
 * from `output`. It sends `initialize` and `notifications/initialized` before it is returned.
 * `done` settles when the server has ended; a request still waiting then is answered with an error
 * carrying `stderr()`.
 */
async function rpcSession(
  input: Writable,
  output: Readable,
  done: Promise<unknown>,
  stderr: () => string = () => "",
): Promise<McpSession> {
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (line === "") continue;
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id === "number") {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
  });
  void done.then(() => {
    for (const [id, answer] of pending)
      answer({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: `the MCP server ended: ${stderr()}` },
      });
    pending.clear();
  });
  let next = 0;
  const session: McpSession = {
    request: (method, params = {}) =>
      new Promise((answer) => {
        const id = ++next;
        pending.set(id, answer);
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    notify: (method, params) => {
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined && { params }) })}\n`,
      );
    },
    close: async () => {
      input.end();
      await done;
    },
  };
  await session.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "assetgrove-testing", version: "0.0.0" },
  });
  session.notify("notifications/initialized");
  return session;
}
