import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";
import {
  checkEnvironment,
  REFUSED_VARIABLES,
  refusedVariables,
  SettingsError,
} from "../src/env.ts";

const refused = (error: unknown) => {
  assert.ok(error instanceof SettingsError, String(error));
  assert.equal(error.code, "settings_invalid");
  return true;
};

for (const name of [
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
]) {
  test(`checkEnvironment refuses ${name} unless environment.allow lists it`, () => {
    const env = { [name]: "1", PATH: "/usr/bin" };
    assert.throws(() => checkEnvironment([], env), refused);
    assert.throws(() => checkEnvironment([], env), new RegExp(name));
    assert.doesNotThrow(() => checkEnvironment([name.toUpperCase()], env));
  });
}

test("checkEnvironment passes a clean environment and ignores empty values", () => {
  assert.doesNotThrow(() => checkEnvironment([], { PATH: "/usr/bin", HTTPS_PROXY: "" }));
});

test("a variable set in both spellings is reported once", () => {
  const env = { HTTPS_PROXY: "http://proxy:3128", https_proxy: "http://proxy:3128" };
  assert.deepEqual(refusedVariables([], env), ["HTTPS_PROXY"]);
});

test("allowing one variable does not allow another", () => {
  const env = { HTTPS_PROXY: "http://proxy:3128", NODE_EXTRA_CA_CERTS: "/ca.pem" };
  assert.deepEqual(refusedVariables(["HTTPS_PROXY"], env), ["NODE_EXTRA_CA_CERTS"]);
  assert.throws(() => checkEnvironment(["HTTPS_PROXY"], env), refused);
});

const root = fileURLToPath(new URL("..", import.meta.url));

/** Runs the CLI with stdin closed, so `mcp` serves until its input ends. */
function cli(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

/** This process's environment without a model key or any proxy or TLS variable. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of REFUSED_VARIABLES) {
    delete env[name];
    delete env[name.toLowerCase()];
  }
  return env;
}

/** A settings file outside every repository, allowing the given variables. */
async function settings(allow: string[]): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-environment-")));
  const path = join(dir, "settings.json");
  await writeFile(
    path,
    JSON.stringify({
      format: "assetgrove-settings/1",
      providers: { "vercel-ai-gateway": {} },
      environment: { allow },
    }),
  );
  return path;
}

async function stageArgs(): Promise<string[]> {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  return ["stage", "--spec", spec, "--bible", bible, "--profile", profile, "--dry-run", "--json"];
}

test("server start and a paid CLI command exit 2 settings_invalid with HTTPS_PROXY set and not allowed", async () => {
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    HTTPS_PROXY: "http://127.0.0.1:9",
    ASSETGROVE_CONFIG: await settings([]),
  };
  const server = await cli(["mcp"], env);
  assert.equal(server.code, 2, server.stderr);
  assert.equal(server.stdout, "");
  assert.match(server.stderr, /HTTPS_PROXY is set/);

  const paid = await cli(await stageArgs(), env);
  assert.equal(paid.code, 2, paid.stderr);
  const document = JSON.parse(paid.stdout) as { ok: boolean; error: { code: string } };
  assert.equal(document.ok, false);
  assert.equal(document.error.code, "settings_invalid");

  // A free command is not refused.
  const free = await cli(["ops", "--json"], env);
  assert.equal(free.code, 0, free.stderr);
});

test("server start and a paid CLI command proceed when environment.allow lists HTTPS_PROXY", async () => {
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    HTTPS_PROXY: "http://127.0.0.1:9",
    ASSETGROVE_CONFIG: await settings(["HTTPS_PROXY"]),
  };
  const server = await cli(["mcp"], env);
  assert.equal(server.code, 0, server.stderr);

  const paid = await cli(await stageArgs(), env);
  assert.equal(paid.code, 0, paid.stderr);
  assert.equal((JSON.parse(paid.stdout) as { ok: boolean }).ok, true);
});

test("spend check and spend reconcile refuse a refused environment before any provider call; settings check reports it and reads nothing", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ balance: "4", total_used: "0" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const { port } = server.address() as AddressInfo;
    const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-environment-reading-")));
    const path = join(dir, "settings.json");
    const write = (allow: string[]) =>
      writeFile(
        path,
        JSON.stringify({
          format: "assetgrove-settings/1",
          stateDir: join(dir, "state"),
          providers: {
            loop: {
              adapter: "vercel-ai-gateway",
              baseURL: `http://127.0.0.1:${port}/v1/ai`,
              limit: { kind: "prepaid", usd: 5 },
            },
          },
          environment: { allow },
        }),
      );
    await write([]);
    const env: NodeJS.ProcessEnv = {
      ...cleanEnv(),
      ASSETGROVE_CONFIG: path,
      AI_GATEWAY_API_KEY: `agk-synthetic-${"0123456789abcdef"}`,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      HTTPS_PROXY: "http://127.0.0.1:9",
    };
    for (const args of [
      ["spend", "check", "--json"],
      ["spend", "reconcile", "--json"],
    ]) {
      const r = await cli(args, env);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}`);
      assert.equal(JSON.parse(r.stdout).error.code, "settings_invalid");
    }
    const checked = await cli(["settings", "check", "--json"], env);
    const document = JSON.parse(checked.stdout) as {
      environment: { refused: string[] };
      providers: { limit: { verified: boolean; reading: unknown; note?: string } }[];
    };
    assert.deepEqual(document.environment.refused, ["NODE_TLS_REJECT_UNAUTHORIZED", "HTTPS_PROXY"]);
    assert.equal(document.providers[0]!.limit.reading, null);
    assert.match(document.providers[0]!.limit.note ?? "", /environment is refused/);
    assert.deepEqual(requests, [], "a provider was called with the environment refused");

    // Allowed, the same reading reaches the endpoint.
    await write(["NODE_TLS_REJECT_UNAUTHORIZED", "HTTPS_PROXY"]);
    const allowed = await cli(["spend", "check", "--json"], env);
    assert.equal(allowed.code, 0, allowed.stdout);
    assert.ok(requests.length > 0);
  } finally {
    server.close();
  }
});
