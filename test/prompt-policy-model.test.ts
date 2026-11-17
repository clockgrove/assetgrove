/**
 * The prompt policy's model check (design section 16): the plan step forecasts one `prompt-policy`
 * decide call and the digest covers it; after confirmation it is the run's first provider call; a
 * probability of 0.5 or more exits 9, a failing call exits 4, no decisions route exits 2, and no
 * other call runs in any of these. The red-team set it is measured on is checked here too.
 */
import "./fixtures/env.ts";
import { SCRIPTED_LIMIT as LIMIT, approve, approveProfile, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Budget, BudgetExceededError } from "../src/budget.ts";
import { checkPromptText } from "../src/policy/text.ts";
import type { PromptPartLabel } from "../src/policy/text.ts";
import { withRunScope } from "../src/runs/journal.ts";
import { PROMPT_POLICY_QUESTION } from "../src/policy/model.ts";
import { defaultRoutes } from "../src/routes.ts";
import { forecastOf, requestDigest } from "../src/runs/plan.ts";
import type { PlanJob } from "../src/runs/plan.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const RED_TEAM = join(root, "test", "fixtures", "prompt-policy", "red-team.jsonl");

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

/**
 * A paid provider script that writes every call, in order, to `events`. The prompt-policy answer
 * is `policy`, an expression of the request `r`.
 */
async function recorder(
  policy: string,
): Promise<{ script: string; events: () => Promise<string[]> }> {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-policy-model-"));
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
  promptPolicy: (r) => (note("prompt-policy"), ${policy}),
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

const ALLOW = `({ answer: { type: "boolean", probability: 0.1 } })`;

test("forecast and digest include one prompt-policy job, and it is the first provider call after confirmation", async () => {
  writeSettings({});
  const { script, events } = await recorder(ALLOW);
  const { args } = await stageArgs(script);

  const dry = doc(await cli([...args, "--dry-run"]));
  const jobs = dry["jobs"] as PlanJob[];
  const policy = jobs.filter((j) => j.operation === "prompt-policy");
  assert.equal(policy.length, 1, JSON.stringify(jobs));
  assert.equal(policy[0]!.count, 1);
  assert.equal(policy[0]!.estimatedCostUsd, defaultRoutes["prompt-policy"]!.estimatedCostUsd);
  assert.equal(jobs[0]!.operation, "prompt-policy", "the first job");
  assert.ok(Math.abs(dry["forecastUsd"] - forecastOf(jobs)) < 1e-12);
  const body = {
    command: "stage",
    round: 1,
    inputs: dry["inputs"],
    options: dry["options"],
    forecastUsd: dry["forecastUsd"],
    capUsd: dry["capUsd"],
    policyTextSha256: dry["policyTextSha256"],
  };
  assert.equal(dry["digest"], requestDigest({ ...body, jobs }), "the digest covers the job");
  const others = jobs.filter((j) => j.operation !== "prompt-policy");
  assert.notEqual(
    dry["digest"],
    requestDigest({ ...body, jobs: others, forecastUsd: forecastOf(others) }),
  );
  assert.deepEqual(await events(), [], "a dry run calls nothing");

  const run = await cli(args);
  assert.equal(run.code, 0, run.stderr);
  const order = await events();
  assert.equal(order[0], "prompt-policy", order.join(", "));
  assert.equal(order.filter((e) => e === "prompt-policy").length, 1);
  assert.ok(order.length > 1, "the command's own calls follow");
  const record = JSON.parse(await readFile(join(doc(run)["runDir"], "run.json"), "utf8")) as Doc;
  assert.ok(record["confirmation"], "the run was confirmed before it called anything");
  assert.equal(record["promptPolicy"].verdict, "allowed");
  assert.equal(record["promptPolicy"].probability, 0.1);
  assert.match(record["promptPolicy"].model, /^scripted:prompt-policy:/);
  // The request the model was asked about is the plan step's prompt text, with the policy question.
  const calls = (await readdir(join(doc(run)["runDir"], "calls"))).filter((c) =>
    c.endsWith(".json"),
  );
  const journaled = await Promise.all(
    calls.map(async (c) =>
      JSON.parse(await readFile(join(doc(run)["runDir"], "calls", c), "utf8")),
    ),
  );
  const policyCall = journaled.find((c) => c.record?.operation === "prompt-policy");
  assert.deepEqual(policyCall?.record.parameters.question, PROMPT_POLICY_QUESTION);
});

test("probability 0.5 exits 9 prompt_refused and no other call runs", async () => {
  writeSettings({});
  const { script, events } = await recorder(`({ answer: { type: "boolean", probability: 0.5 } })`);
  const { args } = await stageArgs(script);
  const r = await cli(args);
  assert.equal(r.code, 9, r.stderr);
  const error = doc(r)["error"];
  assert.equal(error.code, "prompt_refused");
  assert.equal(error.policy.verdict, "refused");
  assert.equal(error.policy.probability, 0.5);
  assert.match(error.policy.model, /^scripted:prompt-policy:/);
  assert.deepEqual(await events(), ["prompt-policy"]);
});

test("a failing decide exits 4 provider_error and no other call runs", async () => {
  writeSettings({});
  const { script, events } = await recorder(`(() => { throw new Error("decider down"); })()`);
  const { args } = await stageArgs(script);
  const r = await cli(args);
  assert.equal(r.code, 4, r.stderr);
  assert.equal(doc(r)["error"].code, "provider_error");
  assert.deepEqual(await events(), ["prompt-policy"]);
});

test("no decisions route exits 2 route_unavailable and no call runs", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "assetgrove-policy-route-"));
  temporary.push(stateDir);
  // Tripo has no decide capability, so nothing serves the decisions role.
  writeSettings({
    stateDir,
    providers: { scripted: { limit: { ...LIMIT } }, tripo: { limit: { ...LIMIT } } },
    roles: {
      decisions: { provider: "tripo", model: "tripo/v2.5-20250123", estimatedCostUsd: 0.001 },
    },
  });
  const { script, events } = await recorder(ALLOW);
  const { args } = await stageArgs(script);
  const r = await cli(args);
  assert.equal(r.code, 2, r.stderr);
  const error = doc(r)["error"];
  assert.equal(error.code, "route_unavailable");
  // The stage's own `cutout` decisions need the role too; whichever resolves first is named.
  assert.match(error.message, /(prompt-policy|cutout) operation \(role decisions\)/);
  assert.deepEqual(await events(), []);
  assert.equal(existsSync(join(stateDir, "spend.jsonl")), false, "no ledger entry");
  writeSettings({});
});

interface RedTeamRow {
  id: string;
  prompt: string;
  part?: PromptPartLabel;
  expect: "refuse" | "allow";
  category: "name" | "phrase" | "paraphrase" | "lookalike" | "plain";
  source: "team" | "outside";
  reference?: string;
}

/** The fixed expectation of a category; a `phrase` row's is the model check's, set per row. */
const EXPECT: Record<RedTeamRow["category"], RedTeamRow["expect"] | undefined> = {
  name: "refuse",
  phrase: undefined,
  paraphrase: "refuse",
  lookalike: "allow",
  plain: "allow",
};

const PART_LABELS: readonly string[] = [
  "spec",
  "brief",
  "tone",
  "rules",
  "template",
  "text",
  "model-prompt",
  "model-negative",
] satisfies PromptPartLabel[];

test("red-team.jsonl has at least 60 schema-valid rows, outside rows cite https, the free check refuses every name row and only those, and phrase rows carry hits for the model check", async () => {
  const lines = (await readFile(RED_TEAM, "utf8")).split("\n").filter((l) => l.trim());
  assert.ok(lines.length >= 60, `${lines.length} rows`);
  const ids = new Set<string>();
  for (const line of lines) {
    const row = JSON.parse(line) as RedTeamRow;
    const keys = ["category", "expect", "id", "prompt", "source"];
    if (row.source === "outside") keys.push("reference");
    if (row.part !== undefined) keys.push("part");
    assert.deepEqual(Object.keys(row).sort(), keys.sort(), line);
    assert.ok(typeof row.id === "string" && !ids.has(row.id), line);
    ids.add(row.id);
    assert.ok(typeof row.prompt === "string" && row.prompt.trim().length > 0, line);
    assert.ok(row.part === undefined || PART_LABELS.includes(row.part), line);
    assert.ok(Object.hasOwn(EXPECT, row.category), line);
    assert.ok(row.expect === "refuse" || row.expect === "allow", line);
    if (row.category !== "phrase") assert.equal(row.expect, EXPECT[row.category], line);
    assert.ok(row.source === "team" || row.source === "outside", line);
    if (row.source === "outside") {
      const url = new URL(row.reference!);
      assert.equal(url.protocol, "https:", line);
    }
    const record = checkPromptText([{ label: row.part ?? "brief", text: row.prompt }]);
    if (row.category === "name") assert.equal(record.verdict, "refused", line);
    else assert.equal(record.verdict, "allowed", `only the model can tell: ${line}`);
    if (row.category === "phrase")
      assert.ok((record.hits ?? []).length > 0, `a phrase row carries a hit: ${line}`);
  }
  const rows = lines.map((l) => JSON.parse(l) as RedTeamRow);
  assert.ok(rows.some((r) => r.expect === "refuse") && rows.some((r) => r.expect === "allow"));
  for (const part of ["rules", "text", "model-negative"])
    assert.ok(
      rows.some((r) => r.part === part),
      `a row with part ${part}`,
    );
  for (const expect of ["refuse", "allow"])
    assert.ok(
      rows.some((r) => r.category === "phrase" && r.expect === expect),
      `a phrase row that expects ${expect}`,
    );
});

test("import --no-propose --bible makes the one prompt-policy call, and without --bible makes none", async () => {
  writeSettings({});
  const { script, events } = await recorder(ALLOW);
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  const sheet = join(world.dir, "sheet.png");
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  await writeFile(sheet, syntheticSheet().png);
  approveProfile(world.profile, { targetDir: world.targetDir });
  const base = [
    "import",
    ...["--sheet", sheet, "--profile", profile, "--asset", "fern", "--tool", "hand drawn"],
    ...["--no-propose", "--imports", join(world.dir, "imports"), "--runs", world.runsDir],
    ...["--provider-script", script, "--json"],
  ];

  const bare = doc(await cli([...base, "--dry-run"]));
  assert.deepEqual(bare["jobs"], [], "no prompt text, no check");
  assert.equal(bare["paid"], false);

  const withBible = [...base, "--bible", bible];
  const dry = doc(await cli([...withBible, "--dry-run"]));
  assert.deepEqual(
    (dry["jobs"] as PlanJob[]).map((j) => j.operation),
    ["prompt-policy"],
  );
  assert.equal(dry["paid"], true);
  const run = await cli(withBible);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(await events(), ["prompt-policy"]);
});

test("the prompt-policy call's spend counts against the run's one cap", async () => {
  await withRunScope({ priorSpentUsd: 0.4 }, async () => {
    const budget = new Budget(1);
    assert.equal(budget.spentUsd, 0.4);
    assert.throws(() => budget.reserve(0.7), BudgetExceededError);
    budget.settle(budget.reserve(0.6), 0.6);
  });
  assert.equal(new Budget(1).spentUsd, 0, "outside a run nothing was spent before");
});
