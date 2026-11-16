/**
 * settings change (design section 7): a person's confirmation writes caps, a provider limit and
 * hold acknowledgements into the settings file and nothing else. Over MCP with the official client
 * the form shows the proposed values and an accept writes them (method elicitation); headless
 * settings exit 8 and write nothing; without elicitation the request is saved as pending and
 * `confirm <id>` at a terminal writes it (method terminal).
 */
import "./fixtures/env.ts";
import {
  settingsPath,
  stateDir,
  useAttended,
  useHeadless,
  writeSettings,
  approve,
  approveProfile,
} from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { commands } from "../src/commands/registry.ts";
import { parseCommandLine, runCommand } from "../src/commands/runner.ts";
import type { ConfirmPort } from "../src/confirm/prompt.ts";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { loadSettings } from "../src/settings.ts";
import { applySettingsChange } from "../src/settings-write.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
type Form = ElicitRequest["params"];
type Answer = (form: Form) => Promise<ElicitResult> | ElicitResult;

const root = fileURLToPath(new URL("..", import.meta.url));
const freeScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const CLIENT = "assetgrove-settings-test";
const GATEWAY = "vercel-ai-gateway";

const temporary: string[] = [];
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

const read = (): string => readFileSync(settingsPath, "utf8");
const readDoc = (): Doc => JSON.parse(read()) as Doc;

async function paidScript(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-settings-confirm-")));
  temporary.push(dir);
  const script = join(dir, "paid.mjs");
  await writeFile(
    script,
    `import base from ${JSON.stringify(pathToFileURL(freeScript).href)};\nexport default { ...base, paid: true };\n`,
  );
  approve(script);
  return script;
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["AI_GATEWAY_API_KEY"];
  for (const name of REFUSED_VARIABLES) {
    delete env[name];
    delete env[name.toLowerCase()];
  }
  return env;
}

/** The official client over stdio; with `answer` it declares form elicitation and answers with it. */
async function connect(answer?: Answer): Promise<{ client: Client; forms: Form[] }> {
  const forms: Form[] = [];
  const client = new Client(
    { name: CLIENT, version: "0.0.0" },
    {
      ...(answer && { capabilities: { elicitation: { form: {} } } }),
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  if (answer) {
    client.setRequestHandler("elicitation/create", async (request) => {
      forms.push(request.params);
      return answer(request.params);
    });
  }
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
  return { client, forms };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Doc> {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as Doc;
}

const properties = (form: Form): Record<string, Doc> =>
  (form as unknown as { requestedSchema: { properties: Record<string, Doc> } }).requestedSchema
    .properties;

/** Accepts a form unchanged: every field submitted at its default. */
const acceptUnchanged: Answer = (form) => ({
  action: "accept",
  content: Object.fromEntries(Object.entries(properties(form)).map(([k, v]) => [k, v["default"]])),
});

interface Result {
  code: number | null;
  stdout: string;
}

/** The CLI in a child process with no TTY. */
function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env: childEnv(), maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) =>
        resolve({ code: error ? ((error.code as unknown as number | null) ?? null) : 0, stdout }),
    );
    child.stdin?.end();
  });
}

function port(answer: boolean): ConfirmPort {
  return { method: "tty", confirm: async () => answer };
}

async function inProcess(argv: string[], prompt?: ConfirmPort) {
  const [name, ...rest] = argv;
  const command = commands.find((c) => c.name === name);
  assert.ok(command, name);
  const { args } = parseCommandLine(command, rest);
  return runCommand(command, args, {
    settings: loadSettings(),
    log: () => {},
    ...(prompt && { prompt }),
  });
}

let rounds = 0;

/** A paid stage through the CLI with the given script. */
async function paidStage(script: string): Promise<Result> {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  approveProfile(world.profile, { targetDir: world.targetDir });
  return cli([
    "stage",
    ...["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir],
    ...["--candidates", "1", "--round", String(++rounds), "--json", "--provider-script", script],
  ]);
}

const errorCode = (r: Result): string | undefined => (JSON.parse(r.stdout) as Doc)["error"]?.code;

test("an accepted form writes the cap, the new gateway limit and their confirmedBy entries, and no other byte changes", async () => {
  useAttended();
  const before = read();
  const { client, forms } = await connect(acceptUnchanged);
  const doc = await call(client, "settings_change", {
    runUsd: 7,
    provider: GATEWAY,
    limitKind: "prepaid",
    limitUsd: 20,
    limitPeriod: "monthly",
  });
  assert.equal(doc["exitCode"], 0, JSON.stringify(doc["error"]));
  assert.equal(forms.length, 1);
  const shown = properties(forms[0]!);
  assert.equal(shown["runUsd"]!["default"], 7);
  assert.equal(shown["limitKind"]!["default"], "prepaid");
  assert.equal(shown["limitUsd"]!["default"], 20);
  assert.equal(shown["limitPeriod"]!["default"], "monthly");
  assert.equal(shown["acceptUnlimited"]!["type"], "boolean");

  const after = readDoc();
  assert.equal(after["caps"].runUsd, 7);
  assert.deepEqual(after["providers"][GATEWAY], {
    limit: { kind: "prepaid", usd: 20, period: "monthly" },
  });
  const confirmed = after["confirmedBy"] as Doc;
  assert.deepEqual(Object.keys(confirmed).sort(), ["caps.runUsd", `providers.${GATEWAY}.limit`]);
  for (const entry of Object.values(confirmed)) {
    assert.equal(entry.method, "elicitation");
    assert.equal(entry.client, CLIENT);
  }

  delete after["caps"].runUsd;
  if (Object.keys(after["caps"]).length === 0) delete after["caps"];
  delete after["providers"][GATEWAY];
  delete after["confirmedBy"];
  assert.equal(`${JSON.stringify(after, null, 2)}\n`, before);
});

/** Each `confirmedBy` time in `text` replaced by a fixed one, so a written file compares as text. */
const fixedTimes = (text: string): string => text.replace(/"at": ?"[^"]+"/g, '"at": "T"');

test("a change to a hand-laid file inserts its fields and leaves every other byte as it was", async () => {
  const hand = [
    "{",
    `  "format": "assetgrove-settings/1",`,
    `  "stateDir": ${JSON.stringify(stateDir)},`,
    `  "caps":   { "dailyUsd": 10 },`,
    `  "providers": {`,
    `    "scripted": { "limit": { "kind": "prepaid", "usd": 100 } }`,
    `  },`,
    `  "extensions": ["a", "b"],`,
    `  "reconcile": { "marginUsd": 0.05 }`,
    "}",
    "",
  ].join("\n");
  await writeFile(settingsPath, hand);
  await applySettingsChange(
    loadSettings(),
    {
      caps: { runUsd: 7 },
      limit: { provider: GATEWAY, limit: { kind: "prepaid", usd: 20, period: "monthly" } },
    },
    { method: "terminal" },
  );
  const expected = [
    "{",
    `  "format": "assetgrove-settings/2",`,
    `  "stateDir": ${JSON.stringify(stateDir)},`,
    `  "caps":   { "dailyUsd": 10, "runUsd": 7 },`,
    `  "providers": {`,
    `    "scripted": { "limit": { "kind": "prepaid", "usd": 100 } },`,
    `    "${GATEWAY}": {`,
    `      "limit": {`,
    `        "kind": "prepaid",`,
    `        "usd": 20,`,
    `        "period": "monthly"`,
    `      }`,
    `    }`,
    `  },`,
    `  "extensions": ["a", "b"],`,
    `  "reconcile": { "marginUsd": 0.05 },`,
    `  "confirmedBy": {`,
    `    "caps.runUsd": {`,
    `      "method": "terminal",`,
    `      "at": "T"`,
    `    },`,
    `    "providers.${GATEWAY}.limit": {`,
    `      "method": "terminal",`,
    `      "at": "T"`,
    `    }`,
    `  }`,
    "}",
    "",
  ].join("\n");
  assert.equal(fixedTimes(read()), expected);
});

test("a second change with the settings loaded before the first keeps what the first wrote", async () => {
  useAttended();
  const holds = ["e1e1e1e1e1e1e1e1", "e2e2e2e2e2e2e2e2"];
  await mkdir(stateDir, { recursive: true });
  for (const id of holds) {
    const hold = { id, at: new Date().toISOString(), provider: "scripted", runId: "r" };
    await appendFile(
      join(stateDir, "holds.jsonl"),
      `${JSON.stringify({ ...hold, ledgerUsd: 1, providerUsd: 2, gapUsd: 1 })}\n`,
    );
  }
  const loadedOnce = loadSettings();
  const limit = { provider: GATEWAY, limit: { kind: "prepaid" as const, usd: 20 } };
  await applySettingsChange(
    loadedOnce,
    { acknowledgeHolds: [holds[0]!], limit },
    { method: "terminal" },
  );
  // A person adds the key variable by hand between the two changes.
  const doc = readDoc();
  doc["providers"][GATEWAY].keyEnv = "AI_GATEWAY_API_KEY";
  await writeFile(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);
  await applySettingsChange(
    loadedOnce,
    { acknowledgeHolds: [holds[1]!], limit: { ...limit, limit: { kind: "prepaid", usd: 30 } } },
    { method: "terminal" },
  );
  const after = readDoc();
  await rm(join(stateDir, "holds.jsonl"), { force: true });
  assert.deepEqual(after["spend"].acknowledgedHolds, holds);
  assert.deepEqual(after["providers"][GATEWAY], {
    limit: { kind: "prepaid", usd: 30 },
    keyEnv: "AI_GATEWAY_API_KEY",
  });
});

test("the settings_change input schema names no adapter, route or environment property and requires user interaction", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "settings_change");
  assert.ok(tool);
  const names = Object.keys((tool.inputSchema as { properties: object }).properties);
  assert.ok(names.includes("runUsd"));
  const forbidden = [
    "headless",
    "adapter",
    "baseURL",
    "keyEnv",
    "roles",
    "routes",
    "extensions",
    "environment",
    "commands",
  ];
  for (const name of names) {
    assert.ok(!forbidden.includes(name), name);
    for (const word of forbidden) assert.ok(!name.toLowerCase().includes(word.toLowerCase()), name);
  }
  assert.equal(tool._meta?.["anthropic/requiresUserInteraction"], true);
});

test("unlimited without acceptUnlimited is not written and a paid call still exits 3 provider_limit_undeclared", async () => {
  writeSettings({ providers: { scripted: {} } });
  useAttended();
  const { client, forms } = await connect(acceptUnchanged);
  const doc = await call(client, "settings_change", {
    provider: "scripted",
    limitKind: "unlimited",
    acceptUnlimited: false,
  });
  assert.equal(doc["exitCode"], 0, JSON.stringify(doc["error"]));
  assert.equal(forms.length, 1);
  assert.equal(properties(forms[0]!)["acceptUnlimited"]!["default"], false);
  assert.equal(doc["notWritten"].length, 1);
  assert.equal("limit" in readDoc()["providers"].scripted, false);

  useHeadless();
  const run = await paidStage(await paidScript());
  assert.equal(run.code, 3, run.stdout);
  assert.equal(errorCode(run), "provider_limit_undeclared");
});

test("headless settings exit 8 and write nothing; attended without elicitation saves a pending request that confirm writes", async () => {
  const headlessBytes = read();
  const refused = await cli(["settings", "change", "--run-usd", "7", "--json"]);
  assert.equal(refused.code, 8, refused.stdout);
  assert.equal(errorCode(refused), "confirmation_required");
  assert.equal(read(), headlessBytes);
  assert.equal(
    existsSync(join(stateDir, "pending")) ? (await readdir(join(stateDir, "pending"))).length : 0,
    0,
  );

  useAttended();
  const attendedBytes = read();
  const asked = await cli(["settings", "change", "--run-usd", "7", "--json"]);
  assert.equal(asked.code, 8, asked.stdout);
  const confirmation = (JSON.parse(asked.stdout) as Doc)["error"].confirmation;
  assert.equal(confirmation.kind, "settings");
  assert.equal(read(), attendedBytes);
  assert.ok(existsSync(join(stateDir, "pending", `${confirmation.id}.json`)));

  const outcome = await inProcess(["confirm", confirmation.id], port(true));
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.error));
  const after = readDoc();
  assert.equal(after["caps"].runUsd, 7);
  assert.equal(after["confirmedBy"]["caps.runUsd"].method, "terminal");
});

test("acknowledging a hold through the tool clears spend_hold", async () => {
  const script = await paidScript();
  const hold = {
    id: "0123456789abcdef",
    at: new Date().toISOString(),
    provider: "scripted",
    runId: "earlier-run",
    ledgerUsd: 1,
    providerUsd: 2,
    gapUsd: 1,
  };
  await mkdir(stateDir, { recursive: true });
  await appendFile(join(stateDir, "holds.jsonl"), `${JSON.stringify(hold)}\n`);
  const held = await paidStage(script);
  assert.equal(held.code, 3, held.stdout);
  assert.equal(errorCode(held), "spend_hold");

  useAttended();
  const { client } = await connect(acceptUnchanged);
  const doc = await call(client, "settings_change", { acknowledgeHolds: [hold.id] });
  assert.equal(doc["exitCode"], 0, JSON.stringify(doc["error"]));
  assert.deepEqual(readDoc()["spend"].acknowledgedHolds, [hold.id]);

  useHeadless();
  const freed = await paidStage(script);
  assert.equal(freed.code, 0, freed.stdout);
});
