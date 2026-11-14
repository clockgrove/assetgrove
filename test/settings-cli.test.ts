import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SpendLedger } from "../src/spend.ts";
import { ledgerPath, settingsPath, stateDir, writeSettings } from "./fixtures/env.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function cli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
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

test("settings path --json prints the fixture path", async () => {
  const r = await cli(["settings", "path", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.path, settingsPath);
  assert.equal(doc.exists, true);
  assert.equal(doc.command, "settings");
});

test("settings show --json with a key value in the environment never contains that value", async () => {
  const KEY = "sk-synthetic-show-0123456789abcdef";
  writeSettings({
    providers: {
      // Loopback, so check's credit reading makes no network call (nothing listens on port 9).
      gateway: {
        adapter: "vercel-ai-gateway",
        keyEnv: "SHOW_GATEWAY_KEY",
        baseURL: "http://127.0.0.1:9/v4/ai",
      },
      scripted: { limit: { kind: "prepaid", usd: 3 } },
    },
  });
  const env = {
    ...process.env,
    SHOW_GATEWAY_KEY: KEY,
    AI_GATEWAY_API_KEY: KEY,
    TRIPO_API_KEY: KEY,
  };
  for (const action of ["show", "check"]) {
    const r = await cli(["settings", action, "--json"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes(KEY), `settings ${action} printed the key`);
    assert.ok(!r.stderr.includes(KEY));
  }
  const shown = JSON.parse((await cli(["settings", "show", "--json"], env)).stdout);
  assert.equal(shown.stateDir, stateDir);
  assert.deepEqual(shown.providers.gateway, {
    adapter: "vercel-ai-gateway",
    keyEnv: "SHOW_GATEWAY_KEY",
    baseURL: "http://127.0.0.1:9/v4/ai",
    keyPresent: true,
  });
  assert.deepEqual(shown.caps, { runUsd: 5, dailyUsd: 10, workItemUsd: 5 });
  const checked = JSON.parse((await cli(["settings", "check", "--json"], env)).stdout);
  const gateway = checked.providers.find((p: { provider: string }) => p.provider === "gateway");
  assert.equal(gateway.keyPresent, true);
  assert.equal(gateway.declared, false);
  assert.equal(gateway.reading, null);
  assert.equal(typeof gateway.readingError, "string");
});

test("spend status --json reports caps, today's spend and the work item", async () => {
  writeSettings({ caps: { runUsd: 2, dailyUsd: 7, workItemUsd: 3 } });
  const settings = { stateDir, caps: { runUsd: 2, dailyUsd: 7, workItemUsd: 3 } };
  const ledger = SpendLedger.fromSettings(settings, { workItem: "obj-9", env: {} });
  ledger.settle(ledger.reserve(0.4, "a call", "scripted:still:m", "scripted"), 0.25);

  const r = await cli(["spend", "status", "--work-item", "obj-9", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.ledger, ledgerPath);
  assert.deepEqual(doc.caps, { runUsd: 2, dailyUsd: 7, workItemUsd: 3 });
  assert.ok(Math.abs(doc.today.spentUsd - 0.25) < 1e-9);
  assert.equal(doc.workItem, "obj-9");
  assert.deepEqual(
    doc.limits.map((l: { limit: string; limitUsd: number }) => [l.limit, l.limitUsd]),
    [
      ["daily", 7],
      ["work-item", 3],
    ],
  );

  // The work item from ASSETGROVE_WORK_ITEM when --work-item names none.
  const fromEnv = await cli(["spend", "status", "--json"], {
    ...process.env,
    ASSETGROVE_WORK_ITEM: "campaign-b",
  });
  assert.equal(JSON.parse(fromEnv.stdout).workItem, "campaign-b");
});

test("settings and spend refuse an unknown action", async () => {
  for (const args of [
    ["settings", "edit", "--json"],
    ["spend", "raise", "--json"],
  ]) {
    const r = await cli(args);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stdout).error.code, "invalid_input");
  }
});
