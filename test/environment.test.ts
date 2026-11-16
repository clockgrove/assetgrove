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
  envUses,
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
async function settings(allow: string[], search?: object): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-environment-")));
  const path = join(dir, "settings.json");
  await writeFile(
    path,
    JSON.stringify({
      format: "assetgrove-settings/1",
      providers: { "vercel-ai-gateway": {} },
      environment: { allow },
      ...(search && { search }),
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

const s3Search = {
  store: {
    uri: "s3://synthetic-bucket/index",
    credentialsEnv: { accessKeyId: "SYNTHETIC_ID", secretAccessKey: "SYNTHETIC_SECRET" },
  },
};

test("an AWS variable that can redirect index data is refused with an s3 store unless environment.allow lists it", async () => {
  for (const name of ["AWS_ENDPOINT_URL", "AWS_PROFILE"]) {
    const env: NodeJS.ProcessEnv = {
      ...cleanEnv(),
      [name]: "synthetic",
      ASSETGROVE_CONFIG: await settings([], s3Search),
    };
    const refused = await cli(await stageArgs(), env);
    assert.equal(refused.code, 2, refused.stderr);
    assert.equal(JSON.parse(refused.stdout).error.code, "settings_invalid");
    assert.match(refused.stdout, new RegExp(`${name} is set`));

    const unconfigured = await cli(await stageArgs(), {
      ...env,
      ASSETGROVE_CONFIG: await settings([]),
    });
    assert.equal(unconfigured.code, 0, unconfigured.stderr);

    const allowed = await cli(await stageArgs(), {
      ...env,
      ASSETGROVE_CONFIG: await settings([name], s3Search),
    });
    assert.equal(allowed.code, 0, allowed.stderr);
  }
});

const uses = (uri: string | undefined, providers: Record<string, { adapter?: string }>) =>
  envUses({
    providers,
    ...(uri && { search: { store: { uri } } }),
  } as unknown as Parameters<typeof envUses>[0]);

test("AWS variables are refused only with an s3:// search store", () => {
  for (const name of ["AWS_REGION", "AWS_PROFILE", "AWS_ACCESS_KEY_ID"]) {
    const env = { [name]: "synthetic" };
    assert.deepEqual(refusedVariables([], env, uses(undefined, {})), []);
    assert.deepEqual(refusedVariables([], env, uses("gs://bucket/index", {})), []);
    assert.deepEqual(refusedVariables([], env, uses("s3://bucket/index", {})), [name]);
    assert.deepEqual(refusedVariables([name], env, uses("s3://bucket/index", {})), []);
    assert.deepEqual(refusedVariables([], env), [name], "no uses fails closed");
  }
});

test("a base URL variable is refused only with its adapter configured", () => {
  const anthropic = { ANTHROPIC_BASE_URL: "http://x" };
  const openai = { OPENAI_BASE_URL: "http://x" };
  const gateway = { "vercel-ai-gateway": {} };
  assert.deepEqual(refusedVariables([], anthropic, uses(undefined, gateway)), []);
  assert.deepEqual(refusedVariables([], anthropic, uses(undefined, { anthropic: {} })), [
    "ANTHROPIC_BASE_URL",
  ]);
  assert.deepEqual(
    refusedVariables([], anthropic, uses(undefined, { mine: { adapter: "anthropic" } })),
    ["ANTHROPIC_BASE_URL"],
  );
  assert.deepEqual(refusedVariables([], openai, uses(undefined, gateway)), []);
  assert.deepEqual(refusedVariables([], openai, uses(undefined, { openai: {} })), [
    "OPENAI_BASE_URL",
  ]);
  assert.deepEqual(refusedVariables([], anthropic, uses(undefined, { openai: {} })), []);
});

test("TLS and proxy variables are refused whatever is configured", () => {
  const env = { HTTPS_PROXY: "http://p", NODE_EXTRA_CA_CERTS: "/ca.pem" };
  assert.deepEqual(refusedVariables([], env, uses(undefined, {})), [
    "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY",
  ]);
});
