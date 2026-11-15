/**
 * Developer settings are read fresh and checked against every project in play (design sections 2
 * and 7): the MCP server loads them for each tool call, so a cap lowered through settings_change
 * holds from the next call; a settings file inside the project of `--target`, an input file or a
 * sibling worktree is refused; settings change never writes a file a run context would refuse;
 * Ctrl+D at the inline prompt declines; and a confirmation form stays answerable for hours.
 */
import "./fixtures/env.ts";
import { settingsPath, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ServerContext } from "@modelcontextprotocol/server";
import { commands } from "../src/commands/registry.ts";
import { parseCommandLine, runCommand } from "../src/commands/runner.ts";
import type { ConfirmPort } from "../src/confirm/prompt.ts";
import { ttyPort } from "../src/confirm/prompt.ts";
import { REFUSED_VARIABLES, SettingsError } from "../src/env.ts";
import { formStateCodec } from "../src/mcp.ts";
import { loadSettings } from "../src/settings.ts";
import { applySettingsChange } from "../src/settings-write.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
type Form = ElicitRequest["params"];

const root = fileURLToPath(new URL("..", import.meta.url));
const freeScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));

const temporary: string[] = [];
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-settings-fresh-")));
  temporary.push(dir);
  return dir;
}

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const name of REFUSED_VARIABLES) {
    delete env[name];
    delete env[name.toLowerCase()];
  }
  return { ...env, ...extra };
}

const properties = (form: Form): Record<string, Doc> =>
  (form as unknown as { requestedSchema: { properties: Record<string, Doc> } }).requestedSchema
    .properties;

const acceptUnchanged = (form: Form): ElicitResult => ({
  action: "accept",
  content: Object.fromEntries(Object.entries(properties(form)).map(([k, v]) => [k, v["default"]])),
});

async function connect(): Promise<Client> {
  const client = new Client(
    { name: "assetgrove-fresh-test", version: "0.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  client.setRequestHandler("elicitation/create", async (request) =>
    acceptUnchanged(request.params),
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--provider-script", freeScript],
      cwd: root,
      env: childEnv(),
      stderr: "pipe",
    }),
  );
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Doc> {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as Doc;
}

function cli(args: string[], env: Record<string, string>): Promise<Doc> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args, "--json"],
      { cwd: root, env: childEnv(env) },
      (_error, stdout) => resolve(JSON.parse(stdout) as Doc),
    );
    child.stdin?.end();
  });
}

async function inProcess(argv: string[], prompt?: ConfirmPort) {
  const [name, ...rest] = argv;
  const command =
    commands.find((c) => c.name === `${name} ${rest[0]}`) ?? commands.find((c) => c.name === name);
  assert.ok(command, name);
  const words = command.name.split(" ").length - 1;
  const { args } = parseCommandLine(command, rest.slice(words));
  return runCommand(command, args, {
    settings: loadSettings(),
    log: () => {},
    ...(prompt && { prompt }),
  });
}

test("a cap lowered and a limit declared through settings_change hold for the same server's next call", async () => {
  useAttended();
  const client = await connect();
  const before = await call(client, "spend", { action: "status" });
  assert.equal(before["exitCode"], 0, JSON.stringify(before["error"]));
  assert.notEqual(before["caps"].runUsd, 0.01);

  const changed = await call(client, "settings_change", {
    runUsd: 0.01,
    dailyUsd: 0.01,
    provider: "vercel-ai-gateway",
    limitKind: "prepaid",
    limitUsd: 20,
  });
  assert.equal(changed["exitCode"], 0, JSON.stringify(changed["error"]));

  const status = await call(client, "spend", { action: "status" });
  assert.equal(status["caps"].runUsd, 0.01);
  assert.equal(status["caps"].dailyUsd, 0.01);
  const shown = await call(client, "settings", { action: "show" });
  assert.ok("vercel-ai-gateway" in shown["settings"].providers, JSON.stringify(shown));
});

/** A directory that holds `.git`, which makes it a project, with a copy of the test settings. */
async function projectWithSettings(): Promise<{ project: string; config: string }> {
  const project = await scratch();
  mkdirSync(join(project, ".git"));
  const config = join(project, "assetgrove-settings.json");
  writeFileSync(config, readFileSync(settingsPath, "utf8"));
  return { project, config };
}

test("a settings file inside the project of --target or of an input file is refused from a cwd outside it", async () => {
  const { project, config } = await projectWithSettings();
  const env = { ASSETGROVE_CONFIG: config };
  const show = await cli(["settings", "show"], env);
  assert.equal(show["exitCode"], 0, JSON.stringify(show["error"]));

  const bible = join(project, "bible.json");
  writeFileSync(bible, "{}");
  const described = await cli(["bible", "describe", "--bible", bible], env);
  assert.equal(described["exitCode"], 2);
  assert.equal(described["error"].code, "settings_invalid");
  assert.match(described["error"].message, /inside the project/);

  const picked = await cli(
    ["pick", "--run", join(root, "none"), "--target", join(project, "target"), "--candidate", "c"],
    env,
  );
  assert.equal(picked["error"].code, "settings_invalid");
  assert.match(picked["error"].message, /inside the project/);
});

test("a settings file inside a sibling worktree of the cwd's repository is refused", async () => {
  const base = await scratch();
  const main = join(base, "main");
  const sibling = join(base, "sibling");
  mkdirSync(join(main, ".git", "worktrees", "sibling"), { recursive: true });
  mkdirSync(sibling);
  writeFileSync(join(main, ".git", "worktrees", "sibling", "gitdir"), `${join(sibling, ".git")}\n`);
  writeFileSync(join(main, ".git", "worktrees", "sibling", "commondir"), `${join("..", "..")}\n`);
  writeFileSync(join(sibling, ".git"), `gitdir: ${join(main, ".git", "worktrees", "sibling")}\n`);
  const config = join(sibling, "settings.json");
  writeFileSync(config, readFileSync(settingsPath, "utf8"));
  const env = { ...process.env, ASSETGROVE_CONFIG: config };
  assert.throws(() => loadSettings({ env, cwd: main }), SettingsError);
  assert.throws(() => loadSettings({ env, cwd: base, inputs: [join(main, "spec.json")] }), {
    message: /inside the project/,
  });
});

test("settings change never writes a provider entry every later command would refuse", async () => {
  useAttended();
  const before = readFileSync(settingsPath, "utf8");
  await assert.rejects(
    applySettingsChange(
      loadSettings(),
      { limit: { provider: "openai-compatible", limit: { kind: "prepaid", usd: 5 } } },
      { method: "terminal" },
    ),
    SettingsError,
  );
  assert.equal(readFileSync(settingsPath, "utf8"), before);
  const path = await cli(["settings", "path"], {});
  assert.equal(path["exitCode"], 0, JSON.stringify(path["error"]));
});

/** A TTY port over in-memory streams that answers Ctrl+D. */
function ctrlD(): ConfirmPort {
  const stdin = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream;
  const stderr = Object.assign(new PassThrough(), {
    isTTY: true,
  }) as unknown as NodeJS.WriteStream;
  stderr.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes("Approve?")) (stdin as unknown as PassThrough).write("\x04");
  });
  const port = ttyPort(stdin, stderr);
  assert.ok(port);
  return port;
}

test("Ctrl+D at the inline prompt declines: exit 8 confirmation_declined", async () => {
  useAttended();
  const asked = await inProcess(["settings", "change", "--run-usd", "3"]);
  assert.equal(asked.exitCode, 8);
  const id = (asked.error?.confirmation as { id: string } | undefined)?.id;
  assert.ok(id);
  const before = readFileSync(settingsPath, "utf8");
  const outcome = await inProcess(["confirm", id], ctrlD());
  assert.equal(outcome.exitCode, 8, JSON.stringify(outcome.error));
  assert.equal(outcome.error?.code, "confirmation_declined");
  assert.equal(readFileSync(settingsPath, "utf8"), before);
});

test("a confirmation form's sealed state is still accepted twelve hours after it was sent", async () => {
  const codec = formStateCodec();
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const state = await codec.mint({ tool: "stage", args: "a", kind: "spend", id: "b" });
    mock.timers.tick(12 * 60 * 60 * 1000);
    const payload = await codec.verify(state, {} as ServerContext);
    assert.equal(payload.tool, "stage");
  } finally {
    mock.timers.reset();
  }
});
