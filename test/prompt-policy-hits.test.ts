/**
 * The prompt policy refuses for what a request asks, not for a phrase in it (#323): a phrase or
 * ambiguous-name hit refuses nothing at the plan step or in a dry run; the run's model check is
 * given the prompt as labelled parts with the hits and decides; an unambiguous name still refuses
 * for free; and text the prompt compiler wrote never makes a person's request exit 9 after spend.
 */
import "./fixtures/env.ts";
import { approve, approveProfile, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { packageBlocklist } from "../src/policy/blocklist.ts";
import { promptPolicyPrompt } from "../src/policy/model.ts";
import { checkPromptText, collectPromptParts } from "../src/policy/text.ts";
import { planDigest } from "../src/planning.ts";
import type { SavedPlan } from "../src/planning.ts";
import type { PlanJob } from "../src/runs/plan.ts";
import { shelterSpec, syntheticWorld, writeStyleBible } from "./fixtures/synthetic.ts";

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

/** Names come from the package blocklist: names are kept in policy/ only. */
const term = (pick: (t: { kind: string; ambiguous?: boolean }) => boolean) =>
  packageBlocklist().terms.find(pick)!.term;
const NAME = term((t) => t.kind === "artist");
const AMBIGUOUS = term((t) => t.ambiguous === true);

/**
 * A paid provider script that writes every call to `<dir>/events` and every prompt-policy request
 * to `<dir>/policy.jsonl`. The prompt-policy probability is `policy`, an expression of `r`.
 */
async function recorder(dir: string, policy: string) {
  const script = join(dir, "policy-hits.mjs");
  const events = join(dir, "events");
  const requests = join(dir, "policy.jsonl");
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
import base from ${JSON.stringify(pathToFileURL(passingScript).href)};
const note = (kind) => appendFileSync(${JSON.stringify(events)}, kind + "\\n");
export default {
  paid: true,
  image: (r, i) => (note("image:" + JSON.stringify(r.prompt)), base.image(r, i)),
  vision: (r, i) => (note("vision"), base.vision(r, i)),
  promptPolicy: (r) => (
    note("prompt-policy"),
    appendFileSync(${JSON.stringify(requests)}, JSON.stringify(r.prompt) + "\\n"),
    { answer: { type: "boolean", probability: ${policy} } }
  ),
};`,
  );
  approve(script);
  const lines = async (path: string) =>
    existsSync(path) ? (await readFile(path, "utf8")).split("\n").filter(Boolean) : [];
  return {
    script,
    events: () => lines(events),
    requests: async () => (await lines(requests)).map((l) => JSON.parse(l) as string),
  };
}

async function stageWorld() {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "BIBLE.md");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeStyleBible(bible, world.bible);
  await writeFile(profile, JSON.stringify(world.profile));
  approveProfile(world.profile, { targetDir: world.targetDir });
  const flags = ["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir];
  return { world, flags };
}

const ALLOW = "0.1";

test("a phrase hit refuses nothing in a dry run: it is reported as decided when the run starts", async () => {
  writeSettings({});
  const { world, flags } = await stageWorld();
  const provider = await recorder(world.dir, ALLOW);
  const base = ["stage", ...flags, "--candidates", "1", "--provider-script", provider.script];
  const note = "a lantern inspired by deep-sea anglerfish";
  const dry = await cli([...base, "--note", note, "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  const policy = doc(dry)["promptPolicy"];
  assert.equal(policy.verdict, "allowed");
  assert.deepEqual(policy.hits, [
    {
      term: "inspired by",
      kind: "phrase",
      part: "text",
      context: "a lantern inspired by deep sea anglerfish",
    },
  ]);
  const human = await cli([...base, "--note", note, "--dry-run"]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(
    human.stdout,
    /"inspired by" \(phrase\) in text: decided by the model check when the run starts/,
  );
  // An unambiguous name still refuses at once, for free.
  const named = await cli([...base, "--note", `a lantern after ${NAME}`, "--dry-run", "--json"]);
  assert.equal(named.code, 9, named.stdout + named.stderr);
  assert.equal(doc(named)["error"].policy.match.term, NAME);
  assert.deepEqual(await provider.events(), [], "neither dry run called anything");
});

test("the model check is given labelled parts and the hits; exit 9 follows only from its answer", async () => {
  writeSettings({});
  const { world, flags } = await stageWorld();
  const allow = await recorder(join(world.dir), ALLOW);
  const note = "a lantern inspired by deep-sea anglerfish";
  const base = ["stage", ...flags, "--candidates", "1", "--json"];
  const run = await cli([...base, "--note", note, "--provider-script", allow.script]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const [request] = await allow.requests();
  assert.ok(request, "one prompt-policy request");
  assert.match(
    request,
    /\[text\] other request text[^\n]*:\n<<<\na lantern inspired by deep-sea anglerfish\n>>>/,
  );
  assert.match(
    request,
    /"inspired by" \(phrase\) in \[text\]: "\.\.\. a lantern inspired by deep sea anglerfish \.\.\."/,
  );
  const record = JSON.parse(await readFile(join(doc(run)["runDir"], "run.json"), "utf8")) as Doc;
  assert.equal(record["promptPolicy"].verdict, "allowed");
  assert.equal(record["promptPolicy"].probability, 0.1);
  assert.equal(record["promptPolicy"].checks.length, 1, "one model decision");
  assert.equal(record["promptPolicy"].hits[0].term, "inspired by");

  const refuseDir = join(world.dir, "refuse");
  await mkdir(refuseDir);
  const refuse = await recorder(refuseDir, "0.9");
  const copy = "a lantern inspired by a famous lantern from another game, copy it exactly";
  const refused = await cli([
    ...base,
    "--note",
    copy,
    "--round",
    "2",
    "--provider-script",
    refuse.script,
  ]);
  assert.equal(refused.code, 9, refused.stdout + refused.stderr);
  const error = doc(refused)["error"];
  assert.equal(error.code, "prompt_refused");
  assert.equal(error.policy.probability, 0.9);
  assert.equal(error.policy.hits[0].term, "inspired by");
  assert.deepEqual(await refuse.events(), ["prompt-policy"], "no other call ran");
});

test("an ambiguous name is read by the model check and its answer recorded, with no allow entry", async () => {
  writeSettings({});
  const { world, flags } = await stageWorld();
  const provider = await recorder(world.dir, ALLOW);
  const note = `a snow level in a ${AMBIGUOUS}`;
  const base = ["stage", ...flags, "--candidates", "1", "--note", note, "--json"];
  const dry = await cli([...base, "--dry-run", "--provider-script", provider.script]);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.equal(doc(dry)["promptPolicy"].hits[0].ambiguous, true);
  const run = await cli([...base, "--provider-script", provider.script]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const record = JSON.parse(await readFile(join(doc(run)["runDir"], "run.json"), "utf8")) as Doc;
  const policy = record["promptPolicy"];
  assert.deepEqual(policy.allowedBy, []);
  assert.equal(policy.hits[0].term, AMBIGUOUS);
  assert.equal(policy.hits[0].ambiguous, true);
  assert.equal(policy.probability, 0.1, "the model's answer on the request");
  // The reading call read it as an ordinary word (the script's default), and the Boolean call is
  // told so rather than given it as a flagged word (#366; test/prompt-policy-readings.test.ts).
  assert.deepEqual(
    policy.readings.map((r: Doc) => [r.term, r.reading]),
    [[AMBIGUOUS, "word"]],
  );
  assert.match(
    (await provider.requests())[0]!,
    /already read in the person-written parts as not the protected name/,
  );
});

/** A world with a Markdown bible whose Don'ts forbid imitation, a default template and a plan. */
async function planWorld(description = "a round lantern icon") {
  const { world, flags } = await stageWorld();
  const art = join(world.dir, ".assetgrove/art-direction");
  await mkdir(art, { recursive: true });
  await mkdir(join(world.dir, ".assetgrove/prompts"), { recursive: true });
  const data = structuredClone(BIBLE_PRESETS["flat-cartoon-kids"]!);
  data.referenceLicense = "NOASSERTION";
  data.world = "Synthetic Grove";
  const md = join(art, "BIBLE.md");
  await writeFile(
    md,
    serializeBible(
      data,
      "## Do's and Don'ts\nDo keep silhouettes readable.\nDon't describe or imitate the look of any named game.\n",
    ),
  );
  await writeFile(
    join(world.dir, ".assetgrove/prompts/default.md"),
    "---\nversion: 1\n---\nCreate original art.\n{{constitution}}\n{{spec}}\n{{brief}}\n",
  );
  const still = join(world.dir, "still.json");
  await writeFile(
    still,
    JSON.stringify({
      kind: "still",
      assetId: "lantern",
      fields: { description },
    }),
  );
  const options = join(world.dir, "run-options.json");
  await writeFile(options, JSON.stringify({ candidates: 1 }));
  const planFile = join(world.dir, "plan.json");
  const planArgs = [
    ...["plan", "--spec", still, "--bible", md, "--profile", flags[5]!],
    ...["--run-options", options, "--out", planFile, "--runs", join(world.dir, "plan-runs")],
  ];
  return { world, planFile, planArgs };
}

test("a bible's Don't that forbids imitation is a rules hit, and plan forecasts its own check and its apply's two", async () => {
  writeSettings({});
  const { world, planArgs } = await planWorld();
  const provider = await recorder(world.dir, ALLOW);
  const dry = await cli([...planArgs, "--provider-script", provider.script, "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  const policy = doc(dry)["promptPolicy"];
  assert.equal(policy.verdict, "allowed");
  const hit = policy.hits.find((h: Doc) => h.term === "imitate");
  assert.equal(hit?.part, "rules");
  const job = (doc(dry)["jobs"] as PlanJob[]).find((j) => j.operation === "prompt-policy");
  assert.equal(job?.count, 3);
  assert.deepEqual(await provider.events(), []);
});

test("plan counts an ambiguous name's reading for its own check and its apply's, and apply counts it once", async () => {
  writeSettings({});
  const { world, planFile, planArgs } = await planWorld(
    `a round lantern icon in a heavy ${AMBIGUOUS}`,
  );
  const provider = await recorder(world.dir, ALLOW);
  const dry = await cli([...planArgs, "--provider-script", provider.script, "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  const hit = (doc(dry)["promptPolicy"].hits as Doc[]).find((h) => h.term === AMBIGUOUS);
  assert.equal(hit?.ambiguous, true);
  // Plan's own check: one reading and one Boolean call; its apply's: one reading and two Boolean
  // calls, since the compiler can write model-written text.
  const job = (doc(dry)["jobs"] as PlanJob[]).find((j) => j.operation === "prompt-policy");
  assert.equal(job?.count, 5);
  assert.deepEqual(await provider.events(), [], "a dry run makes no call");

  const made = await cli([...planArgs, "--json"]);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  const runs = join(world.dir, "apply-runs");
  const apply = ["apply", planFile, "--out", runs, "--provider-script", provider.script, "--json"];
  const applyDry = await cli([...apply, "--dry-run"]);
  assert.equal(applyDry.code, 0, applyDry.stdout + applyDry.stderr);
  // The template's plan holds no model-written part: one reading and one Boolean call.
  const applyJob = (doc(applyDry)["jobs"] as PlanJob[]).find(
    (j) => j.operation === "prompt-policy",
  );
  assert.equal(applyJob?.count, 2);

  // The same plan without the name: 3 (plan's one, apply's two) and apply's 1, so the readings are
  // one for plan's check, one for apply's, counted again by apply itself.
  const plain = await planWorld("a round lantern icon in a heavy storm");
  const plainDry = await cli([
    ...plain.planArgs,
    "--provider-script",
    provider.script,
    "--dry-run",
    "--json",
  ]);
  assert.equal(plainDry.code, 0, plainDry.stdout + plainDry.stderr);
  const plainJob = (doc(plainDry)["jobs"] as PlanJob[]).find(
    (j) => j.operation === "prompt-policy",
  );
  assert.equal(plainJob?.count, 3);
  assert.equal(job!.count - plainJob!.count, 2, "one reading for plan's check, one for apply's");
  const plainMade = await cli([...plain.planArgs, "--json"]);
  assert.equal(plainMade.code, 0, plainMade.stdout + plainMade.stderr);
  const plainApply = await cli([
    "apply",
    plain.planFile,
    "--out",
    join(plain.world.dir, "apply-runs"),
    "--provider-script",
    provider.script,
    "--dry-run",
    "--json",
  ]);
  assert.equal(plainApply.code, 0, plainApply.stdout + plainApply.stderr);
  const plainApplyJob = (doc(plainApply)["jobs"] as PlanJob[]).find(
    (j) => j.operation === "prompt-policy",
  );
  assert.equal(plainApplyJob?.count, 1);
  assert.equal(applyJob!.count - plainApplyJob!.count, 1, "apply counts the reading once");
});

/**
 * Rewrites the saved plan as the compiler might have written it, with `negative` in its own
 * negative prompt (before the bible's), and returns the plan as saved.
 */
async function compiledPlan(planFile: string, negative: string): Promise<SavedPlan> {
  const saved = JSON.parse(await readFile(planFile, "utf8")) as SavedPlan;
  // The template's plan repeats the bible's negative after its own; the compiler's comes first.
  const old = saved.prompts.negative;
  const own = `${negative}\n${old.slice((old.length + 1) / 2)}`;
  const swap = (p: string) => `${p.slice(0, p.length - old.length)}${own}`;
  const edited: Omit<SavedPlan, "digest"> & { digest?: string } = {
    ...saved,
    prompts: {
      ...saved.prompts,
      images: saved.prompts.images.map(swap),
      generation: swap(saved.prompts.generation),
      negative: own,
    },
  };
  delete edited.digest;
  await writeFile(planFile, JSON.stringify({ ...edited, digest: planDigest(edited) }));
  return saved;
}

test("when the check objects only to compiler-written text, apply falls back to the template's prompt and records why", async () => {
  writeSettings({});
  const { world, planFile, planArgs } = await planWorld();
  const made = await cli([...planArgs, "--json"]);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  const negative = "do not imitate existing characters";
  const saved = await compiledPlan(planFile, negative);
  const runs = join(world.dir, "apply-runs");
  // The model objects whenever compiler-written text is in front of it.
  const provider = await recorder(world.dir, `r.prompt.includes("[model-") ? 0.9 : 0.1`);
  const apply = ["apply", planFile, "--out", runs, "--provider-script", provider.script, "--json"];
  const dry = doc(await cli([...apply, "--dry-run"]));
  const hits = dry["promptPolicy"].hits as Doc[];
  assert.deepEqual(
    hits.filter((h) => h.term === "imitate").map((h) => h.part),
    ["rules", "model-negative"],
    "the bible's Don't is a rule; only the compiler's own negative is model-written",
  );
  assert.equal((dry["jobs"] as PlanJob[]).find((j) => j.operation === "prompt-policy")?.count, 2);

  const run = await cli(apply);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const events = await provider.events();
  assert.deepEqual(events.slice(0, 2), ["prompt-policy", "prompt-policy"]);
  const images = events.filter((e) => e.startsWith("image:"));
  assert.ok(images.length > 0);
  for (const image of images) {
    const prompt = JSON.parse(image.slice("image:".length)) as string;
    assert.ok(!prompt.includes(negative), "the template's prompt, not the compiler's");
    assert.equal(prompt, saved.prompts.images[0]);
  }
  const [first, second] = await provider.requests();
  assert.match(first!, /\[model-negative\][^\n]*\n<<<\ndo not imitate existing characters\n>>>/);
  assert.match(first!, /\[rules\][^\n]*\n<<<\n[^>]*Don't describe or imitate/);
  assert.doesNotMatch(first!, /\[model-prompt\]/, "the compiler wrote no prompt of its own here");
  assert.doesNotMatch(second!, /\[model-/, "the second check sees the person's parts alone");
  assert.match(second!, /\[rules\][^\n]*\n<<<\n[^>]*Don't describe or imitate/, "and the rules");
  const record = JSON.parse(await readFile(join(doc(run)["runDir"], "run.json"), "utf8")) as Doc;
  const policy = record["promptPolicy"];
  assert.equal(policy.verdict, "allowed");
  assert.match(policy.model, /^scripted:prompt-policy:/);
  assert.match(policy.fallback, /objected only to text the prompt compiler wrote/);
  assert.deepEqual(
    (policy.checks as Doc[]).map((c) => [c.scope, c.probability, c.refused, c.decided]),
    [
      ["all", 0.9, true, undefined],
      ["person", 0.1, false, true],
    ],
    "both answers, each with its model and probability, and the second decided",
  );
  for (const check of policy.checks as Doc[]) assert.match(check.model, /^scripted:prompt-policy:/);
  assert.equal(policy.probability, 0.1, "the deciding answer's probability");
});

test("a compiler's empty negative prompt adds no part: the bible's rules are not read again as request text", async () => {
  writeSettings({});
  const { world, planFile, planArgs } = await planWorld();
  const made = await cli([...planArgs, "--json"]);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  await compiledPlan(planFile, "");
  const runs = join(world.dir, "apply-runs");
  const provider = await recorder(world.dir, ALLOW);
  const apply = ["apply", planFile, "--out", runs, "--provider-script", provider.script, "--json"];
  const dry = await cli([...apply, "--dry-run"]);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  const hits = doc(dry)["promptPolicy"].hits as Doc[];
  assert.deepEqual(
    hits.filter((h) => h.term === "imitate").map((h) => h.part),
    ["rules"],
    "the bible's Don't is a rule only, not also a text or model-written part",
  );
  assert.deepEqual(await provider.events(), []);
});

test("when the check also objects to the person's text, apply exits 9 with no generation", async () => {
  writeSettings({});
  const { world, planFile, planArgs } = await planWorld();
  const made = await cli([...planArgs, "--json"]);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  await compiledPlan(planFile, "do not imitate existing characters");
  const provider = await recorder(world.dir, "0.9");
  const runs = join(world.dir, "apply-runs");
  const run = await cli([
    "apply",
    planFile,
    "--out",
    runs,
    "--provider-script",
    provider.script,
    "--json",
  ]);
  assert.equal(run.code, 9, run.stdout + run.stderr);
  assert.equal(doc(run)["error"].code, "prompt_refused");
  assert.deepEqual(await provider.events(), ["prompt-policy", "prompt-policy"]);
  const policy = doc(run)["error"].policy;
  assert.equal(policy.verdict, "refused");
  assert.deepEqual(
    (policy.checks as Doc[]).map((c) => [c.scope, c.refused, c.decided]),
    [
      ["all", true, undefined],
      ["person", true, true],
    ],
    "the person's own text is the reason",
  );
});

test("a plan the template wrote has no model-written text: a refusal at apply exits 9 after one call", async () => {
  writeSettings({});
  const { world, planFile, planArgs } = await planWorld();
  const made = await cli([...planArgs, "--json"]);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  // The model objects to the repository template's own wording.
  const provider = await recorder(
    world.dir,
    `r.prompt.includes("Create original art") ? 0.9 : 0.1`,
  );
  const runs = join(world.dir, "apply-runs");
  const apply = ["apply", planFile, "--out", runs, "--provider-script", provider.script, "--json"];
  const dry = doc(await cli([...apply, "--dry-run"]));
  assert.equal((dry["jobs"] as PlanJob[]).find((j) => j.operation === "prompt-policy")?.count, 1);
  const run = await cli(apply);
  assert.equal(run.code, 9, run.stdout + run.stderr);
  assert.equal(doc(run)["error"].code, "prompt_refused");
  assert.deepEqual(await provider.events(), ["prompt-policy"], "no fallback and no generation");
  assert.deepEqual(
    (doc(run)["error"].policy.checks as Doc[]).map((c) => [c.scope, c.refused, c.decided]),
    [["all", true, true]],
  );
  const [request] = await provider.requests();
  assert.doesNotMatch(request!, /\[model-/, "the template's prompt is not model-written");
  assert.match(request!, /\[template\][^\n]*\n<<<\n[^>]*Create original art/);
});

test("apply's run record carries the model check's answer on an ambiguous name in its note", async () => {
  writeSettings({});
  const { world, planFile, planArgs } = await planWorld();
  const made = await cli([...planArgs, "--json"]);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  const provider = await recorder(world.dir, ALLOW);
  const runs = join(world.dir, "apply-runs");
  const run = await cli([
    ...["apply", planFile, "--out", runs, "--provider-script", provider.script],
    ...["--note", `a lantern for ${AMBIGUOUS}, the baker`, "--json"],
  ]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const record = JSON.parse(await readFile(join(doc(run)["runDir"], "run.json"), "utf8")) as Doc;
  const policy = record["promptPolicy"];
  assert.ok(policy.hits.some((h: Doc) => h.ambiguous === true && h.part === "text"));
  assert.match(policy.model, /^scripted:prompt-policy:/);
  assert.equal(policy.probability, 0.1);
  for (const candidate of record["candidates"] as Doc[])
    assert.deepEqual(candidate["provenance"].promptPolicy, policy);
});

test("each input file's prompt text is labelled by what it is, and the model is told what each label means", async () => {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const file = async (name: string, text: string) => {
    const path = join(world.dir, name);
    await writeFile(path, text);
    return path;
  };
  const data = structuredClone(BIBLE_PRESETS["flat-cartoon-kids"]!);
  const parts = await collectPromptParts({
    spec: await file("spec.json", JSON.stringify({ fields: { description: "a round lantern" } })),
    brief: await file("brief.json", JSON.stringify({ context: "a warm glow" })),
    bible: await file(
      "BIBLE.md",
      serializeBible(data, "## Do's and Don'ts\nDon't imitate the look of any named game.\n"),
    ),
    template: await file("template.md", "---\nversion: 1\n---\nDraw {{spec}} originally.\n"),
  });
  const labels = new Set(parts.map((p) => p.label));
  assert.deepEqual([...labels].sort(), ["brief", "rules", "spec", "template", "tone"]);
  assert.ok(parts.some((p) => p.label === "rules" && p.text.includes("Don't imitate")));
  const record = checkPromptText(parts);
  assert.deepEqual(
    record.hits?.map((h) => [h.term, h.part]),
    [["imitate", "rules"]],
  );
  const prompt = promptPolicyPrompt(parts, record.hits);
  assert.match(
    prompt,
    /\[rules\] art bible Do's and Don'ts: rules the art must follow, not requests:/,
  );
  assert.match(prompt, /\[spec\] asset spec/);
  assert.match(prompt, /\[tone\] art bible tone fields/);
  assert.match(prompt, /\[template\] prompt template body/);
  assert.match(
    promptPolicyPrompt([{ label: "model-negative", text: "no copies" }]),
    /\[model-negative\] compiled negative prompt: model-written by the prompt compiler/,
  );
});
