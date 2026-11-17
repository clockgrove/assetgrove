/**
 * The prompt-policy check's cut per decisions route (policy/prompt-policy-cuts.json): an answer
 * under `confirmAt` runs, from `confirmAt` up to `refuseAt` a person confirms the request (exit 8,
 * kind `policy`, never cleared by headless settings), and `refuseAt` or more refuses it (exit 9).
 * A route with no measured cut is refused at the plan step (exit 2 `route_unavailable`).
 */
import "./fixtures/env.ts";
import { approve, approveProfile, confirmationsDir, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { confirmCommand } from "../src/commands/confirm.ts";
import { runCommand } from "../src/commands/runner.ts";
import { recordOf, writeConfirmation } from "../src/confirm/index.ts";
import type { ConfirmPort, ConfirmRequest } from "../src/confirm/prompt.ts";
import { promptPolicyCut, readPromptPolicyCuts } from "../src/policy/cuts.ts";
import { defaultRoutes, RouteUnavailableError } from "../src/routes.ts";
import { promptPolicyCutOf } from "../src/runs/plan.ts";
import type { PolicyProviders } from "../src/runs/plan.ts";
import { loadSettings } from "../src/settings.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));

const temporary: string[] = [];
after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
const doc = (r: Result): Doc => JSON.parse(r.stdout) as Doc;

/** A paid script that notes every call in `events`; the prompt-policy answer is `probability`. */
async function recorder(probability: number) {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-policy-band-"));
  temporary.push(dir);
  const script = join(dir, "order.mjs");
  const events = join(dir, "order.events");
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
import base from ${JSON.stringify(pathToFileURL(passingScript).href)};
const note = (kind) => appendFileSync(${JSON.stringify(events)}, kind + "\\n");
export default {
  paid: true,
  image: (r, i) => (note("image"), base.image(r, i)),
  vision: (r, i) => (note("vision"), base.vision(r, i)),
  decide: (r, i) => (note("decide"), base.decide(r, i)),
  promptPolicy: () => (note("prompt-policy"), ({ answer: { type: "boolean", probability: ${probability} } })),
};`,
  );
  approve(script);
  return {
    script,
    events: async () =>
      existsSync(events) ? (await readFile(events, "utf8")).split("\n").filter(Boolean) : [],
  };
}

async function stageArgs(script: string): Promise<{ args: string[]; runs: string }> {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  approveProfile(world.profile, { targetDir: world.targetDir });
  return {
    args: [
      "stage",
      ...["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir],
      ...["--candidates", "1", "--provider-script", script, "--json"],
    ],
    runs: world.runsDir,
  };
}

test("0.6 is borderline: exit 8 kind policy before any other call, even under headless settings; a person's confirmation lets the rerun go on without a second policy call", async () => {
  writeSettings({});
  const { script, events } = await recorder(0.6);
  const { args, runs } = await stageArgs(script);

  const asked = await cli(args);
  assert.equal(asked.code, 8, asked.stderr);
  // The stopped run's record keeps the deciding answer, as the refusal path's does.
  const records = (await readdir(runs, { recursive: true })).filter(
    (f) => f.endsWith("run.json") || f === "run.json",
  );
  assert.equal(records.length, 1, `one run record: ${records.join(", ")}`);
  const stopped = JSON.parse(await readFile(join(runs, records[0]!), "utf8")) as Doc;
  assert.equal(stopped["promptPolicy"].borderline, true);
  assert.equal(stopped["promptPolicy"].probability, 0.6);
  assert.equal(typeof stopped["promptPolicy"].model, "string");
  assert.deepEqual(stopped["promptPolicy"].cut, { confirmAt: 0.5, refuseAt: 0.8 });
  const error = doc(asked)["error"];
  assert.equal(error.code, "confirmation_required");
  assert.equal(error.confirmation.kind, "policy");
  assert.match(error.confirmation.summary, /borderline to the prompt-policy check/);
  assert.match(error.confirmation.summary, /0\.60/);
  assert.deepEqual(await events(), ["prompt-policy"], "no generation call was made");
  const id = error.confirmation.id as string;
  assert.equal(error.confirmation.confirmCommand, `assetgrove confirm ${id}`);
  assert.equal(
    existsSync(join(confirmationsDir, `${id}.json`)),
    false,
    "headless did not clear it",
  );

  // `assetgrove confirm <id>` shows the request rebuilt from what its id hashes.
  const shown: ConfirmRequest[] = [];
  const port: ConfirmPort = {
    method: "tty",
    confirm: async (request) => (shown.push(request), true),
  };
  const confirmed = await runCommand(
    confirmCommand,
    { id },
    { settings: loadSettings(), log: () => {}, prompt: port },
  );
  assert.equal(confirmed.exitCode, 0, confirmed.error?.message);
  assert.equal(shown[0]!.kind, "policy");
  assert.equal(shown[0]!.details["probability"], 0.6);
  const record = JSON.parse(await readFile(join(confirmationsDir, `${id}.json`), "utf8"));
  assert.equal(record.kind, "policy");
  assert.equal(record.method, "terminal");

  const rerun = await cli(args);
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.equal(
    (await events()).filter((e) => e === "prompt-policy").length,
    1,
    "the journaled policy call was not paid twice",
  );
  const run = JSON.parse(await readFile(join(doc(rerun)["runDir"], "run.json"), "utf8")) as Doc;
  assert.equal(run["promptPolicy"].verdict, "allowed");
  assert.equal(run["promptPolicy"].borderline, true);
  assert.deepEqual(run["promptPolicy"].clearedBy, { id, method: "terminal" });
  assert.deepEqual(run["promptPolicy"].cut, { confirmAt: 0.5, refuseAt: 0.8 });
});

test("a written confirmation record clears a borderline request", async () => {
  writeSettings({});
  const { script, events } = await recorder(0.5);
  const { args } = await stageArgs(script);
  const asked = await cli(args);
  assert.equal(asked.code, 8, asked.stderr);
  const id = doc(asked)["error"].confirmation.id as string;
  const pending = JSON.parse(
    await readFile(join(loadSettings().stateDir, "pending", `${id}.json`), "utf8"),
  ) as Doc;
  await writeConfirmation(
    dirname(confirmationsDir),
    recordOf({ kind: "policy", id, summary: "", details: {}, body: pending["body"] }, "terminal"),
  );
  const rerun = await cli(args);
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.ok((await events()).includes("image"));
});

test("0.8 and 0.9 refuse with exit 9, 0.3 runs", async () => {
  writeSettings({});
  for (const [probability, code] of [
    [0.8, 9],
    [0.9, 9],
    [0.3, 0],
  ] as const) {
    const { script, events } = await recorder(probability);
    const { args } = await stageArgs(script);
    const r = await cli(args);
    assert.equal(r.code, code, `${probability}: ${r.stderr}`);
    if (code === 9) {
      assert.equal(doc(r)["error"].code, "prompt_refused");
      assert.deepEqual(await events(), ["prompt-policy"]);
    } else {
      const run = JSON.parse(await readFile(join(doc(r)["runDir"], "run.json"), "utf8")) as Doc;
      assert.equal(run["promptPolicy"].borderline, undefined);
    }
  }
});

const provider = (adapter: string, model: string): PolicyProviders => ({
  get: () => ({ provider: { billing: { paid: true, adapter } } }),
  routes: { "prompt-policy": { provider: "p", model, estimatedCostUsd: 0.001 } },
});

test("the cut is looked up by the route's adapter and model; a route with none is route_unavailable", () => {
  const model = defaultRoutes["prompt-policy"]!.model;
  assert.deepEqual(promptPolicyCut("vercel-ai-gateway", model), { confirmAt: 0.5, refuseAt: 0.8 });
  assert.deepEqual(promptPolicyCut("scripted", "anything"), { confirmAt: 0.5, refuseAt: 0.8 });
  assert.equal(promptPolicyCut("anthropic", "claude-haiku"), undefined);
  assert.equal(promptPolicyCut("vercel-ai-gateway", "other/model"), undefined);
  assert.deepEqual(promptPolicyCutOf(provider("vercel-ai-gateway", model)), {
    confirmAt: 0.5,
    refuseAt: 0.8,
  });
  assert.throws(
    () => promptPolicyCutOf(provider("openai", "gpt-x")),
    (error: unknown) =>
      error instanceof RouteUnavailableError &&
      /openai:gpt-x/.test(error.message) &&
      /policy\/prompt-policy-cuts\.json/.test(error.message),
  );
  assert.deepEqual(
    promptPolicyCut("openai", "gpt-x", { "openai:gpt-x": { confirmAt: 0.3, refuseAt: 0.6 } }),
    { confirmAt: 0.3, refuseAt: 0.6 },
  );
});

test("a cuts file entry must carry its measured rates, and they are held to the bars", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-cuts-"));
  const write = async (entry: object) => {
    const path = join(dir, "cuts.json");
    await writeFile(
      path,
      JSON.stringify({ format: "assetgrove-prompt-policy-cuts/1", routes: { "a:m": entry } }),
    );
    return path;
  };
  const cut = { confirmAt: 0.5, refuseAt: 0.8 };
  assert.deepEqual(
    readPromptPolicyCuts(await write({ ...cut, refusalRate: 0.95, falseRefusalRate: 0.05 })).get(
      "a:m",
    ),
    cut,
  );
  const noRates = await write(cut);
  assert.throws(() => readPromptPolicyCuts(noRates), /needs refusalRate and falseRefusalRate/);
  const oneRate = await write({ ...cut, refusalRate: 0.95 });
  assert.throws(() => readPromptPolicyCuts(oneRate), /needs refusalRate and falseRefusalRate/);
  const under = await write({ ...cut, refusalRate: 0.85, falseRefusalRate: 0.05 });
  assert.throws(() => readPromptPolicyCuts(under), /refusalRate 0.85 is under the bar 0.9/);
  const over = await write({ ...cut, refusalRate: 0.95, falseRefusalRate: 0.2 });
  assert.throws(() => readPromptPolicyCuts(over), /falseRefusalRate 0.2 is over the bar 0.1/);
  await rm(dir, { recursive: true, force: true });
});
