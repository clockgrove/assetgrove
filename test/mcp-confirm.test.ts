/**
 * Confirmation through the harness, over MCP (design section 7), with the official client over
 * stdio: a client that declares form elicitation gets inputRequired forms for stage's spend, pick's
 * candidate and an unapproved validator; accept writes the configDir record (method `elicitation`,
 * the client's name and protocol version), decline exits 8 `confirmation_declined`, a request that
 * changed while the form was open exits 2 `plan_changed`, and a client without form elicitation
 * gets exit 8 `confirmation_required`. A 2025-era client answering `elicitation/create` is served
 * by the SDK's shim.
 */
import "./fixtures/env.ts";
import { approvalsDir, approve, confirmationsDir, stateDir, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { confirmCommand } from "../src/commands/confirm.ts";
import { runCommand } from "../src/commands/runner.ts";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { decodeImage, encodePng } from "../src/image/raster.ts";
import { loadSettings } from "../src/settings.ts";
import { gitTarget } from "./fixtures/git.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
type Answer = (form: ElicitRequest["params"]) => Promise<ElicitResult> | ElicitResult;

const root = fileURLToPath(new URL("..", import.meta.url));
const freeScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const MODERN = "2026-07-28";
const CLIENT = "assetgrove-confirm-test";

const temporary: string[] = [];
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  temporary.push(dir);
  return dir;
}

/** A paid scripted provider (the fixture script with `paid: true`), approved. */
async function paidScript(): Promise<string> {
  const dir = await tempDir("assetgrove-mcp-confirm-");
  const script = join(dir, "paid.mjs");
  await writeFile(
    script,
    `import base from ${JSON.stringify(pathToFileURL(freeScript).href)};\nexport default { ...base, paid: true };\n`,
  );
  approve(script);
  return script;
}
approve(freeScript);

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

/**
 * Starts `assetgrove mcp --provider-script <script>` and connects the official client. With
 * `answer` the client declares form elicitation and answers each form with it; `era` picks the
 * 2026-07-28 revision (inputRequired) or the 2025 one (the server sends `elicitation/create`).
 */
async function connect(
  script: string,
  answer?: Answer,
  era: "modern" | "legacy" = "modern",
): Promise<{ client: Client; forms: ElicitRequest["params"][] }> {
  const forms: ElicitRequest["params"][] = [];
  const client = new Client(
    { name: CLIENT, version: "0.0.0" },
    {
      ...(answer && { capabilities: { elicitation: { form: {} } } }),
      ...(era === "modern" && { versionNegotiation: { mode: { pin: MODERN } } }),
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
      args: ["src/cli.ts", "mcp", "--provider-script", script],
      cwd: root,
      env: childEnv(),
      stderr: "pipe",
    }),
  );
  clients.push(client);
  return { client, forms };
}

/** Each world's stage request is its own (a round of its own), so no earlier record covers it. */
let rounds = 0;

/** A synthetic world and the stage arguments of one candidate in it. */
async function stageWorld() {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  gitTarget(world.targetDir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  return {
    world,
    spec,
    args: { spec, bible, profile, runs: world.runsDir, candidates: 1, round: ++rounds },
  };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Doc> {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as Doc;
}

const fields = (form: ElicitRequest["params"]) =>
  Object.keys((form as { requestedSchema: { properties: object } }).requestedSchema.properties);

/** Accepts every form: approves spend, write and command forms and picks `candidate`. */
const acceptAll =
  (candidate = "c1"): Answer =>
  (form): ElicitResult =>
    fields(form).includes("candidate")
      ? { action: "accept", content: { candidate, note: "chosen in the form" } }
      : { action: "accept", content: { approve: true } };

const record = async (digest: string) =>
  JSON.parse(await readFile(join(confirmationsDir, `${digest}.json`), "utf8")) as Doc;

/** A run staged without a spend confirmation (the free script forecasts nothing). */
async function stagedRun() {
  const staging = await stageWorld();
  const { client } = await connect(freeScript);
  const staged = await call(client, "stage", staging.args);
  assert.equal(staged["exitCode"], 0, JSON.stringify(staged["error"]));
  return { ...staging, runDir: staged["runDir"] as string };
}

test("stage over MCP: an accepted spend form writes the record (method elicitation, client, protocol version) and run.json carries it", async () => {
  useAttended();
  const { args } = await stageWorld();
  const { client, forms } = await connect(await paidScript(), acceptAll());
  const doc = await call(client, "stage", args);
  assert.equal(doc["exitCode"], 0, JSON.stringify(doc["error"]));
  assert.equal(forms.length, 1);
  assert.deepEqual(fields(forms[0]!), ["approve"]);
  assert.match(forms[0]!.message, /forecastUsd/);
  assert.match(forms[0]!.message, /digest/);
  const saved = await record(doc["digest"]);
  assert.equal(saved["method"], "elicitation");
  assert.equal(saved["kind"], "spend");
  assert.equal(saved["client"], CLIENT);
  assert.equal(saved["protocolVersion"], MODERN);
  assert.equal(saved["toolMarkedRequiresUser"], true);
  const run = JSON.parse(await readFile(join(doc["runDir"], "run.json"), "utf8")) as Doc;
  assert.equal(run["confirmation"].method, "elicitation");
  assert.equal(run["confirmation"].client, CLIENT);
});

test("stage over MCP: declining the spend form exits 8 confirmation_declined and writes no record", async () => {
  useAttended();
  const { args } = await stageWorld();
  const { client, forms } = await connect(await paidScript(), () => ({ action: "decline" }));
  const doc = await call(client, "stage", args);
  assert.equal(forms.length, 1);
  assert.equal(doc["exitCode"], 8);
  assert.equal(doc["error"].code, "confirmation_declined");
  assert.equal(existsSync(join(confirmationsDir, `${doc["error"].confirmation.id}.json`)), false);
});

test("stage over MCP: a cancelled spend form leaves the request pending, and its confirmCommand completes it", async () => {
  useAttended();
  const { args } = await stageWorld();
  const { client } = await connect(await paidScript(), () => ({ action: "cancel" }));
  const doc = await call(client, "stage", args);
  assert.equal(doc["exitCode"], 8);
  assert.equal(doc["error"].code, "confirmation_declined");
  const { id, confirmCommand: command } = doc["error"].confirmation;
  assert.equal(command, `assetgrove confirm ${id}`);
  assert.ok(existsSync(join(stateDir, "pending", `${id}.json`)), "the request is pending");
  const confirmed = await runCommand(
    confirmCommand,
    { id },
    {
      settings: loadSettings(),
      log: () => {},
      prompt: { method: "tty", confirm: async () => true },
    },
  );
  assert.equal(confirmed.exitCode, 0, confirmed.error?.message);
  assert.equal((await record(id))["method"], "terminal");
});

test("stage over MCP: a client without form elicitation gets exit 8 confirmation_required", async () => {
  useAttended();
  const { args } = await stageWorld();
  const { client } = await connect(await paidScript());
  const doc = await call(client, "stage", args);
  assert.equal(doc["exitCode"], 8);
  assert.equal(doc["error"].code, "confirmation_required");
  assert.equal(doc["error"].confirmation.kind, "spend");
});

test("stage over MCP: a spec changed while the form is open exits 2 plan_changed", async () => {
  useAttended();
  const { args, spec } = await stageWorld();
  const { client } = await connect(await paidScript(), async () => {
    await appendFile(spec, "\n");
    return { action: "accept", content: { approve: true } };
  });
  const doc = await call(client, "stage", args);
  assert.equal(doc["exitCode"], 2);
  assert.equal(doc["error"].code, "plan_changed");
});

test("stage over MCP: a 2025-era client answering elicitation/create completes a stage", async () => {
  useAttended();
  const { args } = await stageWorld();
  const { client, forms } = await connect(await paidScript(), acceptAll(), "legacy");
  const doc = await call(client, "stage", args);
  assert.equal(doc["exitCode"], 0, JSON.stringify(doc["error"]));
  assert.equal(forms.length, 1);
  const saved = await record(doc["digest"]);
  assert.equal(saved["method"], "elicitation");
  assert.equal(saved["client"], CLIENT);
  assert.notEqual(saved["protocolVersion"], MODERN);
});

test("pick over MCP: the pick form chooses the candidate, the unapproved validator elicits a command form, and accept writes both", async () => {
  const { world, runDir } = await stagedRun();
  useAttended();
  const { client, forms } = await connect(freeScript, acceptAll("c1"));
  const doc = await call(client, "pick", { run: runDir, target: world.targetDir });
  assert.equal(doc["exitCode"], 0, JSON.stringify(doc["error"]));
  assert.deepEqual(forms.map(fields), [["candidate", "note"], ["approve"]]);
  const pickForm = forms[0] as { requestedSchema: { properties: Record<string, unknown> } };
  const pickSchema = pickForm.requestedSchema.properties["candidate"] as { enum: string[] };
  assert.deepEqual(pickSchema.enum, ["c1", "none"]);
  assert.match(forms[0]!.message, /contactSheet/);
  assert.match(forms[1]!.message, /validator/);
  assert.equal(doc["confirmation"].method, "elicitation");
  assert.equal(doc["confirmation"].choice, "c1");
  assert.equal("note" in doc["confirmation"], false);
  const saved = await record(doc["confirmation"].digest);
  assert.equal(saved["client"], CLIENT);
  assert.equal(saved["protocolVersion"], MODERN);
  const hash = /hash: ([0-9a-f]{64})/.exec(forms[1]!.message)![1]!;
  const approval = JSON.parse(await readFile(join(approvalsDir, `${hash}.json`), "utf8")) as Doc;
  assert.equal(approval["kind"], "validator");
  assert.equal(approval["method"], "elicitation");
  assert.equal(doc["validator"].accepted, true);
});

test("pick over MCP: choosing none declines with exit 8 confirmation_declined", async () => {
  const { world, runDir } = await stagedRun();
  useAttended();
  const { client } = await connect(freeScript, () => ({
    action: "accept",
    content: { candidate: "none" },
  }));
  const doc = await call(client, "pick", { run: runDir, target: world.targetDir });
  assert.equal(doc["exitCode"], 8);
  assert.equal(doc["error"].code, "confirmation_declined");
  assert.equal(doc["error"].confirmation.kind, "pick");
});

test("pick over MCP: a client without form elicitation gets exit 8 confirmation_required", async () => {
  const { world, runDir } = await stagedRun();
  useAttended();
  const { client } = await connect(freeScript);
  const doc = await call(client, "pick", { run: runDir, target: world.targetDir });
  assert.equal(doc["exitCode"], 8);
  assert.equal(doc["error"].code, "confirmation_required");
  assert.equal(doc["error"].confirmation.kind, "pick");
});

test("pick over MCP: a run changed while the form is open exits 2 plan_changed", async () => {
  const { world, runDir } = await stagedRun();
  useAttended();
  const runFile = join(runDir, "run.json");
  const { client } = await connect(freeScript, async () => {
    const run = JSON.parse(await readFile(runFile, "utf8")) as Doc;
    run["candidates"][0].sha256 = "0".repeat(64);
    await writeFile(runFile, JSON.stringify(run));
    return { action: "accept", content: { candidate: "c1" } };
  });
  const doc = await call(client, "pick", { run: runDir, target: world.targetDir });
  assert.equal(doc["exitCode"], 2, JSON.stringify(doc["error"]));
  assert.equal(doc["error"].code, "plan_changed");
});

test("library adopt over MCP: the pick form names the run and its profile, and accepting it adopts the hand edit", async () => {
  const staging = await stageWorld();
  const { world } = staging;
  const runs = join(world.targetDir, ".assetgrove", "runs");
  const { client: stager } = await connect(freeScript);
  const staged = await call(stager, "stage", { ...staging.args, runs });
  assert.equal(staged["exitCode"], 0, JSON.stringify(staged["error"]));
  useAttended();
  const { client, forms } = await connect(freeScript, (form): ElicitResult => {
    const schema = (
      form as { requestedSchema: { properties: Record<string, { enum?: string[] }> } }
    ).requestedSchema.properties;
    return schema["candidate"]
      ? { action: "accept", content: { candidate: schema["candidate"].enum![0]! } }
      : { action: "accept", content: { approve: true } };
  });
  const picked = await call(client, "pick", {
    run: staged["runDir"] as string,
    candidate: "c1",
    target: world.targetDir,
  });
  assert.equal(picked["exitCode"], 0, JSON.stringify(picked["error"]));

  // A person swaps the colours of two opaque pixels: the palette and the bounds stay.
  const media = join(world.targetDir, "assets/source/fern/shelter.png");
  const original = join(world.dir, "original.png");
  await writeFile(original, await readFile(media));
  const raster = decodeImage(new Uint8Array(await readFile(media)));
  const rgb = (p: number) => [...raster.data.subarray(p, p + 3)].join();
  const opaque = [...Array(raster.width * raster.height).keys()]
    .map((n) => n * 4)
    .filter((p) => raster.data[p + 3] === 255);
  const a = opaque[0]!;
  const b = opaque.find((p) => rgb(p) !== rgb(a))!;
  const colour = raster.data.slice(a, a + 3);
  raster.data.copyWithin(a, b, b + 3);
  raster.data.set(colour, b);
  await writeFile(media, encodePng(raster));

  forms.length = 0;
  const doc = await call(client, "library_adopt", {
    address: join(world.targetDir, "assets/source/fern/fern-shelter.md"),
    original,
    target: world.targetDir,
  });
  assert.equal(doc["exitCode"], 0, JSON.stringify(doc["error"]));
  assert.equal(forms.length, 1);
  assert.match(forms[0]!.message, /profile synthetic-grove \(sha256 [0-9a-f]{64}\)/);
  assert.match(forms[0]!.message, /of the run \S+ \(/);
  assert.equal(doc["confirmation"].method, "elicitation");
  assert.equal(doc["version"], 2);
  const saved = await record(doc["confirmation"].digest);
  assert.equal(saved["client"], CLIENT);
});
