import "./fixtures/env.ts";
import { approve, SCRIPTED_LIMIT, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { ProviderError } from "../src/errors.ts";
import { redact } from "../src/redact.ts";
import { shelterSpec, syntheticWorld, writeStyleBible } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const errorsModule = pathToFileURL(join(root, "src", "errors.ts")).href;
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

const GATEWAY = ["AI", "GATEWAY", "API", "KEY"].join("_");
/** A synthetic key value, built at run time so no tracked file holds it. */
const KEY_VALUE = `agk-test-${"fedcba9876543210".split("").reverse().join("")}-synthetic`;
const BEARER = `sk-test-${"9".repeat(4)}abcdefghijklmnop`;
const LEAK = `upstream refused key ${KEY_VALUE}; request had Authorization: Bearer ${BEARER}`;

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const name of REFUSED_VARIABLES) {
    delete env[name];
    delete env[name.toLowerCase()];
  }
  return { ...env, [GATEWAY]: KEY_VALUE };
}

function assertRedacted(text: string, where: string): void {
  assert.ok(!text.includes(KEY_VALUE), `${where} holds the key value`);
  assert.ok(!text.includes(BEARER), `${where} holds the bearer token`);
}

/** A world and a provider script whose image call throws a ProviderError carrying the key. */
async function leakingStage() {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "BIBLE.md");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeStyleBible(bible, world.bible);
  await writeFile(profile, JSON.stringify(world.profile));
  const script = join(world.dir, "leak.mjs");
  await writeFile(
    script,
    [
      `import { ProviderError } from ${JSON.stringify(errorsModule)};`,
      `const leak = ${JSON.stringify(LEAK.replace(KEY_VALUE, "\u0000"))}.replace("\\u0000", process.env[${JSON.stringify(GATEWAY)}]);`,
      `export default {`,
      `  image() { throw new ProviderError(leak); },`,
      `  vision() { throw new ProviderError(leak); },`,
      `};`,
    ].join("\n"),
  );
  approve(script);
  return { world, spec, bible, profile, script };
}

test("redact replaces key values and masks credential headers", () => {
  const env = { [GATEWAY]: KEY_VALUE };
  const out = redact(LEAK, env);
  assert.match(out, new RegExp(`\\[redacted:${GATEWAY}\\]`));
  assert.match(out, /Authorization: \[redacted:authorization\]/);
  assertRedacted(out, "redact");
  assert.equal(redact(`Bearer ${BEARER}`, {}), "Bearer [redacted:bearer]");
  assert.equal(redact(`x-api-key: ${BEARER}`, {}), "x-api-key: [redacted:x-api-key]");
  assert.equal(
    redact(`Authorization: Key ${BEARER}:secret`, {}),
    "Authorization: [redacted:authorization]",
  );
  assert.equal(redact("the key pose is approved", env), "the key pose is approved");
});

test("a ProviderError's message is redacted", () => {
  const saved = process.env[GATEWAY];
  process.env[GATEWAY] = KEY_VALUE;
  try {
    const error = new ProviderError(LEAK);
    assertRedacted(error.message, "ProviderError");
    assert.match(error.message, /\[redacted:/);
  } finally {
    if (saved === undefined) delete process.env[GATEWAY];
    else process.env[GATEWAY] = saved;
  }
});

test("a ProviderError carrying a key shows [redacted:...] in stderr and the --json document", async () => {
  const { world, spec, bible, profile, script } = await leakingStage();
  const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [
        "src/cli.ts",
        "stage",
        "--spec",
        spec,
        "--bible",
        bible,
        "--profile",
        profile,
        "--runs",
        world.runsDir,
        "--candidates",
        "1",
        "--provider-script",
        script,
        "--json",
      ],
      { cwd: root, env: childEnv() },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
  assert.equal(r.code, 4, r.stderr);
  const doc = JSON.parse(r.stdout) as { error: { code: string; message: string } };
  assert.equal(doc.error.code, "provider_error");
  assert.match(doc.error.message, /\[redacted:/);
  assert.match(r.stderr, /\[redacted:/);
  assertRedacted(r.stdout, "stdout");
  assertRedacted(r.stderr, "stderr");
});

test("a ProviderError carrying a key shows [redacted:...] in the MCP error text", async () => {
  const { world, spec, bible, profile, script } = await leakingStage();
  const client = new Client({ name: "assetgrove-redact-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--provider-script", script],
    cwd: root,
    env: childEnv(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  await client.connect(transport);
  clients.push(client);
  const result = await client.callTool({
    name: "stage",
    arguments: { spec, bible, profile, runs: world.runsDir, candidates: 1 },
  });
  assert.equal(result.isError, true);
  const content = result.content as { type: string; text: string }[];
  const text = content.map((c) => c.text).join("\n");
  const doc = JSON.parse(content[0]!.text) as { error: { code: string; message: string } };
  assert.equal(doc.error.code, "provider_error");
  assert.match(doc.error.message, /\[redacted:/);
  assertRedacted(text, "MCP text");
  assertRedacted(JSON.stringify(result.structuredContent), "MCP structuredContent");
  assertRedacted(stderr, "MCP stderr");
});

test("a custom keyEnv's value is redacted on a free command, where no guard runs", async () => {
  const name = "ASSETGROVE_TEST_OWN_KEY";
  const value = `own-${"abcdef0123456789".split("").reverse().join("")}-synthetic`;
  const world = await syntheticWorld();
  const script = join(world.dir, "echo-limit.mjs");
  await writeFile(
    script,
    [
      `export default {`,
      `  image() { throw new Error("unused"); },`,
      `  vision() { throw new Error("unused"); },`,
      `  limitReading() { throw new Error("upstream echoed " + process.env[${JSON.stringify(name)}]); },`,
      `};`,
    ].join("\n"),
  );
  approve(script);
  writeSettings({ providers: { scripted: { limit: { ...SCRIPTED_LIMIT }, keyEnv: name } } });
  const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      ["src/cli.ts", "spend", "check", "--provider-script", script, "--json"],
      { cwd: root, env: { ...childEnv(), [name]: value } },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
  assert.match(r.stdout, new RegExp(`upstream echoed \\[redacted:${name}\\]`), r.stderr);
  assert.ok(!r.stdout.includes(value), "stdout holds the key value");
  assert.ok(!r.stderr.includes(value), "stderr holds the key value");
});
