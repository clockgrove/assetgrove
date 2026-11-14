import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { commands } from "../src/commands/registry.ts";
import { flagName } from "../src/commands/runner.ts";
import type { CommandSpec } from "../src/commands/types.ts";
import { encodePng } from "../src/image/raster.ts";
import {
  drawSubject,
  shelterSpec,
  syntheticProfile,
  syntheticWorld,
} from "./fixtures/synthetic.ts";

type Args = Record<string, unknown>;
type Doc = Record<string, unknown>;

const root = fileURLToPath(new URL("..", import.meta.url));
const synthetic = fileURLToPath(new URL("./fixtures/synthetic.ts", import.meta.url));
const raster = fileURLToPath(new URL("../src/image/raster.ts", import.meta.url));
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

/** The environment of every child: the test settings and ledger, and no model key. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["AI_GATEWAY_API_KEY"];
  return { ...env, ...extra };
}

/** Starts `assetgrove mcp` with the given flags over stdio and connects a client to it. */
async function connect(flags: string[], env: Record<string, string> = childEnv()) {
  const client = new Client({ name: "assetgrove-mcp-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", ...flags],
    cwd: root,
    env,
    stderr: "pipe",
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function cli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...argv],
      { cwd: root, env: childEnv(), timeout: 60_000 },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

const spec = (tool: string): CommandSpec => commands.find((c) => c.tool === tool)!;

/** A tool call's arguments as the command line of its command, with the server's script and --json. */
function commandLine(command: CommandSpec, args: Args, script: string): string[] {
  const positionals = new Set((command.positionals ?? []).map((p) => p.name));
  const argv = [command.name];
  for (const p of command.positionals ?? []) {
    const value = args[p.name];
    if (Array.isArray(value)) argv.push(...value.map(String));
    else if (value !== undefined) argv.push(String(value));
  }
  for (const [name, value] of Object.entries(args)) {
    if (positionals.has(name)) continue;
    if (value === true) argv.push(`--${flagName(name)}`);
    else if (Array.isArray(value)) for (const v of value) argv.push(`--${flagName(name)}`, v);
    else argv.push(`--${flagName(name)}`, String(value));
  }
  if ("providerScript" in command.input.properties) argv.push("--provider-script", script);
  return [...argv, "--json"];
}

/**
 * What legitimately differs between two runs of one command: run IDs, times, random seeds and
 * what hashes them.
 */
function normalise(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]+/g, "<run>")
      .replace(/"(durationMs|elapsedMs|seed)":\d+(\.\d+)?/g, '"$1":0')
      // A plan's digest covers its creation time.
      .replace(/"digest":"[0-9a-f]{64}"/g, '"digest":"<digest>"'),
  );
}

/** The scripted provider every tool and command call shares: images pass QA, plans compile. */
async function writeScript(dir: string): Promise<string> {
  const path = join(dir, "provider.mjs");
  const checks = ["transparency", "frame-count", "identity", "perspective", "style"];
  await writeFile(
    path,
    `import { pathToFileURL } from "node:url";
const { drawSubject } = await import(pathToFileURL(${JSON.stringify(synthetic)}));
const { encodePng } = await import(pathToFileURL(${JSON.stringify(raster)}));
export default {
  image(request) {
    const m = /frame (\\d+) of/.exec(request.prompt);
    return { images: [{ mediaType: "image/png", bytes: encodePng(drawSubject(96, m?.[1] ? Number(m[1]) : 0)) }] };
  },
  vision() {
    return { text: JSON.stringify({
      prompt: "A friendly round icon, flat cel shading, bold outlines.",
      negativePrompt: "No text or photographic textures.",
      violations: [], clamps: [], styleScore: 1, passed: true, reason: "scripted match",
      checks: ${JSON.stringify(checks)}.map((check) => ({ check, passed: true, reason: "ok" })),
    }) };
  },
};`,
  );
  return path;
}

let work: string;
let script: string;
let server: Client;

before(async () => {
  work = await tempDir("assetgrove-mcp-");
  script = await writeScript(work);
  server = await connect(["--provider-script", script]);
});

test("tools/list names equal the registry's tool names and no tool takes a CLI-only argument", async () => {
  const { tools } = await server.listTools();
  const expected = commands.flatMap((c) => (c.tool === null ? [] : [c.tool]));
  assert.deepEqual(tools.map((t) => t.name).sort(), [...expected].sort());
  assert.ok(!expected.includes("mcp"));
  for (const tool of tools) {
    const properties = Object.keys(tool.inputSchema.properties ?? {});
    for (const forbidden of ["providerScript", "json", "help", "dryRun", "routes", "autoApprove"])
      assert.ok(!properties.includes(forbidden), `${tool.name} takes ${forbidden}`);
    assert.ok(tool.outputSchema, `${tool.name} has an output schema`);
    const command = spec(tool.name);
    assert.equal(tool.annotations?.readOnlyHint, command.effect.readOnly, tool.name);
    assert.equal(tool.annotations?.openWorldHint, command.effect.spends !== "never", tool.name);
    assert.equal(
      tool.annotations?.destructiveHint,
      tool.name === "pick" || tool.name === "write_families",
      tool.name,
    );
  }
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Doc;
  assert.deepEqual(server.getServerVersion(), {
    name: version["name"],
    version: version["version"],
  });
});

/**
 * One row per tool: `prepare` builds what the call needs in the work directory and returns its
 * arguments. A row whose input would take a costly fixture is checked on its refusal document,
 * which is as much the CLI's --json document as a success.
 */
interface Row {
  tool: string;
  prepare: () => Promise<Args>;
  exitCode?: number;
}

const paths = {
  repo: () => join(work, "repo"),
  bible: () => join(work, "repo", ".assetgrove", "art-direction", "BIBLE.md"),
  world: () => join(work, "world"),
};

async function world() {
  const w = await syntheticWorld();
  await cp(w.dir, paths.world(), { recursive: true });
  await rm(w.dir, { recursive: true, force: true });
  const dir = paths.world();
  await writeFile(join(dir, "spec.json"), JSON.stringify(shelterSpec));
  await writeFile(join(dir, "bible", "bible.json"), JSON.stringify(w.bible));
  await writeFile(join(dir, "profile.json"), JSON.stringify(w.profile));
}

/** Arguments that name a missing file for each of a command's required inputs (1 for a number). */
function missing(tool: string): Args {
  const command = spec(tool);
  return Object.fromEntries(
    (command.input.required ?? []).map((name) => {
      const type = command.input.properties[name]!.type;
      const value =
        type === "integer" || type === "number"
          ? 1
          : type === "array"
            ? [join(work, `missing-${name}`)]
            : join(work, `missing-${name}`);
      return [name, value];
    }),
  );
}

const rows: Row[] = [
  { tool: "ops", prepare: async () => ({}) },
  {
    tool: "bible",
    prepare: async () => ({
      action: "init",
      directory: paths.repo(),
      world: "Synthetic Grove",
      preset: "flat-cartoon-kids",
    }),
  },
  { tool: "bible", prepare: async () => ({ action: "describe", bible: paths.bible() }) },
  {
    tool: "bible",
    prepare: async () => ({ action: "preset", bible: paths.bible(), preset: "cozy-storybook" }),
  },
  {
    tool: "plan",
    prepare: async () => {
      const dir = paths.repo();
      await writeFile(
        join(dir, "spec.json"),
        JSON.stringify({
          kind: "still",
          assetId: "icon",
          subject: "icon",
          animationFamily: "still",
        }),
      );
      await writeFile(join(dir, "profile.json"), JSON.stringify(syntheticProfile()));
      await writeFile(
        join(dir, "settings.json"),
        JSON.stringify({ candidates: 1, capUsd: 2, strictness: 0.5 }),
      );
      return {
        spec: join(dir, "spec.json"),
        bible: paths.bible(),
        profile: join(dir, "profile.json"),
        settings: join(dir, "settings.json"),
        out: join(dir, "plan.json"),
      };
    },
  },
  {
    tool: "apply",
    prepare: async () => {
      const plan = join(paths.repo(), "plan.json");
      const saved = JSON.parse(await readFile(plan, "utf8")) as Doc;
      await writeFile(plan, JSON.stringify({ ...saved, approved: true }));
      return { plan, out: join(paths.repo(), "runs") };
    },
  },
  {
    tool: "stage",
    prepare: async () => {
      await world();
      const dir = paths.world();
      return {
        spec: join(dir, "spec.json"),
        bible: join(dir, "bible", "bible.json"),
        profile: join(dir, "profile.json"),
        runs: join(dir, "runs"),
        candidates: 1,
      };
    },
  },
  {
    tool: "pick",
    prepare: async () => {
      const runs = join(paths.world(), "runs");
      const [run] = await readdir(runs);
      const target = join(work, "target");
      await mkdir(target, { recursive: true });
      return { run: join(runs, run!), candidate: "c1", target };
    },
  },
  {
    tool: "op",
    prepare: async () => {
      const input = join(work, "in.png");
      await writeFile(input, encodePng(drawSubject(48)));
      return { operation: "matte", inputs: [input], out: join(work, "out.png") };
    },
  },
  ...[
    "write_families",
    "import",
    "rig",
    "lod",
    "look_dev",
    "materials",
    "generate_sheet",
    "identity_eval",
    "identity_check",
    "animation_qa",
    "fix_frame",
    "recipe",
  ].map((tool) => ({ tool, prepare: async () => missing(tool), exitCode: 2 })),
];

test("every tool's structuredContent deep-equals the CLI --json document", async () => {
  const covered = new Set(rows.map((r) => r.tool));
  for (const c of commands) if (c.tool !== null) assert.ok(covered.has(c.tool), c.tool);
  for (const row of rows) {
    const args = await row.prepare();
    const label = `${row.tool} ${JSON.stringify(args)}`;
    // The command and the tool start from the same files: the work directory is restored between.
    const snapshot = `${work}.snapshot`;
    await rm(snapshot, { recursive: true, force: true });
    await cp(work, snapshot, { recursive: true });
    const ran = await cli(commandLine(spec(row.tool), args, script));
    const document = JSON.parse(ran.stdout) as Doc;
    await rm(work, { recursive: true, force: true });
    await cp(snapshot, work, { recursive: true });
    await rm(snapshot, { recursive: true, force: true });
    const result = await server.callTool({ name: row.tool, arguments: args });
    assert.equal(ran.code, row.exitCode ?? 0, `${label}: ${ran.stderr}`);
    assert.equal(result.isError, document["ok"] !== true, label);
    assert.deepEqual(normalise(result.structuredContent), normalise(document), label);
    const [text] = result.content as { type: string; text: string }[];
    assert.deepEqual(JSON.parse(text!.text), result.structuredContent, label);
  }
});

async function settingsFile(settings: Doc): Promise<string> {
  const dir = await tempDir("assetgrove-mcp-settings-");
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify({ format: "assetgrove-settings/1", ...settings }));
  return path;
}

const MARK = "anthropic/requiresUserInteraction";

test("the requiresUserInteraction mark follows confirm, and headless settings lift it from spend, pick and write tools", async () => {
  const confirmKinds = commands.filter((c) => c.tool !== null && c.confirm !== undefined);
  assert.ok(confirmKinds.some((c) => c.confirm === "spend"));
  assert.ok(confirmKinds.some((c) => c.confirm === "pick"));
  assert.ok(confirmKinds.some((c) => c.confirm === "write"));

  const attended = await connect([], childEnv({ ASSETGROVE_CONFIG: await settingsFile({}) }));
  for (const tool of (await attended.listTools()).tools) {
    const command = spec(tool.name);
    assert.equal(tool._meta?.[MARK] === true, command.confirm !== undefined, tool.name);
  }

  const headless = await connect(
    [],
    childEnv({ ASSETGROVE_CONFIG: await settingsFile({ headless: { operator: "ci:example" } }) }),
  );
  for (const tool of (await headless.listTools()).tools) {
    const command = spec(tool.name);
    if (command.confirm === "spend" || command.confirm === "pick" || command.confirm === "write")
      assert.equal(tool._meta?.[MARK], undefined, tool.name);
    else assert.equal(tool._meta?.[MARK] === true, command.confirm !== undefined, tool.name);
  }
});
