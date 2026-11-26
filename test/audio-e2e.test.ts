/**
 * Core's audio kinds end to end (#481, acceptance 4, 5 and 8), on the scripted audio provider
 * (test/fixtures/audio-script.ts) in a temporary Git repository: an `sfx`, an `ambience` loop, a
 * music loop, a track and a cue each go through staging, preview, a person's pick and library check,
 * once through the CLI and once through the MCP server. The `stage` JSON carries each candidate's
 * numbers, the contact sheet its waveform, and the preview is the staged master the pick digest
 * covers, so changed bytes are refused. A stage run killed after its first candidate was staged
 * resumes under its confirmation with that candidate's exact audio.
 */
import "./fixtures/env.ts";
import { approve, confirmationsDir, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { confirmCommand } from "../src/commands/confirm.ts";
import { runCommand } from "../src/commands/runner.ts";
import type { ConfirmPort } from "../src/confirm/prompt.ts";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { decodeImage } from "../src/image/raster.ts";
import { loadSettings } from "../src/settings.ts";
import { gitTarget } from "./fixtures/git.ts";
import { syntheticWorld, writeStyleBible } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/audio-script.ts", import.meta.url));
approve(SCRIPT);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
interface Result {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

const temporary: string[] = [];
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

const LOUDNESS = { target: -23, tolerance: 1, truePeakCeiling: -1, encoderHeadroom: 1 };

/** One spec of each audio form, as a game would write it. */
const SPECS: Array<Record<string, unknown>> = [
  { kind: "sfx", assetId: "tick", brief: "a clock tick", maxDurationS: 0.25 },
  { kind: "ambience", assetId: "wind", brief: "wind in pine trees", loopS: 1 },
  {
    kind: "music",
    assetId: "village",
    brief: "a calm village theme",
    form: "track",
    loop: { bpm: 240, bars: 1, beatsPerBar: 4 },
  },
  {
    kind: "music",
    assetId: "credits",
    brief: "warm closing credits",
    form: "track",
    durationS: 1.5,
  },
  { kind: "music", assetId: "sting", brief: "a bright discovery sting", form: "cue", durationS: 1 },
];

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A target repository with a library, an audio profile and a style bible. */
async function project() {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const target = realpathSync(gitTarget(world.targetDir));
  const profile = {
    ...world.profile,
    audio: { loudness: LOUDNESS },
    layout: {
      media: "assets/{{spec.assetId}}.{{output.extension}}",
      manifest: "manifests/{{spec.assetId}}.json",
    },
    manifest: {
      assetId: "{{spec.assetId}}",
      review: { status: "pending" },
      contentHash: "{{output.sha256}}",
    },
    review: { path: "review.status", pending: "pending" },
    library: { root: "assets", game: "test-grove" },
  } as Record<string, unknown>;
  delete profile["validator"];
  const profilePath = join(world.dir, "profile.json");
  await writeFile(profilePath, JSON.stringify(profile));
  const bible = join(world.bibleDir, "BIBLE.md");
  await writeStyleBible(bible, world.bible);
  const specs: string[] = [];
  for (const spec of SPECS) {
    const path = join(world.dir, `${spec["assetId"] as string}.spec.json`);
    await writeFile(path, JSON.stringify(spec));
    specs.push(path);
  }
  return { world, target, profilePath, bible, specs, runs: world.runsDir };
}

function cli(args: string[], cwd = root): Promise<Result> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      [join(root, "src/cli.ts"), ...args],
      { cwd, env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error.code as unknown as number | null) ?? null) : 0,
          signal: error?.signal ?? null,
          stdout,
          stderr,
        }),
    );
    child.stdin?.end();
  });
}

const doc = (r: Result): Doc => JSON.parse(r.stdout) as Doc;

/** A person at the terminal who confirms whatever they are asked. */
const person: ConfirmPort = {
  method: "tty",
  confirm: async () => true,
  choose: async (r) => r.choices?.[0],
};

async function confirm(id: string): Promise<void> {
  const done = await runCommand(
    confirmCommand,
    { id },
    { settings: loadSettings(), log: () => {}, prompt: person },
  );
  assert.equal(done.exitCode, 0, done.error?.message);
}

/** Stages `spec` on the scripted audio provider; the person confirms its spend at the terminal. */
async function stage(p: Awaited<ReturnType<typeof project>>, spec: string): Promise<Doc> {
  const args = [
    ...["stage", "--spec", spec, "--bible", p.bible, "--profile", p.profilePath],
    ...["--runs", p.runs, "--candidates", "1", "--provider-script", SCRIPT, "--json"],
  ];
  const asked = await cli(args);
  assert.equal(asked.code, 8, asked.stdout + asked.stderr);
  assert.equal(doc(asked)["error"].confirmation.kind, "spend");
  await confirm(doc(asked)["error"].confirmation.id as string);
  const staged = await cli(args);
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  return doc(staged);
}

/** Checks the stage JSON's numbers and preview of one staged audio candidate. */
async function checkStaged(staged: Doc, spec: Record<string, unknown>): Promise<Doc> {
  const candidate = staged["candidates"][0] as Doc;
  assert.equal(candidate["mediaType"], "audio/wav");
  assert.match(candidate["file"], /\.wav$/);
  // The preview is the staged master: the bytes the pick digest covers.
  const preview = await readFile(join(staged["runDir"], candidate["file"]));
  assert.equal(sha256(preview), candidate["sha256"]);
  assert.ok(
    candidate["reasons"].every((r: Doc) => r["passed"]),
    JSON.stringify(candidate),
  );
  const audio = candidate["fields"]["audio"] as Doc;
  assert.equal(audio["kind"], spec["kind"]);
  assert.equal(typeof audio["durationS"], "number");
  assert.equal(typeof audio["loudness"]["truePeak"], "number");
  const loudness =
    spec["kind"] === "sfx" ? audio["loudness"]["truePeak"] : audio["loudness"]["integrated"];
  assert.equal(typeof loudness, "number");
  const loops = spec["kind"] === "ambience" || spec["loop"] !== undefined;
  assert.equal(typeof audio["loop"]?.["frames"], loops ? "number" : "undefined");
  if (loops) assert.equal(audio["frames"], audio["loop"]["frames"]);
  // The contact sheet shows the candidate's waveform.
  assert.equal(staged["contactSheet"], "contact.png");
  const sheet = decodeImage(await readFile(join(staged["runDir"], "contact.png")));
  assert.ok(sheet.width > 0 && sheet.height > 0);
  return candidate;
}

test("an sfx, an ambience loop, a music loop, a track and a cue go through CLI staging, preview, a person's pick and library check", async () => {
  useAttended();
  const p = await project();
  for (const [i, specPath] of p.specs.entries()) {
    const spec = SPECS[i]!;
    const staged = await stage(p, specPath);
    const candidate = await checkStaged(staged, spec);

    // The person is asked, confirms at the terminal, and the pick runs.
    const pick = ["pick", "--run", staged["runDir"], "--candidate", "c1"];
    const asked = await cli([...pick, "--target", p.target, "--json"], p.target);
    assert.equal(asked.code, 8, asked.stdout + asked.stderr);
    const confirmation = doc(asked)["error"].confirmation;
    assert.equal(confirmation.kind, "pick");
    await confirm(confirmation.id);
    const picked = await cli([...pick, "--target", p.target, "--json"], p.target);
    assert.equal(picked.code, 0, picked.stdout + picked.stderr);
    assert.equal(doc(picked)["confirmation"].digest, confirmation.id);
    assert.equal(doc(picked)["confirmation"].choice, "c1");
    assert.equal(doc(picked)["candidate"].sha256, candidate["sha256"]);
    assert.ok(existsSync(join(p.target, "assets", `${spec["assetId"] as string}.wav`)));
  }
  const checked = await cli(
    ["library", "check", "--target", p.target, "--profile", p.profilePath, "--json"],
    p.target,
  );
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);
  assert.deepEqual(doc(checked)["problems"], []);
});

test("changing a staged candidate's bytes after its pick is confirmed refuses the pick", async () => {
  useAttended();
  const p = await project();
  const runDir = (await stage(p, p.specs[1]!))["runDir"] as string;
  const pick = ["pick", "--run", runDir, "--candidate", "c1", "--target", p.target, "--json"];
  const asked = await cli(pick, p.target);
  assert.equal(asked.code, 8, asked.stdout + asked.stderr);
  await confirm(doc(asked)["error"].confirmation.id);

  // One sample changed: the file is still a valid WAV, but not the bytes the person confirmed.
  const file = join(runDir, "c1.wav");
  const bytes = new Uint8Array(await readFile(file));
  bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 0x01;
  await writeFile(file, bytes);
  const refused = await cli(pick, p.target);
  assert.equal(refused.code, 2, refused.stdout + refused.stderr);
  assert.match(doc(refused)["error"].message, /staged file c1\.wav changed since it was staged/);
  assert.equal(existsSync(join(p.target, "assets", "wind.wav")), false);
});

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["AI_GATEWAY_API_KEY"];
  for (const name of REFUSED_VARIABLES) {
    delete env[name];
    delete env[name.toLowerCase()];
  }
  return env;
}

const formFields = (form: ElicitRequest["params"]) =>
  Object.keys((form as { requestedSchema: { properties: object } }).requestedSchema.properties);

test("the same five go through MCP staging, preview, a person's pick in the form and library check", async () => {
  useAttended();
  const p = await project();
  const forms: ElicitRequest["params"][] = [];
  const client = new Client(
    { name: "assetgrove-audio-test", version: "0.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  client.setRequestHandler("elicitation/create", async (request): Promise<ElicitResult> => {
    forms.push(request.params);
    return formFields(request.params).includes("candidate")
      ? { action: "accept", content: { candidate: "c1" } }
      : { action: "accept", content: { approve: true } };
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--provider-script", SCRIPT],
      cwd: root,
      env: childEnv(),
      stderr: "pipe",
    }),
  );
  clients.push(client);

  const previewed: string[] = [];
  for (const [i, specPath] of p.specs.entries()) {
    const spec = SPECS[i]!;
    const result = await client.callTool({
      name: "stage",
      arguments: {
        spec: specPath,
        bible: p.bible,
        profile: p.profilePath,
        runs: p.runs,
        candidates: 1,
      },
    });
    const staged = result.structuredContent as Doc;
    assert.equal(staged["exitCode"], 0, JSON.stringify(staged["error"]));
    const candidate = await checkStaged(staged, spec);
    const file = join(staged["runDir"], candidate["file"]);
    const bytes = await readFile(file);

    // The preview: audio content under the read cap, else a file:// link to the same bytes.
    const content = result.content as Doc[];
    assert.ok(
      content.some((c) => c["type"] === "image"),
      "the contact sheet",
    );
    const audio = content.filter((c) => c["type"] === "audio");
    const links = content.filter(
      (c) => c["type"] === "resource_link" && String(c["uri"]).startsWith("file:"),
    );
    const inline = Math.ceil(bytes.length / 3) * 4 <= 64 * 1024;
    previewed.push(inline ? "audio" : "link");
    if (inline) {
      assert.equal(audio.length, 1, `${spec["assetId"] as string} is under the read cap`);
      assert.equal(audio[0]!["mimeType"], "audio/wav");
      assert.equal(sha256(Buffer.from(audio[0]!["data"], "base64")), candidate["sha256"]);
      assert.equal(links.length, 0);
    } else {
      assert.equal(audio.length, 0, `${spec["assetId"] as string} is over the read cap`);
      assert.equal(links.length, 1);
      assert.equal(realpathSync(fileURLToPath(links[0]!["uri"])), realpathSync(file));
      assert.equal(links[0]!["mimeType"], "audio/wav");
    }

    // The person picks in the form, which names the preview the digest covers.
    forms.length = 0;
    const picked = (
      await client.callTool({
        name: "pick",
        arguments: { run: staged["runDir"], target: p.target },
      })
    ).structuredContent as Doc;
    assert.equal(picked["exitCode"], 0, JSON.stringify(picked["error"]));
    assert.equal(picked["confirmation"].method, "elicitation");
    assert.equal(picked["confirmation"].choice, "c1");
    assert.equal(picked["candidate"].sha256, candidate["sha256"]);
    const pickForm = forms.find((f) => formFields(f).includes("candidate"));
    assert.ok(pickForm, "the person was asked to pick");
    assert.ok(pickForm.message.includes(pathToFileURL(file).href), pickForm.message);
    assert.ok(pickForm.message.includes(candidate["sha256"] as string));
  }
  // The short sfx is played inline; the loops, track and cue are linked.
  assert.deepEqual(previewed, ["audio", "link", "link", "link", "link"]);
  // The scripted run used no unapproved validator; library check passes over MCP too.
  const checked = (
    await client.callTool({
      name: "library_check",
      arguments: { target: p.target, profile: p.profilePath },
    })
  ).structuredContent as Doc;
  assert.equal(checked["exitCode"], 0, JSON.stringify(checked));
  assert.deepEqual(checked["problems"], []);
});

/**
 * A paid audio script that counts its calls in `events`. When the `stop` file holds k, the call
 * after the k-th kills its own process: a run interrupted after k calls.
 */
async function countingScript(dir: string) {
  const script = join(dir, "counting-audio.mjs");
  const events = join(dir, "counting.events");
  const stop = join(dir, "counting.stop");
  await writeFile(
    script,
    `import { appendFileSync, existsSync, readFileSync } from "node:fs";
import base from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
const events = ${JSON.stringify(events)};
const stop = ${JSON.stringify(stop)};
const count = () => {
  const made = existsSync(events) ? readFileSync(events, "utf8").split("\\n").filter(Boolean).length : 0;
  if (existsSync(stop) && made >= Number(readFileSync(stop, "utf8"))) process.kill(process.pid, "SIGKILL");
  appendFileSync(events, "audio\\n");
};
export default { ...base, paid: true, audio: (r, i) => (count(), base.audio(r, i)) };`,
  );
  approve(script);
  const count = async () =>
    existsSync(events) ? (await readFile(events, "utf8")).split("\n").filter(Boolean).length : 0;
  return { script, stop, count };
}

test("a stage run killed after its first candidate resumes with that candidate's exact audio and its confirmation record", async (t) => {
  if (process.platform === "win32") return t.skip("SIGKILL interruption is POSIX");
  useAttended();
  const p = await project();
  const provider = await countingScript(p.world.dir);
  const args = [
    ...["stage", "--spec", p.specs[2]!, "--bible", p.bible, "--profile", p.profilePath],
    ...["--runs", p.runs, "--candidates", "2", "--provider-script", provider.script, "--json"],
  ];
  const asked = await cli(args);
  assert.equal(asked.code, 8, asked.stdout + asked.stderr);
  const id = doc(asked)["error"].confirmation.id as string;
  await confirm(id);

  // Killed at the second candidate's call: the first is staged, its audio call journaled.
  await writeFile(provider.stop, "1");
  const killed = await cli(args);
  assert.equal(killed.signal, "SIGKILL", "the run was interrupted");
  assert.equal(await provider.count(), 1);
  await rm(provider.stop);
  const runDir = join(p.runs, `r-${id.slice(0, 16)}`);
  const first = await readFile(join(runDir, "c1.wav"));

  // The resume asks no one (there is no person to ask) and pays only for the missing call.
  const resumed = await cli(args);
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  assert.equal(doc(resumed)["runDir"], runDir);
  assert.equal(await provider.count(), 2, "the first candidate's call came from the journal");
  const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as Doc;
  const c1 = run["candidates"].find((c: Doc) => c["id"] === "c1") as Doc;
  assert.equal(c1["sha256"], sha256(first), "the staged audio is the same bytes");
  assert.equal(sha256(await readFile(join(runDir, "c1.wav"))), c1["sha256"]);
  assert.equal(run["candidates"].length, 2);

  // Its confirmation record is the one the person gave, kept through the kill.
  const record = JSON.parse(await readFile(join(confirmationsDir, `${id}.json`), "utf8")) as Doc;
  for (const key of ["kind", "digest", "method", "at", "forecastUsd"])
    assert.deepEqual(run["confirmation"][key], record[key], key);
  assert.equal(run["confirmation"].digest, id);

  // The finished run replays as it ended: the same candidates, no call.
  const replayed = await cli(args);
  assert.equal(replayed.code, 0, replayed.stdout + replayed.stderr);
  assert.equal(doc(replayed)["reused"], true);
  assert.deepEqual(doc(replayed)["candidates"], doc(resumed)["candidates"]);
  assert.equal(await provider.count(), 2);
});
