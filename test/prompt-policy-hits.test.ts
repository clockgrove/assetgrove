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
import { planDigest } from "../src/planning.ts";
import type { SavedPlan } from "../src/planning.ts";
import type { PlanJob } from "../src/runs/plan.ts";
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
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
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

test("an ambiguous name is decided by the model check and its answer recorded, with no allow entry", async () => {
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
  assert.equal(policy.probability, 0.1, "the model's answer on it");
  assert.match((await provider.requests())[0]!, /also an ordinary word or a given name/);
});

/** A world with a Markdown bible whose Don'ts forbid imitation, a default template and a plan. */
async function planWorld() {
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
      fields: { description: "a round lantern icon" },
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

test("when the check objects only to compiler-written text, apply falls back to the template's prompt and records why", async () => {
  writeSettings({});
  const { world, planFile, planArgs } = await planWorld();
  const made = await cli([...planArgs, "--json"]);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  // The saved prompts as the compiler might have written them: a negative that names imitation.
  const saved = JSON.parse(await readFile(planFile, "utf8")) as SavedPlan;
  const negative = "do not imitate existing characters";
  const edited: Omit<SavedPlan, "digest"> & { digest?: string } = {
    ...saved,
    prompts: {
      ...saved.prompts,
      images: saved.prompts.images.map((p) => `${p}\n${negative}`),
      generation: `${saved.prompts.generation}\n${negative}`,
      negative: `${negative}\n${saved.prompts.negative}`,
    },
  };
  delete edited.digest;
  await writeFile(planFile, JSON.stringify({ ...edited, digest: planDigest(edited) }));
  const runs = join(world.dir, "apply-runs");
  // The model objects whenever compiler-written text is in front of it.
  const provider = await recorder(world.dir, `r.prompt.includes("[model-") ? 0.9 : 0.1`);
  const apply = ["apply", planFile, "--out", runs, "--provider-script", provider.script, "--json"];
  const dry = doc(await cli([...apply, "--dry-run"]));
  const hits = dry["promptPolicy"].hits as Doc[];
  assert.ok(hits.some((h) => h.term === "imitate" && h.part === "model-negative"));
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
    assert.ok(prompt.startsWith(saved.prompts.images[0]!.split("\n")[0]!));
  }
  const [first, second] = await provider.requests();
  assert.match(first!, /\[model-negative\]/);
  assert.doesNotMatch(second!, /\[model-/, "the second check sees the person's parts alone");
  const record = JSON.parse(await readFile(join(doc(run)["runDir"], "run.json"), "utf8")) as Doc;
  assert.equal(record["promptPolicy"].verdict, "allowed");
  assert.match(record["promptPolicy"].fallback, /objected only to text the prompt compiler wrote/);
});

test("when the check also objects to the person's text, apply exits 9 with no generation", async () => {
  writeSettings({});
  const { world, planFile, planArgs } = await planWorld();
  const made = await cli([...planArgs, "--json"]);
  assert.equal(made.code, 0, made.stdout + made.stderr);
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
});
