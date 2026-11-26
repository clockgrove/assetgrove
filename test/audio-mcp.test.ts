/**
 * Audio candidate previews over MCP (#481): a staged master under the read cap is `audio`
 * content, a longer one a `file://` link, the pick form names the same file and sha256 the digest
 * covers, and changing a candidate's bytes leaves it without a preview and refuses its pick.
 */
import "./fixtures/env.ts";
import { approve, stateDir, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { TreeServer } from "../src/tree/serve.ts";
import { gitTarget } from "./fixtures/git.ts";
import { syntheticWorld, writeStyleBible } from "./fixtures/synthetic.ts";
import type { TargetProfile } from "../src/types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
type Answer = (form: ElicitRequest["params"]) => Promise<ElicitResult> | ElicitResult;

const root = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./fixtures/audio-script.ts", import.meta.url));
const MODERN = "2026-07-28";
approve(script);

const temporary: string[] = [];
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
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

async function connect(
  answer?: Answer,
): Promise<{ client: Client; forms: ElicitRequest["params"][] }> {
  const forms: ElicitRequest["params"][] = [];
  const client = new Client(
    { name: "assetgrove-audio-mcp-test", version: "0.0.0" },
    {
      ...(answer && { capabilities: { elicitation: { form: {} } } }),
      versionNegotiation: { mode: { pin: MODERN } },
    },
  );
  if (answer) {
    client.setRequestHandler("elicitation/create", async (request) => {
      forms.push(request.params);
      return answer(request.params);
    });
  }
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--provider-script", script],
      cwd: root,
      env: childEnv(),
      stderr: "pipe",
    }),
  );
  clients.push(client);
  return { client, forms };
}

const sfx = {
  kind: "sfx",
  assetId: "tick",
  subject: "den",
  brief: "a clock tick",
  maxDurationS: 0.25,
};
const ambience = {
  kind: "ambience",
  assetId: "wind",
  subject: "den",
  brief: "wind in pines",
  loopS: 2,
};

let rounds = 0;

async function world(spec: object) {
  const w = await syntheticWorld();
  temporary.push(w.dir);
  gitTarget(w.targetDir);
  const profile: TargetProfile = {
    ...w.profile,
    audio: { loudness: { target: -23, tolerance: 1, truePeakCeiling: -1, encoderHeadroom: 1 } },
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
  } as TargetProfile;
  delete profile.validator;
  const specPath = join(w.dir, "spec.json");
  const bible = join(w.bibleDir, "BIBLE.md");
  const profilePath = join(w.dir, "profile.json");
  await writeFile(specPath, JSON.stringify(spec));
  await writeStyleBible(bible, w.bible);
  await writeFile(profilePath, JSON.stringify(profile));
  return {
    w,
    profilePath,
    args: {
      spec: specPath,
      bible,
      profile: profilePath,
      runs: w.runsDir,
      candidates: 1,
      round: ++rounds,
    },
  };
}

async function stageRun(spec: object) {
  const staged = await world(spec);
  const { client } = await connect();
  const result = await client.callTool({ name: "stage", arguments: staged.args });
  const doc = result.structuredContent as Doc;
  assert.equal(doc["exitCode"], 0, JSON.stringify(doc["error"]));
  const content = result.content as Array<{ type: string; [k: string]: unknown }>;
  return { ...staged, content, doc, runDir: doc["runDir"] as string, client };
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const candidateOf = async (runDir: string) =>
  (JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as Doc)["candidates"][0] as Doc;

/** Flips a sample byte near the end, so the file is still a valid WAV. */
async function flipSample(file: string) {
  const bytes = await readFile(file);
  bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0x55;
  await writeFile(file, bytes);
}

const fields = (form: ElicitRequest["params"]) =>
  Object.keys((form as { requestedSchema: { properties: object } }).requestedSchema.properties);

const acceptAll =
  (candidate = "c1"): Answer =>
  (form): ElicitResult =>
    fields(form).includes("candidate")
      ? { action: "accept", content: { candidate, note: "chosen in the form" } }
      : { action: "accept", content: { approve: true } };

test("an sfx under the read cap is audio content of the staged master's bytes", async () => {
  const { content, runDir } = await stageRun(sfx);
  const audio = content.filter((c) => c.type === "audio");
  assert.equal(audio.length, 1);
  assert.equal(
    content.some((c) => c.type === "resource_link" && String(c["name"]).endsWith("preview")),
    false,
  );
  const bytes = Buffer.from(audio[0]!["data"] as string, "base64");
  const candidate = await candidateOf(runDir);
  assert.equal(candidate["id"], "c1");
  assert.equal(sha(bytes), candidate["sha256"]);
  assert.deepEqual(bytes, await readFile(join(runDir, "c1.wav")));
  assert.equal(audio[0]!["mimeType"], "audio/wav");
});

test("an ambience over the read cap is a file:// link to the staged master and no audio content", async () => {
  const { content, runDir } = await stageRun(ambience);
  assert.equal(
    content.some((c) => c.type === "audio"),
    false,
  );
  const links = content.filter(
    (c) => c.type === "resource_link" && String(c["name"]) === "c1 preview",
  );
  assert.equal(links.length, 1);
  const url = String(links[0]!["uri"]);
  assert.ok(url.startsWith("file://"));
  assert.equal(realpathSync(fileURLToPath(url)), realpathSync(join(runDir, "c1.wav")));
  const candidate = await candidateOf(runDir);
  assert.match(String(links[0]!["description"]), new RegExp(String(candidate["sha256"])));
});

test("the contact sheet stays image content when the run has one", async () => {
  const { content, doc } = await stageRun(sfx);
  if (typeof doc["contactSheet"] === "string")
    assert.equal(content.filter((c) => c.type === "image").length, 1);
});

test("pick over MCP: the form names the preview file and sha256, the pick succeeds and the library checks", async () => {
  const { w, profilePath, runDir } = await stageRun(ambience);
  useAttended();
  const { client, forms } = await connect(acceptAll("c1"));
  const picked = await client.callTool({
    name: "pick",
    arguments: { run: runDir, target: w.targetDir },
  });
  const doc = picked.structuredContent as Doc;
  assert.equal(doc["exitCode"], 0, JSON.stringify(doc["error"]));
  const candidate = await candidateOf(runDir);
  const message = forms[0]!.message;
  assert.ok(message.includes(`file://`), message);
  assert.ok(message.includes(candidate["sha256"]), message);
  assert.match(message, /c1\.wav/);
  const checked = await client.callTool({
    name: "library_check",
    arguments: { target: w.targetDir, profile: profilePath },
  });
  assert.equal(
    (checked.structuredContent as Doc)["ok"],
    true,
    JSON.stringify(checked.structuredContent),
  );
});

test("changed bytes: no preview for the candidate, and its pick is refused", async () => {
  const { w, runDir, args, client } = await stageRun(sfx);
  await flipSample(join(runDir, "c1.wav"));
  const previews = await new TreeServer(w.targetDir, stateDir).candidatePreviews(runDir);
  assert.deepEqual(previews, []);
  const replay = await client.callTool({ name: "stage", arguments: args });
  assert.equal(
    (replay.content as Array<{ type: string }>).some((c) => c.type === "audio"),
    false,
  );
  useAttended();
  const { client: picker, forms } = await connect(acceptAll("c1"));
  const picked = await picker.callTool({
    name: "pick",
    arguments: { run: runDir, target: w.targetDir },
  });
  const doc = picked.structuredContent as Doc;
  assert.equal(doc["exitCode"], 2);
  assert.equal(doc["error"].code, "invalid_input");
  assert.ok(forms.every((f) => !f.message.includes("file://")));
  assert.equal(existsLibraryFile(w.targetDir), false);
});

test("bytes changed while the pick form is open: the pick is refused and no library file is written", async () => {
  const { w, runDir } = await stageRun(sfx);
  useAttended();
  const { client } = await connect(async () => {
    await flipSample(join(runDir, "c1.wav"));
    return { action: "accept", content: { candidate: "c1" } };
  });
  const picked = await client.callTool({
    name: "pick",
    arguments: { run: runDir, target: w.targetDir },
  });
  const doc = picked.structuredContent as Doc;
  assert.equal(doc["exitCode"], 2);
  assert.equal(doc["error"].code, "invalid_input");
  assert.equal(existsLibraryFile(w.targetDir), false);
});

function existsLibraryFile(targetDir: string): boolean {
  return (
    existsSync(join(targetDir, "assets", "tick.wav")) ||
    existsSync(join(targetDir, "assets", "tick.md"))
  );
}
