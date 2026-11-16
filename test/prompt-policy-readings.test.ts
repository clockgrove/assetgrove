/**
 * A protected name that is also an ordinary word or a given name is read, not matched (#366): the
 * run's prompt-policy job makes one Choice call per such name a person wrote (the protected name,
 * an ordinary word or an unrelated name), records the answer in the request's policy record and
 * refuses only on the protected reading, with no allow entry anywhere.
 */
import "./fixtures/env.ts";
import { approve, approveProfile, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packageBlocklist } from "../src/policy/blocklist.ts";
import { nameReadingPrompt, nameReadingQuestion, promptPolicyPrompt } from "../src/policy/model.ts";
import { checkPromptText, readingTerms } from "../src/policy/text.ts";
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
const ambiguous = (kind: string) =>
  packageBlocklist()
    .terms.filter((t) => t.kind === kind && t.ambiguous === true)
    .map((t) => t.term);
const [WEATHER, STAR] = ambiguous("studio") as [string, string];
const GIVEN = ambiguous("character").at(-1)!;

/**
 * The issue's three requests: a weather word in a snow level, a kind of star in a skybox and a
 * given name on a baker. Each holds one ambiguous name and nothing else the blocklist flags.
 */
const ORDINARY: Array<{ note: string; term: string; reading: string }> = [
  { note: `heavy ${WEATHER} over a snow level`, term: WEATHER, reading: "word" },
  { note: `red ${STAR} star skybox`, term: STAR, reading: "word" },
  { note: `${GIVEN} the baker NPC`, term: GIVEN, reading: "other-name" },
];

/**
 * A paid provider script that notes every call in `<dir>/events` and every reading request in
 * `<dir>/readings.jsonl`; it reads `protectedTerm` as the protected name, a given name as an
 * unrelated name and anything else as an ordinary word. The Boolean check answers 0.1.
 */
async function recorder(dir: string, protectedTerm = "") {
  const script = join(dir, "policy-readings.mjs");
  const events = join(dir, "events");
  const readings = join(dir, "readings.jsonl");
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
import base from ${JSON.stringify(pathToFileURL(passingScript).href)};
const note = (kind) => appendFileSync(${JSON.stringify(events)}, kind + "\\n");
const asked = (prompt) => /^Flagged word: "([^"]*)"/m.exec(prompt)?.[1];
export default {
  paid: true,
  image: (r, i) => (note("image"), base.image(r, i)),
  vision: (r, i) => (note("vision"), base.vision(r, i)),
  promptPolicy: () => (note("prompt-policy"), { answer: { type: "boolean", probability: 0.1 } }),
  promptReading: (r) => {
    const term = asked(r.prompt);
    note("reading:" + term);
    appendFileSync(${JSON.stringify(readings)}, JSON.stringify({ prompt: r.prompt, question: r.question }) + "\\n");
    const choice = term === ${JSON.stringify(protectedTerm)} ? "protected" : term === ${JSON.stringify(GIVEN)} ? "other-name" : "word";
    return { answer: { type: "choice", choice, probabilities: { [choice]: 0.9 } } };
  },
};`,
  );
  approve(script);
  const lines = async (path: string) =>
    existsSync(path) ? (await readFile(path, "utf8")).split("\n").filter(Boolean) : [];
  return {
    script,
    events: () => lines(events),
    readings: async () =>
      (await lines(readings)).map((l) => JSON.parse(l) as { prompt: string; question: Doc }),
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

const policyJob = (d: Doc) => (d["jobs"] as Doc[]).find((j) => j["operation"] === "prompt-policy")!;

for (const { note, term, reading } of ORDINARY) {
  test(`"${note.replace(term, "<name>")}" is read as ${reading}, recorded, and allowed with no allow entry`, async () => {
    writeSettings({});
    const { world, flags } = await stageWorld();
    const provider = await recorder(world.dir);
    const base = ["stage", ...flags, "--candidates", "1", "--note", note, "--json"];
    const dry = await cli([...base, "--dry-run", "--provider-script", provider.script]);
    assert.equal(dry.code, 0, dry.stdout + dry.stderr);
    assert.equal(policyJob(doc(dry))["count"], 2, "one reading and one Boolean call forecast");
    assert.deepEqual(await provider.events(), [], "a dry run calls nothing");

    const run = await cli([...base, "--provider-script", provider.script]);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const events = await provider.events();
    assert.deepEqual(events.slice(0, 2), [`reading:${term}`, "prompt-policy"]);
    assert.ok(events.includes("image"), "the run went on to generate");
    const record = JSON.parse(await readFile(join(doc(run)["runDir"], "run.json"), "utf8")) as Doc;
    const policy = record["promptPolicy"];
    assert.equal(policy.verdict, "allowed");
    assert.deepEqual(policy.allowedBy, []);
    assert.equal(policy.readings.length, 1);
    assert.equal(policy.readings[0].term, term);
    assert.equal(policy.readings[0].reading, reading);
    assert.match(policy.readings[0].model, /:prompt-policy:/);
    assert.equal(policy.readings[0].probability, 0.9);

    // The reading call is a Choice question given the term, its kind and its sentence.
    const [asked] = await provider.readings();
    assert.equal(asked!.question["type"], "choice");
    assert.deepEqual(Object.keys(asked!.question["options"]), ["protected", "word", "other-name"]);
    assert.ok(asked!.prompt.includes(`Flagged word: "${term}"`));
    assert.ok(asked!.prompt.includes(note.toLowerCase()), "the sentence it appears in");
  });
}

test("a protected reading refuses the request (exit 9) with the reading recorded, and nothing else runs", async () => {
  writeSettings({});
  const { world, flags } = await stageWorld();
  const provider = await recorder(world.dir, GIVEN);
  const note = `${GIVEN} as the famous video game character, copied exactly`;
  const run = await cli([
    "stage",
    ...flags,
    "--candidates",
    "1",
    "--note",
    note,
    "--json",
    "--provider-script",
    provider.script,
  ]);
  assert.equal(run.code, 9, run.stdout + run.stderr);
  const error = doc(run)["error"];
  assert.equal(error.code, "prompt_refused");
  assert.equal(error.policy.verdict, "refused");
  assert.deepEqual(
    error.policy.readings.map((r: Doc) => [r.term, r.reading]),
    [[GIVEN, "protected"]],
  );
  assert.match(error.message, /as the protected character name/);
  assert.deepEqual(await provider.events(), [`reading:${GIVEN}`], "no other call ran");
});

test("only ambiguous names a person wrote are read; phrases and compiler-written names are not", () => {
  const record = checkPromptText([
    { label: "brief", text: `heavy ${WEATHER} and a lantern inspired by fireflies` },
    { label: "model-prompt", text: `a ${STAR} star` },
  ]);
  assert.equal(record.verdict, "allowed");
  const groups = readingTerms(record.hits);
  assert.deepEqual(
    groups.map((g) => g.map((h) => [h.term, h.part])),
    [[[WEATHER, "brief"]]],
  );
  const prompt = nameReadingPrompt(groups[0]!, [
    { label: "brief", text: `heavy ${WEATHER} and a lantern` },
  ]);
  assert.match(prompt, /also an ordinary word or a given name/);
  assert.match(prompt, /\[brief\]/);
  const question = nameReadingQuestion(WEATHER, "studio");
  assert.equal(question.type, "choice");
});

test("a person-written reading leaves the compiler's use of the same name on the Boolean call's flagged words", () => {
  const parts = [
    { label: "brief" as const, text: `heavy ${WEATHER} over a snow level` },
    { label: "model-prompt" as const, text: `snow level, ${WEATHER} style` },
  ];
  const record = checkPromptText(parts);
  assert.deepEqual(
    record.hits!.filter((h) => h.term === WEATHER).map((h) => h.part),
    ["brief", "model-prompt"],
  );
  assert.deepEqual(
    readingTerms(record.hits).map((g) => g.map((h) => h.part)),
    [["brief"]],
    "only the person's use is read",
  );
  const prompt = promptPolicyPrompt(parts, record.hits, [
    { term: WEATHER, kind: "studio", reading: "word", model: "script:prompt-policy:test" },
  ]);
  const flagged = prompt.split("\n").filter((l) => l.startsWith(`- "${WEATHER}" (`));
  assert.equal(flagged.length, 1, "the compiler's use is still flagged");
  assert.match(flagged[0]!, /in \[model-prompt\]/);
  assert.match(prompt, /already read in the person-written parts/);
});
