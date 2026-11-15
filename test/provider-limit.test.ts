import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { failureOutcome } from "../src/commands/result.ts";
import { providerFailure } from "../src/gateway/failure.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { defaultRoutes } from "../src/routes.ts";
import { SCRIPTED_LIMIT, approve, approveProfile, writeSettings } from "./fixtures/env.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

/** A fresh stateDir for the settings, so each test starts from an empty ledger. */
async function freshState(): Promise<string> {
  return mkdtemp(join(tmpdir(), "assetgrove-limit-"));
}

/** A paid provider script, with a scripted billing reader reporting `balanceUsd` when given. */
async function paidScript(
  dir: string,
  balanceUsd?: number,
): Promise<{ path: string; calls: string }> {
  const calls = join(dir, "calls.txt");
  const path = join(dir, "paid-script.mjs");
  await writeFile(
    path,
    `import { appendFileSync } from "node:fs";
import base from ${JSON.stringify(pathToFileURL(passingScript).href)};
const count = (kind) => appendFileSync(${JSON.stringify(calls)}, kind + "\\n");
export default {
  paid: true,
  ${balanceUsd !== undefined ? `limitReading: () => ({ balanceUsd: ${balanceUsd}, source: "scripted reader" }),` : ""}
  image: (r, i) => (count("image"), base.image(r, i)),
  vision: (r, i) => (count("vision"), base.vision(r, i)),
};`,
  );
  approve(path);
  return { path, calls };
}

async function stageArgs(): Promise<{ args: string[]; dir: string }> {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  approveProfile(world.profile, { targetDir: world.targetDir });
  const args = [
    "stage",
    ...["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir],
    ...["--candidates", "1", "--json"],
  ];
  return { args, dir: world.dir };
}

test("a paid call to a provider with no declared limit exits 3 provider_limit_undeclared before spend", async () => {
  const stateDir = await freshState();
  writeSettings({ stateDir, providers: { scripted: {} } });
  const { args, dir } = await stageArgs();
  const script = await paidScript(dir);
  const r = await cli([...args, "--provider-script", script.path]);
  assert.equal(r.code, 3, r.stderr);
  const document = JSON.parse(r.stdout) as { error: { code: string; message: string } };
  assert.equal(document.error.code, "provider_limit_undeclared");
  assert.match(document.error.message, /providers\.scripted\.limit/);
  assert.equal(existsSync(join(stateDir, "spend.jsonl")), false, "no ledger entry");
  assert.equal(existsSync(script.calls), false, "no call made");
});

test("a provider declaring unlimited without acceptUnlimited exits 3 before any call", async () => {
  let calls = 0;
  const provider = new ScriptedProvider(
    {
      paid: true,
      image: () => {
        calls++;
        return { images: [{ mediaType: "image/png", bytes: new Uint8Array([1]) }] };
      },
      vision: () => ({ text: "ok" }),
    },
    { limit: { kind: "unlimited" } },
  );
  const call = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(5),
    routes: defaultRoutes,
  });
  const error = await call.image("still", "a fox", []).then(
    () => assert.fail("the call was made"),
    (e: unknown) => e,
  );
  const outcome = failureOutcome(error);
  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.error?.code, "provider_limit_undeclared");
  assert.match(outcome.error?.message ?? "", /acceptUnlimited/);
  assert.equal(calls, 0);

  // With acceptUnlimited the same provider may spend.
  const accepted = new ScriptedProvider(
    {
      paid: true,
      image: () => ({ images: [{ mediaType: "image/png", bytes: new Uint8Array([1]) }] }),
      vision: () => ({ text: "ok" }),
    },
    { limit: { kind: "unlimited", acceptUnlimited: true } },
  );
  await new Caller({
    provider: accepted,
    providerName: "scripted",
    budget: new Budget(5),
    routes: defaultRoutes,
  }).image("still", "a fox", []);
});

test("a contradicting reading exits 3 provider_limit_mismatch; a matching one reports verified true", async () => {
  const dir = await freshState();
  writeSettings({ stateDir: dir });
  const over = await paidScript(dir, SCRIPTED_LIMIT.usd + 50);
  const mismatch = await cli(["spend", "check", "--provider-script", over.path, "--json"]);
  assert.equal(mismatch.code, 3, mismatch.stderr);
  const refused = JSON.parse(mismatch.stdout) as {
    error: { code: string };
    providers: { provider: string; mismatch: boolean; verified: boolean }[];
  };
  assert.equal(refused.error.code, "provider_limit_mismatch");
  assert.deepEqual(
    refused.providers.map((p) => [p.provider, p.mismatch, p.verified]),
    [["scripted", true, false]],
  );

  const under = await paidScript(await freshState(), 40);
  const matching = await cli(["spend", "check", "--provider-script", under.path, "--json"]);
  assert.equal(matching.code, 0, matching.stderr);
  const verified = JSON.parse(matching.stdout) as {
    providers: { provider: string; declared: boolean; verified: boolean; reading: unknown }[];
  };
  assert.deepEqual(verified.providers, [
    {
      provider: "scripted",
      adapter: "scripted",
      paid: true,
      declared: true,
      limit: SCRIPTED_LIMIT,
      verified: true,
      reading: { balanceUsd: 40, source: "scripted reader" },
      mismatch: false,
    },
  ]);
});

test("`node src/cli.ts spend check --json` lists each configured provider with declared and verified", async () => {
  writeSettings({
    providers: {
      scripted: { limit: SCRIPTED_LIMIT },
      "vercel-ai-gateway": {
        keyEnv: "ASSETGROVE_TEST_UNSET_KEY",
        limit: { kind: "prepaid", usd: 20 },
      },
      // A key variable no shell sets keeps the balance read offline.
      tripo: { keyEnv: "ASSETGROVE_TEST_UNSET_KEY", usdPerCredit: 0.01 },
    },
  });
  const r = await cli(["spend", "check", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const document = JSON.parse(r.stdout) as {
    providers: { provider: string; adapter: string; declared: boolean; verified: boolean }[];
  };
  assert.deepEqual(
    document.providers.map((p) => [p.provider, p.adapter, p.declared, p.verified]),
    [
      ["scripted", "scripted", true, false],
      ["tripo", "tripo", false, false],
      ["vercel-ai-gateway", "vercel-ai-gateway", true, false],
    ],
  );
  for (const p of document.providers) {
    assert.equal(typeof p.declared, "boolean");
    assert.equal(typeof p.verified, "boolean");
  }
  const one = await cli(["spend", "check", "--provider", "tripo", "--json"]);
  assert.equal(one.code, 0, one.stderr);
  assert.deepEqual(
    (JSON.parse(one.stdout) as { providers: { provider: string }[] }).providers.map(
      (p) => p.provider,
    ),
    ["tripo"],
  );
});

test("a scripted gateway 402 quota error exits 3 cap_refused", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    req.resume();
    req.on("end", () => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "Insufficient credits", type: "insufficient_funds" } }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const { port } = server.address() as AddressInfo;
    const stateDir = await freshState();
    writeSettings({
      stateDir,
      providers: {
        "vercel-ai-gateway": {
          keyEnv: "ASSETGROVE_TEST_GATEWAY_KEY",
          baseURL: `http://127.0.0.1:${port}/v4/ai`,
          limit: { kind: "prepaid", usd: 20 },
        },
      },
    });
    const { args } = await stageArgs();
    const r = await cli(args, {
      ...process.env,
      // Made at run time: a literal value in this tracked file would trip the tracked-key guard.
      ASSETGROVE_TEST_GATEWAY_KEY: `quota-test-${randomUUID()}`,
    });
    assert.equal(r.code, 3, r.stderr);
    const document = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    assert.equal(document.error.code, "cap_refused");
    assert.match(document.error.message, /HTTP 402/);
    assert.ok(seen.length > 0, "the call reached the loopback gateway");
    // The refused call was reserved in the ledger at its estimate, as any failed paid call is.
    assert.match(await readFile(join(stateDir, "spend.jsonl"), "utf8"), /"op":"reserve"/);
  } finally {
    server.close();
  }
});

test("an OpenAI quota 429 maps to cap_refused; another 429 stays a provider error", () => {
  const quota = Object.assign(new Error("You exceeded your current quota"), {
    statusCode: 429,
    data: { error: { code: "insufficient_quota", type: "insufficient_quota" } },
  });
  const refused = failureOutcome(providerFailure("openai", "image", quota));
  assert.equal(refused.exitCode, 3);
  assert.equal(refused.error?.code, "cap_refused");
  const limited = Object.assign(new Error("Rate limit reached"), {
    statusCode: 429,
    data: { error: { code: "rate_limit_exceeded" } },
  });
  assert.equal(failureOutcome(providerFailure("openai", "image", limited)).exitCode, 4);
});
