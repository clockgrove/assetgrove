import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SpendLedger } from "../src/spend.ts";
import { settingsPath, stateDir, writeSettings } from "./fixtures/env.ts";

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

test("`settings show --json` with a key value in the environment never contains that value", async () => {
  const gatewayKey = "sk-gateway-secret-value-0123456789";
  const ownKey = "sk-own-variable-secret-9876543210";
  writeSettings({
    providers: {
      "vercel-ai-gateway": { limit: { kind: "prepaid", usd: 20 } },
      relay: {
        adapter: "vercel-ai-gateway",
        keyEnv: "ASSETGROVE_TEST_RELAY_KEY",
        baseURL: "https://relay.example/v4/ai",
      },
    },
  });
  const env = { ...process.env, AI_GATEWAY_API_KEY: gatewayKey, ASSETGROVE_TEST_RELAY_KEY: ownKey };
  for (const args of [
    ["settings", "show", "--json"],
    ["settings", "show"],
  ]) {
    const r = await cli(args, env);
    assert.equal(r.code, 0, r.stderr);
    for (const value of [gatewayKey, ownKey]) {
      assert.ok(!r.stdout.includes(value), `${args.join(" ")} printed a key`);
      assert.ok(!r.stderr.includes(value), `${args.join(" ")} logged a key`);
    }
  }
  const shown = JSON.parse((await cli(["settings", "show", "--json"], env)).stdout) as {
    settings: { providers: Record<string, { keyEnv: string; keyPresent: boolean }> };
  };
  assert.deepEqual(
    Object.entries(shown.settings.providers).map(([id, p]) => [id, p.keyEnv, p.keyPresent]),
    [
      ["relay", "ASSETGROVE_TEST_RELAY_KEY", true],
      ["vercel-ai-gateway", "AI_GATEWAY_API_KEY", true],
    ].sort(),
  );
});

test("`settings path --json` prints the fixture path", async () => {
  const r = await cli(["settings", "path", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const document = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.equal(document["path"], settingsPath);
  assert.equal(document["exists"], true);
  assert.equal(document["stateDir"], stateDir);
  assert.equal(document["command"], "settings");
});

test("`spend status --json` reports caps, today's spend and the work item", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-status-"));
  const caps = { runUsd: 3, dailyUsd: 8, workItemUsd: 4 };
  writeSettings({ stateDir: dir, caps });
  const ledger = SpendLedger.fromSettings({ stateDir: dir, caps }, { workItem: "obj-9", env: {} });
  ledger.settle(ledger.reserve(0.25, "a call", "scripted:still:m"), 0.2);
  const other = SpendLedger.fromSettings({ stateDir: dir, caps }, { workItem: "obj-1", env: {} });
  other.settle(other.reserve(0.1, "a call", "scripted:still:m"), 0.1);

  const r = await cli(["spend", "status", "--work-item", "obj-9", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const document = JSON.parse(r.stdout) as {
    ledger: string;
    caps: typeof caps;
    workItem: string;
    today: { spentUsd: number };
    limits: { limit: string; spentUsd: number; limitUsd: number }[];
  };
  assert.equal(document.ledger, join(dir, "spend.jsonl"));
  assert.deepEqual(document.caps, caps);
  assert.equal(document.workItem, "obj-9");
  assert.ok(Math.abs(document.today.spentUsd - 0.3) < 1e-9);
  const item = document.limits.find((l) => l.limit === "work-item");
  assert.ok(item && Math.abs(item.spentUsd - 0.2) < 1e-9);
  assert.equal(item?.limitUsd, 4);

  // The work item may come from ASSETGROVE_WORK_ITEM instead.
  const fromEnv = await cli(["spend", "status", "--json"], {
    ...process.env,
    ASSETGROVE_WORK_ITEM: "obj-1",
  });
  assert.equal((JSON.parse(fromEnv.stdout) as { workItem: string }).workItem, "obj-1");
});
