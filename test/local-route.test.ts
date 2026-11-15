import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AssetSpec, Provenance } from "../src/types.ts";
import { approveProfile, writeSettings } from "./fixtures/env.ts";
import { startOpenAiCompatibleServer } from "./fixtures/openai-compatible-server.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const connections = fileURLToPath(new URL("./fixtures/connections.ts", import.meta.url));

const stillSpec: AssetSpec = {
  kind: "still",
  assetId: "den",
  animationFamily: "idle",
  fields: { semantic: { role: "prop", entity: "grove.den" }, accessibilityLabel: "The den" },
};

const OWNED = { license: "MIT", plan: "local", commercial: true, relabel: true };

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], connectionLog: string): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", connections, "src/cli.ts", ...args],
      { cwd: root, env: { ...process.env, ASSETGROVE_TEST_CONNECTIONS: connectionLog } },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

/** The local-only recipe: image on one loopback server, vision, decisions and planning on chat. */
async function localOnly(baseURL: string): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), "assetgrove-local-"));
  const terms = "Local model licence (synthetic)";
  const route = (provider: string, model: string) => ({
    provider,
    model,
    outputGrant: OWNED,
    providerTerms: terms,
  });
  writeSettings({
    stateDir,
    providers: {
      images: { adapter: "openai-compatible", baseURL, free: true },
      chat: { adapter: "openai-compatible", baseURL, free: true },
    },
    roles: {
      image: route("images", "local-image"),
      vision: route("chat", "local-vision"),
      decisions: route("chat", "local-chat"),
      planning: route("chat", "local-chat"),
    },
  });
  return stateDir;
}

async function stageArgs(spec: AssetSpec): Promise<string[]> {
  const world = await syntheticWorld();
  approveProfile(world.profile, { targetDir: world.targetDir });
  const specPath = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(specPath, JSON.stringify(spec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  return [
    "stage",
    ...["--spec", specPath, "--bible", bible, "--profile", profile, "--runs", world.runsDir],
    ...["--candidates", "1", "--json"],
  ];
}

test("a still stages through the openai-compatible adapter against the loopback fixture server, with only loopback connections and no ledger entry", async () => {
  const server = await startOpenAiCompatibleServer();
  try {
    const stateDir = await localOnly(server.baseURL);
    const log = join(stateDir, "connections.jsonl");
    const r = await cli(await stageArgs(stillSpec), log);
    assert.equal(r.code, 0, r.stderr);
    const staged = JSON.parse(r.stdout) as { candidates: Array<{ provenance: Provenance }> };
    const routes = staged.candidates[0]!.provenance.calls.map((call) => call.route);
    assert.ok(routes.includes("images:still:local-image"), routes.join(", "));
    for (const route of routes) assert.match(route, /^(images|chat):/);

    const lines = (await readFile(log, "utf8")).trim().split("\n");
    assert.ok(lines.length >= 1);
    for (const line of lines) {
      const { host } = JSON.parse(line) as { host?: string };
      assert.ok(["127.0.0.1", "::1", "localhost"].includes(host ?? ""), line);
    }
    assert.ok(
      server.requests.some((q) => q.path.startsWith("/v1/images/")),
      JSON.stringify(server.requests),
    );
    assert.equal(existsSync(join(stateDir, "spend.jsonl")), false, "no ledger entry");
  } finally {
    await server.close();
  }
});

test("a sprite-strip without an edit route exits 2 route_unavailable", async () => {
  const server = await startOpenAiCompatibleServer();
  try {
    const stateDir = await localOnly(server.baseURL);
    const r = await cli(await stageArgs(shelterSpec), join(stateDir, "connections.jsonl"));
    assert.equal(r.code, 2, r.stderr);
    const document = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    assert.equal(document.error.code, "route_unavailable");
    assert.match(document.error.message, /edit operation \(role edit\)/);
    assert.equal(existsSync(join(stateDir, "spend.jsonl")), false, "no ledger entry");
    assert.deepEqual(server.requests, []);
  } finally {
    await server.close();
  }
});
