import "./fixtures/env.ts";
import { approveProfile, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AssetSpec, Provenance } from "../src/types.ts";
import { openAICompatibleServer } from "./fixtures/openai-compatible-server.ts";
import { shelterSpec, syntheticWorld as plainWorld } from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const loopbackOnly = fileURLToPath(new URL("./fixtures/loopback-only.ts", import.meta.url));

const denSpec: AssetSpec = {
  kind: "still",
  assetId: "den",
  animationFamily: "idle",
  fields: { semantic: { role: "prop", entity: "grove.den" }, accessibilityLabel: "The den" },
};

async function syntheticWorld(): Promise<World> {
  const world = await plainWorld();
  approveProfile(world.profile, { targetDir: world.targetDir });
  return world;
}

function cli(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      ["--import", loopbackOnly, "src/cli.ts", ...args],
      { cwd: root, env: { ...process.env, ...env } },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

async function stageArgs(world: World, spec: AssetSpec): Promise<string[]> {
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

/** Local-only settings: an image server and a chat server, both free, with no edit role. */
function localSettings(baseURL: string, stateDir: string): void {
  writeSettings({
    stateDir,
    providers: {
      images: { adapter: "openai-compatible", baseURL, free: true },
      chat: { adapter: "openai-compatible", baseURL, free: true },
    },
    roles: {
      image: {
        provider: "images",
        model: "local-image",
        outputGrant: {
          license: "LicenseRef-local-model",
          plan: "local",
          commercial: true,
          relabel: true,
        },
        providerTerms: "Local model licence (synthetic)",
      },
      vision: { provider: "chat", model: "local-chat" },
      decisions: { provider: "chat", model: "local-chat" },
      planning: { provider: "chat", model: "local-chat" },
    },
  });
}

test("a still stages through the openai-compatible adapter with only loopback connections and no ledger entry", async () => {
  const server = await openAICompatibleServer();
  try {
    const stateDir = await mkdtemp(join(tmpdir(), "assetgrove-local-"));
    const log = join(stateDir, "connections.log");
    localSettings(server.baseURL, stateDir);
    const world = await syntheticWorld();
    const r = await cli(await stageArgs(world, denSpec), { LOOPBACK_LOG: log });
    assert.equal(r.code, 0, r.stderr);
    const staged = JSON.parse(r.stdout) as { candidates: Array<{ provenance: Provenance }> };
    assert.ok(staged.candidates.length > 0);
    for (const candidate of staged.candidates) {
      assert.equal(candidate.provenance.calls[0]!.route, "images:still:local-image");
    }
    assert.ok(server.requests.some((q) => q.path.startsWith("/v1/images/")));
    assert.ok(server.requests.some((q) => q.path === "/v1/chat/completions"));
    assert.equal(existsSync(join(stateDir, "spend.jsonl")), false, "no ledger entry");

    const hosts = (await readFile(log, "utf8")).split("\n").filter(Boolean);
    assert.ok(hosts.length >= 1, "the child connected to the fixture");
    for (const host of hosts) assert.match(host, /^(127\.0\.0\.1|::1|localhost)$/);
  } finally {
    await server.close();
  }
});

test("sprite-strip without an edit route exits 2 route_unavailable", async () => {
  const server = await openAICompatibleServer();
  try {
    const stateDir = await mkdtemp(join(tmpdir(), "assetgrove-local-"));
    localSettings(server.baseURL, stateDir);
    const world = await syntheticWorld();
    assert.equal(shelterSpec.kind, "sprite-strip");
    const r = await cli(await stageArgs(world, shelterSpec), {
      LOOPBACK_LOG: join(stateDir, "connections.log"),
    });
    assert.equal(r.code, 2, r.stderr);
    const d = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    assert.equal(d.error.code, "route_unavailable");
    assert.match(d.error.message, /edit operation/);
    assert.equal(existsSync(join(stateDir, "spend.jsonl")), false, "no ledger entry");
  } finally {
    await server.close();
  }
});
