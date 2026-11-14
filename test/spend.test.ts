import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Budget, BudgetExceededError } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { InputError, ProviderError } from "../src/errors.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { isPaid } from "../src/limits.ts";
import { createProvider } from "../src/providers/adapter.ts";
import { defaultRoutes } from "../src/routes.ts";
import { loadSettings } from "../src/settings.ts";
import { SpendLedger, SpendLimitError } from "../src/spend.ts";
import { ledgerPath as fixtureLedger, settingsPath, writeSettings } from "./fixtures/env.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const spendModule = pathToFileURL(join(root, "src/spend.ts")).href;

/** A fresh state directory; its ledger is `<stateDir>/spend.jsonl`. */
async function stateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "assetgrove-spend-test-"));
}

const CAPS = { runUsd: 5, dailyUsd: 10, workItemUsd: 5 };

function ledger(
  dir: string,
  options: { workItem?: string; dailyUsd?: number; workItemUsd?: number; now?: () => Date } = {},
): SpendLedger {
  const { workItem, dailyUsd, workItemUsd, now } = options;
  return SpendLedger.fromSettings(
    {
      stateDir: dir,
      caps: {
        ...CAPS,
        ...(dailyUsd !== undefined && { dailyUsd }),
        ...(workItemUsd !== undefined && { workItemUsd }),
      },
    },
    { env: {}, ...(workItem !== undefined && { workItem }), ...(now !== undefined && { now }) },
  );
}

function limit(l: SpendLedger, name: string) {
  return l.status().limits.find((s) => s.limit === name);
}

test("the daily cap comes from settings; no work item means no work-item cap", async () => {
  const l = ledger(await stateDir());
  const status = l.status();
  assert.equal(status.workItem, null);
  assert.deepEqual(status.limits, [
    { limit: "daily", limitUsd: 10, source: "settings", spentUsd: 0, remainingUsd: 10 },
  ]);
  const named = SpendLedger.fromSettings(
    { stateDir: await stateDir(), caps: CAPS },
    { env: { ASSETGROVE_WORK_ITEM: "obj-72" } },
  );
  assert.deepEqual(limit(named, "work-item"), {
    limit: "work-item",
    workItem: "obj-72",
    limitUsd: 5,
    source: "settings",
    spentUsd: 0,
    remainingUsd: 5,
  });
});

test("the ledger is <stateDir>/spend.jsonl from the fixture settings", () => {
  const settings = loadSettings({ cwd: dirname(settingsPath) });
  assert.equal(SpendLedger.fromSettings(settings).path, fixtureLedger);
  assert.equal(fixtureLedger, join(settings.stateDir, "spend.jsonl"));
});

test("no spend variable but ASSETGROVE_WORK_ITEM is read; --work-item wins over it", async () => {
  const dir = await stateDir();
  const env = {
    ASSETGROVE_SPEND_LEDGER: "/elsewhere/ledger.jsonl",
    ASSETGROVE_DAILY_LIMIT_USD: "0.01",
    ASSETGROVE_WORK_ITEM_LIMIT_USD: "0.01",
    FACTORY_ISSUE: "72",
  };
  const l = SpendLedger.fromSettings({ stateDir: dir, caps: CAPS }, { env });
  assert.equal(l.path, join(dir, "spend.jsonl"));
  assert.equal(l.status().workItem, null);
  assert.equal(limit(l, "daily")?.limitUsd, 10);
  const item = (workItem?: string) =>
    SpendLedger.fromSettings(
      { stateDir: dir, caps: CAPS },
      { env: { ASSETGROVE_WORK_ITEM: "campaign-a" }, ...(workItem !== undefined && { workItem }) },
    ).status().workItem;
  assert.equal(item(), "campaign-a");
  assert.equal(item("obj-1"), "obj-1");
});

test("a profile limit below the settings cap lowers it; one above changes nothing", async () => {
  const dir = await stateDir();
  const lowered = ledger(dir, { workItem: "w" }).forProfile({
    spend: { dailyLimitUsd: 3, workItemLimitUsd: 2 },
  });
  assert.deepEqual(
    lowered.status().limits.map((s) => [s.limit, s.limitUsd, s.source]),
    [
      ["daily", 3, "profile"],
      ["work-item", 2, "profile"],
    ],
  );
  const above = ledger(dir, { workItem: "w" }).forProfile({
    spend: { dailyLimitUsd: 50, workItemLimitUsd: 40 },
  });
  assert.deepEqual(
    above.status().limits.map((s) => [s.limit, s.limitUsd, s.source]),
    [
      ["daily", 10, "settings"],
      ["work-item", 5, "settings"],
    ],
  );
  assert.throws(
    () => ledger(dir).forProfile({ spend: { workItemLimitUsd: "5" as unknown as number } }),
    InputError,
  );
});

test("reservations count at their estimate until settled, then at their cost; a refused one is cancelled", async () => {
  const dir = await stateDir();
  const path = join(dir, "spend.jsonl");
  const l = ledger(dir, { workItem: "w", workItemUsd: 1 });
  const a = l.reserve(0.6, "the still call", "scripted:still:m", "scripted");
  assert.equal(limit(l, "work-item")?.spentUsd, 0.6);
  assert.throws(
    () => l.reserve(0.5, "the edit call", "scripted:edit:m"),
    (error: unknown) =>
      error instanceof SpendLimitError &&
      error instanceof BudgetExceededError &&
      error.limit === "work-item" &&
      error.limitUsd === 1 &&
      error.spentUsd === 0.6 &&
      error.requestedUsd === 0.5,
  );
  l.settle(a, 0.2);
  assert.equal(limit(l, "work-item")?.spentUsd, 0.2);
  assert.equal(limit(l, "daily")?.spentUsd, 0.2);
  l.check(0.8, "the run");
  assert.throws(() => l.check(0.81, "the run"), SpendLimitError);
  // Another work item has its own limit but shares the daily one.
  const other = ledger(dir, { workItem: "v", dailyUsd: 0.5 });
  assert.equal(limit(other, "work-item")?.spentUsd, 0);
  assert.throws(() => other.check(0.31, "the run"), /\$0\.50 daily limit/);
  // A run that spends nothing is never refused, even past a limit.
  ledger(dir, { dailyUsd: 0.1 }).check(0, "a run with no paid calls");

  const lines = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  assert.deepEqual(
    lines.map((e) => [e.op, e.route ?? null, e.amountUsd ?? e.costUsd]),
    [
      ["reserve", "scripted:still:m", 0.6],
      ["reserve", "scripted:edit:m", 0.5],
      ["settle", null, 0], // the refused reservation, cancelled
      ["settle", null, 0.2],
    ],
  );
  assert.ok(lines.every((e) => typeof e.at === "string" && typeof e.id === "string"));
  assert.equal(lines[0].provider, "scripted");
  assert.equal(lines[0].workItem, "w");
});

test("the daily limit counts the last 24 hours; the work-item limit counts all time", async () => {
  const dir = await stateDir();
  const t0 = Date.parse("2026-11-10T08:00:00Z");
  const then = ledger(dir, { workItem: "w", workItemUsd: 20, now: () => new Date(t0) });
  then.settle(then.reserve(4, "a call", "r"), 4);
  const later = ledger(dir, {
    workItem: "w",
    workItemUsd: 20,
    now: () => new Date(t0 + 25 * 60 * 60 * 1000),
  });
  assert.equal(limit(later, "daily")?.spentUsd, 0);
  assert.equal(limit(later, "work-item")?.spentUsd, 4);
});

test("concurrent runs never reserve past a limit: exactly as many as fit succeed", async () => {
  const dir = await stateDir();
  const settings = { stateDir: dir, caps: { ...CAPS, workItemUsd: 3 } };
  const code = `import { SpendLedger } from ${JSON.stringify(spendModule)};
const l = SpendLedger.fromSettings(${JSON.stringify(settings)}, { workItem: "w" });
try { l.reserve(1, "a call", "r"); console.log("ok"); }
catch (e) { if (e.name !== "SpendLimitError") throw e; console.log("refused"); }`;
  const env = process.env;
  const results = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise<string>((resolve, reject) =>
          execFile(
            process.execPath,
            ["--input-type=module", "-e", code],
            { env },
            (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout.trim())),
          ),
        ),
    ),
  );
  assert.equal(results.filter((r) => r === "ok").length, 3);
  assert.equal(results.filter((r) => r === "refused").length, 5);
  assert.equal(limit(ledger(dir, { workItem: "w" }), "work-item")?.spentUsd, 3);
});

test("paid-ness is the adapter's billing, never the provider's name", () => {
  const settings = loadSettings({ cwd: dirname(settingsPath) });
  const script = { image: () => ({ images: [] }), vision: () => ({ text: "" }) };
  assert.equal(isPaid(new ScriptedProvider(script)), false);
  assert.equal(isPaid(new ScriptedProvider({ ...script, paid: true })), true);
  assert.equal(isPaid(createProvider(settings, "vercel-ai-gateway", { env: {} }) as never), true);
  assert.equal(isPaid(createProvider(settings, "tripo", { env: {} }) as never), true);
  // A scripted adapter under a gateway-like name is still free.
  const named = { ...settings, providers: { "vercel-ai-gateway": { adapter: "scripted" } } };
  assert.equal(isPaid(createProvider(named, "vercel-ai-gateway", { script }) as never), false);
});

function countingProvider(counts: { image: number }, paid = true) {
  return new ScriptedProvider({
    paid,
    image: () => {
      counts.image++;
      return { images: [{ mediaType: "image/png", bytes: new Uint8Array([1]) }], costUsd: 0.1 };
    },
    vision: () => {
      throw new Error("down");
    },
  });
}

test("every paid Caller call reserves in the budget's ledger with its route and settles at its cost", async () => {
  const dir = await stateDir();
  const path = join(dir, "spend.jsonl");
  const l = ledger(dir, { dailyUsd: 0.3 });
  const counts = { image: 0 };
  const provider = countingProvider(counts);
  const call = new Caller({
    provider: Object.assign(provider, {
      billing: { ...provider.billing, provider: "paid-test", limit: { kind: "prepaid" as const } },
    }),
    providerName: "paid-test",
    budget: new Budget(5, l),
    routes: defaultRoutes,
  });
  await call.image("still", "a fox", []);
  assert.equal(limit(l, "daily")?.spentUsd, 0.1);
  // A failed call is charged its estimate, as the run's budget charges it.
  await assert.rejects(call.vision("vision", "check", []), ProviderError);
  assert.equal(limit(l, "daily")?.spentUsd, 0.1 + defaultRoutes["vision"]!.estimatedCostUsd);
  // The still route's $0.25 estimate no longer fits the $0.30 daily limit: refused, not called.
  await assert.rejects(call.image("still", "a fox", []), SpendLimitError);
  assert.equal(counts.image, 1);
  const routes = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x))
    .filter((e) => e.op === "reserve")
    .map((e) => (assert.equal(e.provider, "paid-test"), e.route));
  assert.deepEqual(routes, [
    `paid-test:still:${defaultRoutes["still"]!.model}`,
    `paid-test:vision:${defaultRoutes["vision"]!.model}`,
    `paid-test:still:${defaultRoutes["still"]!.model}`,
  ]);
});

test("free Caller calls never reach the ledger; the run's cap still applies", async () => {
  const dir = await stateDir();
  const path = join(dir, "spend.jsonl");
  const l = ledger(dir, { dailyUsd: 0 });
  const counts = { image: 0 };
  const budget = new Budget(0.6, l);
  const call = new Caller({
    provider: countingProvider(counts, false),
    providerName: "scripted",
    budget,
    routes: defaultRoutes,
  });
  await call.image("still", "a fox", []);
  await call.image("still", "a fox", []);
  assert.equal(counts.image, 2);
  assert.equal(existsSync(path), false);
  // $0.20 spent and $0.20 held: the still call's $0.25 estimate no longer fits the $0.60 cap.
  budget.reserve(0.2);
  await assert.rejects(call.image("still", "a fox", []), BudgetExceededError);
  assert.equal(counts.image, 2);
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

/**
 * A synthetic world and a passing provider script that counts every call it answers. `paid`
 * makes the scripted adapter bill it as paid, standing in for a real provider.
 */
async function stageWorld(paid: boolean) {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  const calls = join(world.dir, "calls.txt");
  const script = join(world.dir, "counting-script.mjs");
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
import base from ${JSON.stringify(pathToFileURL(passingScript).href)};
const count = (kind) => appendFileSync(${JSON.stringify(calls)}, kind + "\\n");
export default {
  ${paid ? "paid: true," : ""}
  image: (r, i) => (count("image"), base.image(r, i)),
  vision: (r, i) => (count("vision"), base.vision(r, i)),
};`,
  );
  // One shelter candidate: six edits at $0.05 and one QA call at $0.02, $0.32 forecast.
  const args = [
    "stage",
    ...["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir],
    ...["--candidates", "1", "--work-item", "obj-72", "--provider-script", script, "--json"],
  ];
  const callCount = async () => (await readFile(calls, "utf8")).trim().split("\n").length;
  return { world, args, callCount };
}

test("two paid runs whose combined forecast crosses the work-item limit: the second is refused before any call", async () => {
  const { world, args, callCount } = await stageWorld(true);
  const dir = await stateDir();
  const path = join(dir, "spend.jsonl");
  writeSettings({ stateDir: dir, caps: { workItemUsd: 0.5 } });
  const env = process.env;
  const first = await cli(args, env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(await callCount(), 7);
  const ledgerAfterFirst = await readFile(path, "utf8");
  assert.match(ledgerAfterFirst, /"provider":"scripted","route":"scripted:edit:/);

  // The dry run shows what is left under each limit, and that the run would not fit.
  const dry = await cli([...args, "--dry-run"], env);
  assert.equal(dry.code, 3);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.withinLimits, false);
  assert.equal(plan.plan.withinCap, true);
  assert.equal(plan.spend.counted, true);
  const [daily, item] = plan.spend.limits;
  assert.equal(daily.limit, "daily");
  assert.equal(daily.source, "settings");
  assert.ok(Math.abs(daily.remainingUsd - (10 - 0.32)) < 1e-9);
  assert.equal(item.limit, "work-item");
  assert.equal(item.workItem, "obj-72");
  assert.equal(item.source, "settings");
  assert.ok(Math.abs(item.spentUsd - 0.32) < 1e-9);
  assert.ok(Math.abs(item.remainingUsd - 0.18) < 1e-9);

  const second = await cli(args, env);
  assert.equal(second.code, 3);
  const refused = JSON.parse(second.stdout);
  assert.equal(refused.error.code, "cap_refused");
  assert.equal(refused.error.limit.name, "work-item");
  assert.equal(refused.error.limit.workItem, "obj-72");
  assert.equal(refused.error.limit.limitUsd, 0.5);
  assert.ok(Math.abs(refused.error.limit.spentUsd - 0.32) < 1e-9);
  assert.ok(Math.abs(refused.error.limit.requestedUsd - 0.32) < 1e-9);
  // Refused before any call: the script answered nothing more, the ledger is unchanged and no
  // second run directory was made.
  assert.equal(await callCount(), 7);
  assert.equal(await readFile(path, "utf8"), ledgerAfterFirst);
  assert.equal((await readdir(world.runsDir)).length, 1);

  // Another work item still has room under the daily limit.
  const other = await cli(
    args.map((a) => (a === "obj-72" ? "obj-73" : a)),
    env,
  );
  assert.equal(other.code, 0, other.stderr);
});

test("free scripted runs over the caps are not refused and write nothing to the ledger", async () => {
  const { world, args, callCount } = await stageWorld(false);
  const dir = await stateDir();
  const path = join(dir, "spend.jsonl");
  writeSettings({ stateDir: dir, caps: { dailyUsd: 0.1, workItemUsd: 0.1 } });
  const env = process.env;
  // Each run's $0.32 forecast alone is over both limits.
  for (let run = 1; run <= 2; run++) {
    const r = await cli(args, env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await callCount(), 7 * run);
  }
  assert.equal((await readdir(world.runsDir)).length, 2);
  assert.equal(existsSync(path), false);

  // The dry run still prints the limits, marked not counted, and is never refused by them.
  const dry = await cli([...args, "--dry-run"], env);
  assert.equal(dry.code, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.spend.counted, false);
  assert.deepEqual(
    plan.spend.limits.map((l: { limit: string; limitUsd: number }) => [l.limit, l.limitUsd]),
    [
      ["daily", 0.1],
      ["work-item", 0.1],
    ],
  );
  const human = await cli([...args.filter((a) => a !== "--json"), "--dry-run"], env);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /free provider: not counted/);

  // The run's own cap still refuses a scripted run.
  const capped = await cli([...args, "--cap", "0.1"], env);
  assert.equal(capped.code, 3);
  assert.equal(JSON.parse(capped.stdout).error.limit, undefined);
  assert.equal(existsSync(path), false);
});

test("--cap above caps.runUsd exits 3 cap_refused with no ledger entry", async () => {
  const { args, callCount } = await stageWorld(true);
  const dir = await stateDir();
  writeSettings({ stateDir: dir, caps: { runUsd: 1 } });
  const refused = await cli([...args, "--cap", "2"], process.env);
  assert.equal(refused.code, 3, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, "cap_refused");
  assert.match(JSON.parse(refused.stdout).error.message, /caps\.runUsd/);
  assert.equal(existsSync(join(dir, "spend.jsonl")), false);
  assert.equal(existsSync(join(dirname(args[args.indexOf("--runs") + 1]!), "calls.txt")), false);
  await assert.rejects(callCount());
  // At or below the settings' cap, --cap only lowers it.
  const lowered = await cli([...args, "--cap", "1"], process.env);
  assert.equal(lowered.code, 0, lowered.stderr);
  assert.equal(JSON.parse(lowered.stdout).capUsd, 1);
});

test("a paid scripted provider without a declared limit is refused before any spend", async () => {
  const { args } = await stageWorld(true);
  const dir = await stateDir();
  writeSettings({ stateDir: dir, providers: {} });
  const refused = await cli(args, process.env);
  assert.equal(refused.code, 3, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, "provider_limit_undeclared");
  assert.equal(existsSync(join(dir, "spend.jsonl")), false);
});
