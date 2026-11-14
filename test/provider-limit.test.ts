import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BudgetExceededError } from "../src/budget.ts";
import { ProviderError } from "../src/errors.ts";
import { ProviderQuotaError, contradicts, providerFailure } from "../src/limits.ts";
import { ledgerPath, writeSettings } from "./fixtures/env.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = pathToFileURL(
  fileURLToPath(new URL("./fixtures/script.ts", import.meta.url)),
).href;

/** The test environment without any real provider key, so no reader reaches a real host. */
function env(): NodeJS.ProcessEnv {
  const out = { ...process.env };
  for (const name of ["AI_GATEWAY_API_KEY", "TRIPO_API_KEY"]) delete out[name];
  return out;
}

function cli(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env: { ...env(), ...extraEnv } },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

/** A paid provider script over the passing one, with extra members (source text). */
async function paidScript(extra = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-limit-"));
  const path = join(dir, "paid-script.mjs");
  await writeFile(
    path,
    `import base from ${JSON.stringify(passingScript)};
export default { ...base, paid: true, ${extra} };`,
  );
  return path;
}

/** A one-candidate stage run of a synthetic world with this provider script. */
async function stageArgs(script: string): Promise<string[]> {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  return [
    "stage",
    ...["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir],
    ...["--candidates", "1", "--provider-script", script, "--json"],
  ];
}

test("a paid call to a provider without a declared limit exits 3 before spend", async () => {
  writeSettings({ providers: {} });
  const r = await cli(await stageArgs(await paidScript()));
  assert.equal(r.code, 3, r.stderr);
  assert.equal(JSON.parse(r.stdout).error.code, "provider_limit_undeclared");
  assert.equal(existsSync(ledgerPath), false);
});

test("unlimited without acceptUnlimited exits 3; with it, the run spends", async () => {
  const args = await stageArgs(await paidScript());
  writeSettings({ providers: { scripted: { limit: { kind: "unlimited" } } } });
  const refused = await cli(args);
  assert.equal(refused.code, 3, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, "provider_limit_undeclared");
  assert.equal(existsSync(ledgerPath), false);

  writeSettings({
    providers: { scripted: { limit: { kind: "unlimited", acceptUnlimited: true } } },
  });
  const accepted = await cli(args);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.ok(existsSync(ledgerPath));
});

test("a free scripted run needs no declared limit", async () => {
  writeSettings({ providers: {} });
  const free = join(await mkdtemp(join(tmpdir(), "assetgrove-limit-")), "free.mjs");
  await writeFile(free, `export { default } from ${JSON.stringify(passingScript)};`);
  const r = await cli(await stageArgs(free));
  assert.equal(r.code, 0, r.stderr);
});

test("spend check: a contradicting reading exits 3 provider_limit_mismatch; a matching one is verified", async () => {
  writeSettings({ providers: { scripted: { limit: { kind: "prepaid", usd: 20 } } } });
  const contradicting = await paidScript(
    `limitReading: () => ({ source: "scripted balance", remainingUsd: 75 })`,
  );
  const mismatch = await cli(["spend", "check", "--provider-script", contradicting, "--json"]);
  assert.equal(mismatch.code, 3, mismatch.stderr);
  const doc = JSON.parse(mismatch.stdout);
  assert.equal(doc.error.code, "provider_limit_mismatch");
  assert.equal(doc.providers[0].mismatch, true);
  assert.equal(doc.providers[0].verified, false);

  const matching = await paidScript(
    `limitReading: () => ({ source: "scripted balance", remainingUsd: 12.5 })`,
  );
  const ok = await cli(["spend", "check", "--provider-script", matching, "--json"]);
  assert.equal(ok.code, 0, ok.stderr);
  const [scripted] = JSON.parse(ok.stdout).providers;
  assert.deepEqual(
    {
      provider: scripted.provider,
      declared: scripted.declared,
      verified: scripted.verified,
      reading: scripted.reading,
    },
    {
      provider: "scripted",
      declared: true,
      verified: true,
      reading: { source: "scripted balance", remainingUsd: 12.5 },
    },
  );
});

test("node src/cli.ts spend check --json lists each configured provider with declared and verified", async () => {
  writeSettings({
    providers: {
      scripted: { limit: { kind: "key-budget", usd: 5 } },
      // Loopback: the credit reading makes no network call (nothing listens on port 9).
      gateway: { adapter: "vercel-ai-gateway", baseURL: "http://127.0.0.1:9/v4/ai" },
      tripo: { usdPerCredit: 0.01, limit: { kind: "prepaid", usd: 10 } },
    },
  });
  const r = await cli(["spend", "check", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const providers = JSON.parse(r.stdout).providers as Array<Record<string, unknown>>;
  assert.deepEqual(
    providers.map((p) => [p["provider"], p["adapter"], p["declared"], p["verified"]]),
    [
      ["scripted", "scripted", true, false],
      ["gateway", "vercel-ai-gateway", false, false],
      ["tripo", "tripo", true, false],
    ],
  );
  // Neither key is set: the readings fail without reaching a provider, and are reported.
  for (const p of providers.slice(1)) assert.match(String(p["readingError"]), /is not set/);

  const one = await cli(["spend", "check", "--provider", "tripo", "--json"]);
  assert.deepEqual(
    JSON.parse(one.stdout).providers.map((p: { provider: string }) => p.provider),
    ["tripo"],
  );
});

test("a scripted gateway 402 quota error exits 3 cap_refused", async () => {
  const script = await paidScript(
    `image: () => { throw Object.assign(new Error("insufficient credit"), { statusCode: 402 }); }`,
  );
  const r = await cli(await stageArgs(script));
  assert.equal(r.code, 3, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.error.code, "cap_refused");
  assert.match(doc.error.message, /HTTP 402/);
});

test("a gateway 402 and an OpenAI quota 429 map to cap_refused; another 429 does not", () => {
  const quota402 = providerFailure("gateway image", { message: "no credit", statusCode: 402 });
  assert.ok(quota402 instanceof ProviderQuotaError && quota402 instanceof BudgetExceededError);
  assert.equal(quota402.code, "cap_refused");
  const openai = providerFailure("openai image", {
    message: "You exceeded your current quota",
    statusCode: 429,
    cause: { data: { error: { code: "insufficient_quota" } } },
  });
  assert.ok(openai instanceof ProviderQuotaError);
  const rate = providerFailure("openai image", { message: "slow down", statusCode: 429 });
  assert.ok(rate instanceof ProviderError);
});

test("a reported limit must equal the declared one; a prepaid balance may not exceed it", () => {
  assert.equal(contradicts({ kind: "key-budget", usd: 20 }, { source: "s", limitUsd: 20 }), false);
  assert.equal(contradicts({ kind: "key-budget", usd: 20 }, { source: "s", limitUsd: 50 }), true);
  assert.equal(contradicts({ kind: "prepaid", usd: 20 }, { source: "s", remainingUsd: 30 }), true);
  assert.equal(contradicts({ kind: "prepaid", usd: 20 }, { source: "s", remainingUsd: 3 }), false);
  // A key budget cannot be compared with an account balance.
  assert.equal(
    contradicts({ kind: "key-budget", usd: 20 }, { source: "s", remainingUsd: 300 }),
    undefined,
  );
  assert.equal(contradicts({ kind: "unlimited" }, { source: "s", remainingUsd: 3 }), undefined);
});

test("spend check and settings check make no keyed reading while a refused TLS variable is set", async () => {
  writeSettings({ providers: { scripted: { limit: { kind: "prepaid", usd: 20 } } } });
  const marker = join(await mkdtemp(join(tmpdir(), "assetgrove-limit-")), "read.txt");
  const script = await paidScript(
    `limitReading: async () => { (await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, "read"); return { source: "scripted balance", remainingUsd: 75 }; }`,
  );
  const tls = { NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  const spend = await cli(["spend", "check", "--provider-script", script, "--json"], tls);
  assert.equal(spend.code, 0, spend.stderr);
  const doc = JSON.parse(spend.stdout);
  assert.deepEqual(doc.refused, ["NODE_TLS_REJECT_UNAUTHORIZED"]);
  assert.equal(doc.providers[0].reading, null);
  assert.equal(doc.providers[0].verified, false);
  assert.match(doc.providers[0].readingError, /NODE_TLS_REJECT_UNAUTHORIZED/);
  const settings = await cli(["settings", "check", "--provider-script", script, "--json"], tls);
  assert.equal(settings.code, 0, settings.stderr);
  assert.equal(JSON.parse(settings.stdout).providers[0].reading, null);
  assert.equal(existsSync(marker), false);
  // Allowed, the reading is made (and here contradicts the declared limit).
  writeSettings({
    providers: { scripted: { limit: { kind: "prepaid", usd: 20 } } },
    environment: { allow: ["NODE_TLS_REJECT_UNAUTHORIZED"] },
  });
  const allowed = await cli(["spend", "check", "--provider-script", script, "--json"], tls);
  assert.equal(allowed.code, 3, allowed.stderr);
  assert.equal(existsSync(marker), true);
});
