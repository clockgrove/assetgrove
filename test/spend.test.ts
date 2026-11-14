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
import { defaultRoutes } from "../src/routes.ts";
import { DEFAULT_CAPS } from "../src/settings.ts";
import { SpendLedger, SpendLimitError, ledgerFor } from "../src/spend.ts";
import { ledgerPath as fixtureLedger, SCRIPTED_LIMIT, writeSettings } from "./fixtures/env.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const spendModule = pathToFileURL(join(root, "src/spend.ts")).href;

/** A ledger path in a fresh state directory: `<stateDir>/spend.jsonl`. */
async function ledgerPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "assetgrove-spend-test-")), "spend.jsonl");
}

interface Caps {
  dailyUsd?: number;
  workItemUsd?: number;
  workItem?: string;
}

/** The ledger of settings whose stateDir holds `path`, with these caps and work item. */
function ledger(path: string, caps: Caps = {}, now?: () => Date): SpendLedger {
  const l = SpendLedger.fromSettings(
    {
      stateDir: dirname(path),
      caps: {
        dailyUsd: caps.dailyUsd ?? DEFAULT_CAPS.dailyUsd,
        workItemUsd: caps.workItemUsd ?? DEFAULT_CAPS.workItemUsd,
      },
    },
    { workItem: caps.workItem, env: {}, ...(now !== undefined && { now }) },
  );
  assert.equal(l.path, path);
  return l;
}

function limit(l: SpendLedger, name: string) {
  return l.status().limits.find((s) => s.limit === name);
}

test("the settings' caps apply; no work item means no work-item cap", async () => {
  const l = ledger(await ledgerPath());
  const status = l.status();
  assert.equal(status.workItem, null);
  assert.deepEqual(status.limits, [
    {
      limit: "daily",
      limitUsd: DEFAULT_CAPS.dailyUsd,
      source: "settings",
      spentUsd: 0,
      remainingUsd: DEFAULT_CAPS.dailyUsd,
    },
  ]);
  const named = ledger(await ledgerPath(), { workItem: "obj-72", workItemUsd: 3 });
  assert.deepEqual(limit(named, "work-item"), {
    limit: "work-item",
    workItem: "obj-72",
    limitUsd: 3,
    source: "settings",
    spentUsd: 0,
    remainingUsd: 3,
  });
});

test("the work item is --work-item, else ASSETGROVE_WORK_ITEM; no other variable names one", () => {
  const item = (env: Record<string, string>, workItem?: string) =>
    SpendLedger.fromSettings(
      { stateDir: "/state", caps: DEFAULT_CAPS },
      { env, ...(workItem !== undefined && { workItem }) },
    ).status().workItem;
  assert.equal(item({ ASSETGROVE_WORK_ITEM: "campaign-a" }), "campaign-a");
  assert.equal(item({ ASSETGROVE_WORK_ITEM: "campaign-a" }, "obj-1"), "obj-1");
  assert.equal(item({ FACTORY_ISSUE: "72", GITHUB_REPOSITORY: "o/r" }), null);
  assert.equal(item({}), null);
});

test("the ledger is <stateDir>/spend.jsonl; no environment variable moves it or changes a cap", () => {
  const l = SpendLedger.fromSettings(
    { stateDir: "/state", caps: { dailyUsd: 7, workItemUsd: 4 } },
    {
      env: {
        ASSETGROVE_SPEND_LEDGER: "/elsewhere.jsonl",
        ASSETGROVE_DAILY_LIMIT_USD: "100",
        ASSETGROVE_WORK_ITEM_LIMIT_USD: "100",
        ASSETGROVE_WORK_ITEM: "w",
      },
    },
  );
  assert.equal(l.path, join("/state", "spend.jsonl"));
  assert.deepEqual(
    l.status().limits.map((s) => [s.limit, s.limitUsd, s.source]),
    [
      ["daily", 7, "settings"],
      ["work-item", 4, "settings"],
    ],
  );
});

test("a profile limit below the settings cap lowers it; one above changes nothing", async () => {
  const path = await ledgerPath();
  const base = ledger(path, { workItem: "w", dailyUsd: 3, workItemUsd: 4 });
  const lowered = base.forProfile({ spend: { dailyLimitUsd: 2, workItemLimitUsd: 1 } });
  assert.deepEqual(
    lowered.status().limits.map((s) => [s.limit, s.limitUsd, s.source]),
    [
      ["daily", 2, "profile"],
      ["work-item", 1, "profile"],
    ],
  );
  const above = base.forProfile({ spend: { dailyLimitUsd: 50, workItemLimitUsd: 40 } });
  assert.deepEqual(
    above.status().limits.map((s) => [s.limit, s.limitUsd, s.source]),
    [
      ["daily", 3, "settings"],
      ["work-item", 4, "settings"],
    ],
  );
  assert.throws(
    () => base.forProfile({ spend: { workItemLimitUsd: "5" as unknown as number } }),
    InputError,
  );
});

test("reservations count at their estimate until settled, then at their cost; a refused one is cancelled", async () => {
  const path = await ledgerPath();
  const l = ledger(path, { workItem: "w", workItemUsd: 1 });
  const a = l.reserve(0.6, "the still call", "scripted:still:m");
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
  const other = ledger(path, { workItem: "v", dailyUsd: 0.5 });
  assert.equal(limit(other, "work-item")?.spentUsd, 0);
  assert.throws(() => other.check(0.31, "the run"), /\$0\.50 daily limit/);
  // A run that spends nothing is never refused, even past a limit.
  ledger(path, { dailyUsd: 0.1 }).check(0, "a run with no paid calls");

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
});

test("the daily limit counts the last 24 hours; the work-item limit counts all time", async () => {
  const path = await ledgerPath();
  const t0 = Date.parse("2026-11-10T08:00:00Z");
  const caps = { workItem: "w", workItemUsd: 20 };
  const then = ledger(path, caps, () => new Date(t0));
  then.settle(then.reserve(4, "a call", "r"), 4);
  const later = ledger(path, caps, () => new Date(t0 + 25 * 60 * 60 * 1000));
  assert.equal(limit(later, "daily")?.spentUsd, 0);
  assert.equal(limit(later, "work-item")?.spentUsd, 4);
});

test("concurrent runs never reserve past a limit: exactly as many as fit succeed", async () => {
  const path = await ledgerPath();
  const settings = { stateDir: dirname(path), caps: { dailyUsd: 10, workItemUsd: 3 } };
  const code = `import { SpendLedger } from ${JSON.stringify(spendModule)};
const l = SpendLedger.fromSettings(${JSON.stringify(settings)}, { workItem: "w", env: {} });
try { l.reserve(1, "a call", "r"); console.log("ok"); }
catch (e) { if (e.name !== "SpendLimitError") throw e; console.log("refused"); }`;
  const results = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise<string>((resolve, reject) =>
          execFile(
            process.execPath,
            ["--input-type=module", "-e", code],
            (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout.trim())),
          ),
        ),
    ),
  );
  assert.equal(results.filter((r) => r === "ok").length, 3);
  assert.equal(results.filter((r) => r === "refused").length, 5);
  assert.equal(limit(ledger(path, { workItem: "w" }), "work-item")?.spentUsd, 3);
});

test("the ledger a run reserves against is decided by billing, never by a name", async () => {
  const l = ledger(await ledgerPath());
  assert.equal(ledgerFor(l, { paid: false }), undefined);
  assert.ok(ledgerFor(l, { paid: true }) instanceof SpendLedger);
  // A provider without billing counts as paid.
  assert.ok(ledgerFor(l, undefined) instanceof SpendLedger);
});

function countingProvider(counts: { image: number }, paid = true) {
  return new ScriptedProvider(
    {
      paid,
      image: () => {
        counts.image++;
        return { images: [{ mediaType: "image/png", bytes: new Uint8Array([1]) }], costUsd: 0.1 };
      },
      vision: () => {
        throw new Error("down");
      },
    },
    { provider: "paid-test", limit: SCRIPTED_LIMIT },
  );
}

test("every paid Caller call reserves in the budget's ledger with its route and settles at its cost", async () => {
  const path = await ledgerPath();
  const l = ledger(path, { dailyUsd: 0.3 });
  const counts = { image: 0 };
  const call = new Caller({
    provider: countingProvider(counts),
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
    .map((e) => e.route);
  assert.deepEqual(routes, [
    `paid-test:still:${defaultRoutes["still"]!.model}`,
    `paid-test:vision:${defaultRoutes["vision"]!.model}`,
    `paid-test:still:${defaultRoutes["still"]!.model}`,
  ]);
});

test("free Caller calls never reach the ledger; the run's cap still applies", async () => {
  const path = await ledgerPath();
  const l = ledger(path, { dailyUsd: 0 });
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

/** Fresh settings for a CLI test: their own stateDir, these caps, a declared scripted limit. */
async function settingsWith(caps: Record<string, number> = {}): Promise<string> {
  const path = await ledgerPath();
  writeSettings({
    stateDir: dirname(path),
    caps,
    providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } },
  });
  return path;
}

/**
 * A synthetic world and a passing provider script that counts every call it answers. `paid` makes
 * the scripted adapter's billing paid, standing in for a real provider.
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
  const callCount = async () =>
    existsSync(calls) ? (await readFile(calls, "utf8")).trim().split("\n").length : 0;
  return { world, args, callCount };
}

test("a paid run with the fixture settings records in <stateDir>/spend.jsonl", async () => {
  const { args } = await stageWorld(true);
  const r = await cli(args, process.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(await readFile(fixtureLedger, "utf8"), /"route":"scripted:edit:/);
});

test("--cap above caps.runUsd exits 3 cap_refused before any call, with no ledger entry", async () => {
  const { args, callCount } = await stageWorld(true);
  const path = await settingsWith({ runUsd: 1 });
  const r = await cli([...args, "--cap", "2"], process.env);
  assert.equal(r.code, 3, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.error.code, "cap_refused");
  assert.match(doc.error.message, /caps\.runUsd/);
  assert.equal(await callCount(), 0);
  assert.equal(existsSync(path), false);
  // At or below it, --cap lowers the run cap.
  const lower = await cli([...args, "--cap", "0.1", "--dry-run"], process.env);
  assert.equal(JSON.parse(lower.stdout).plan.capUsd, 0.1);
  // Without --cap, the command's own default is bounded by caps.runUsd.
  await settingsWith({ runUsd: 0.2 });
  const bounded = await cli([...args, "--dry-run"], process.env);
  assert.equal(JSON.parse(bounded.stdout).plan.capUsd, 0.2);
});

test("two paid runs whose combined forecast crosses the work-item cap: the second is refused before any call", async () => {
  const { world, args, callCount } = await stageWorld(true);
  const path = await settingsWith({ workItemUsd: 0.5 });
  const env = process.env;
  const first = await cli(args, env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(await callCount(), 7);
  const ledgerAfterFirst = await readFile(path, "utf8");
  assert.match(ledgerAfterFirst, /"route":"scripted:edit:/);

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
  assert.ok(Math.abs(daily.remainingUsd - (DEFAULT_CAPS.dailyUsd - 0.32)) < 1e-9);
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

  // Another work item still has room under the daily cap.
  const other = await cli(
    args.map((a) => (a === "obj-72" ? "obj-73" : a)),
    env,
  );
  assert.equal(other.code, 0, other.stderr);
});

test("free scripted runs over the caps are not refused and write nothing to the ledger", async () => {
  const { world, args, callCount } = await stageWorld(false);
  const path = await settingsWith({ dailyUsd: 0.1, workItemUsd: 0.1 });
  const env = process.env;
  // Each run's $0.32 forecast alone is over both caps.
  for (let run = 1; run <= 2; run++) {
    const r = await cli(args, env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await callCount(), 7 * run);
  }
  assert.equal((await readdir(world.runsDir)).length, 2);
  assert.equal(existsSync(path), false);

  // The dry run still prints the caps, marked not counted, and is never refused by them.
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
