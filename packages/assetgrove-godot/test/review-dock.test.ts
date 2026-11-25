/**
 * The Assetgrove review dock in a scratch Godot project (issue #480). One temporary project is
 * both the Assetgrove target and the Godot project: a still run of `fern` with two candidates is
 * staged into its `.assetgrove/runs` by the scripted provider, so no key is read anywhere, and the
 * dock addon is copied in beside a driver plugin. A headless Godot editor opens the project once
 * per phase; the driver plugin finds the dock, drives it as a person would and writes what it saw.
 * The dock's accept, reject and regenerate run core's CLI as a child process (regenerate through a
 * shim that adds the scripted provider), and the test confirms a pending request in process as a
 * person at a terminal would. The Godot tests need Godot 4.7.2 on PATH and skip with the reason
 * without it; the layout and shim tests run without it.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bibleMarkdown,
  sampleBible,
  sampleProfile,
  samplePng,
  tempProject,
} from "@clockgrove/assetgrove/testing";
import { findGodot } from "./helpers/godot.ts";

const { godot: GODOT, skip: SKIP } = findGodot();
const TIMEOUT = 300_000;

const ADDON = join(import.meta.dirname, "..", "addons", "assetgrove_review");
const DRIVER = join(import.meta.dirname, "fixtures", "review-dock");
const CLI = fileURLToPath(
  new URL("src/cli.ts", import.meta.resolve("@clockgrove/assetgrove/package.json")),
);

const route = {
  provider: "scripted",
  model: "scripted/still",
  estimatedCostUsd: 0.01,
  outputGrant: { license: "MIT", plan: "api", commercial: true, relabel: true },
};
const stage = realpathSync(mkdtempSync(join(tmpdir(), "godot-review-dock-")));
const project = tempProject();
const runsDir = join(project.dir, ".assetgrove", "runs");
const inputDir = join(project.dir, ".review-test");
const scriptPath = join(stage, "script.mjs");
const shimPath = join(stage, "shim.mjs");

const git = (...args: string[]) => execFileSync("git", args, { cwd: project.dir, stdio: "ignore" });

/** Runs the first argument (core's CLI) with the rest, adding the scripted provider to `vary`. */
const SHIM = `import { spawnSync } from "node:child_process";
const [cli, script, ...args] = process.argv.slice(2);
if (args[0] === "vary") args.push("--provider-script", script);
const done = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
process.exit(done.status ?? 1);
`;

let runId = "";

before(async () => {
  writeFileSync(join(project.dir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
  git("add", ".gitattributes");
  git("commit", "--quiet", "-m", "route png to LFS");
  project.writeSettings({ roles: { image: route, decisions: route } }, { attended: true });

  const bytes = Buffer.from(samplePng(8)).toString("base64");
  writeFileSync(
    scriptPath,
    `const bytes = Buffer.from(${JSON.stringify(bytes)}, "base64");
export default {
  image: () => ({ images: [{ mediaType: "image/png", bytes }] }),
  vision: () => ({ text: "{}" }),
  decide: () => ({ answer: { type: "boolean", probability: 0.1 } }),
};
`,
  );
  writeFileSync(shimPath, SHIM);

  mkdirSync(join(stage, "refs"), { recursive: true });
  for (const name of ["fern", "perspective"])
    writeFileSync(join(stage, "refs", `${name}.png`), samplePng());
  const bible = sampleBible({
    references: [
      { path: "refs/fern.png", role: "character sheet", subject: "fern" },
      { path: "refs/perspective.png", role: "perspective" },
    ],
    subjects: { fern: { description: "a synthetic fern" } },
  });
  const profile = sampleProfile({
    layout: {
      media: "game/art/{{spec.assetId}}.{{output.extension}}",
      manifest: "game/manifests/{{spec.assetId}}.json",
    },
  });
  const write = (name: string, content: string) => {
    writeFileSync(join(stage, name), content);
    return join(stage, name);
  };
  const staged = await project.run(
    "stage",
    {
      spec: write("spec.json", JSON.stringify({ kind: "still", assetId: "fern" })),
      bible: write("BIBLE.md", bibleMarkdown(bible)),
      profile: write("profile.json", JSON.stringify(profile)),
      runs: runsDir,
      providerScript: scriptPath,
      candidates: 2,
    },
    { confirm: () => true },
  );
  assert.equal(staged.exitCode, 0, JSON.stringify(staged.error) + staged.human);
  runId = String(staged.fields["runId"] ?? "");

  writeFileSync(
    join(project.dir, "project.godot"),
    `config_version=5

[application]

config/name="review-dock-test"

[editor_plugins]

enabled=PackedStringArray("res://addons/assetgrove_review/plugin.cfg", "res://addons/assetgrove_review_test/plugin.cfg")
`,
  );
  cpSync(ADDON, join(project.dir, "addons", "assetgrove_review"), { recursive: true });
  cpSync(DRIVER, join(project.dir, "addons", "assetgrove_review_test"), { recursive: true });
  mkdirSync(join(project.dir, "game", "notes"), { recursive: true });
  writeFileSync(join(project.dir, "game", "notes", "private.txt"), "unrelated project data\n");
});

after(() => {
  project.close();
  rmSync(stage, { recursive: true, force: true });
});

interface RunJson {
  candidates: Array<{ id: string; provenance: { route: string; prompt: string } }>;
}
const runJson = (): RunJson =>
  JSON.parse(readFileSync(join(runsDir, runId, "run.json"), "utf8")) as RunJson;

const dockCommand = [process.execPath, CLI];
const shimCommand = [process.execPath, shimPath, CLI, scriptPath];

type Seen = Record<string, unknown> & {
  state?: string;
  details?: string;
  hasPreview?: boolean;
  ran?: number;
  lastOutcome?: string;
  status?: string;
  opened?: string[];
  runIds?: string[];
  result?: { outcome?: string; confirmCommand?: string };
};

/** Opens the project in a headless Godot editor with the driver, and returns what it recorded. */
function drive(input: {
  phase: "inspect" | "act" | "state";
  command: string[];
  candidate: string;
  action?: "accept" | "reject" | "regenerate";
  reason?: string;
}): Seen {
  mkdirSync(inputDir, { recursive: true });
  rmSync(join(inputDir, "result.json"), { force: true });
  writeFileSync(
    join(inputDir, "input.json"),
    JSON.stringify({ ...input, target: project.dir, run: runId }),
  );
  const done = spawnSync(GODOT!, ["--headless", "--editor", "--path", project.dir], {
    env: project.env,
    encoding: "utf8",
    timeout: 240_000,
  });
  const resultPath = join(inputDir, "result.json");
  assert.ok(
    existsSync(resultPath),
    `no result (exit ${done.status}): ${done.stdout.slice(-2000)}${done.stderr.slice(-2000)}`,
  );
  const seen = JSON.parse(readFileSync(resultPath, "utf8")) as Seen;
  assert.equal(seen["dockFound"], true, JSON.stringify(seen) + done.stdout.slice(-2000));
  return seen;
}

/** Confirms a pending request as a person at a terminal would, in process. */
async function confirmAsPerson(confirmCommand: string): Promise<void> {
  const id = confirmCommand.split(" ").pop()!;
  const confirmed = await project.run("confirm", { id }, { confirm: () => true });
  assert.equal(confirmed.exitCode, 0, JSON.stringify(confirmed.error) + confirmed.human);
}

function hashes(dir: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(join(dir, rel))) return out;
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, hashes(dir, path));
    else
      out[path] = createHash("sha256")
        .update(readFileSync(join(dir, path)))
        .digest("hex");
  }
  return out;
}

const names = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

/** Everything a cancelled request must leave as it was: the runs, pending requests, confirmations. */
const records = () => ({
  assetgrove: hashes(join(project.dir, ".assetgrove")),
  pending: names(join(project.stateDir, "pending")),
  confirmations: names(join(dirname(project.settingsPath), "confirmations")),
});

const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
/** Whether `path` is `parent` or inside it. */
const within = (parent: string, path: string) => {
  const rel = relative(real(parent), real(path));
  return !rel.startsWith("..") && !isAbsolute(rel);
};

test("the scratch project is laid out and its run is staged without a key", () => {
  for (const file of [
    "addons/assetgrove_review/plugin.cfg",
    "addons/assetgrove_review/plugin.gd",
    "addons/assetgrove_review/review_dock.gd",
    "addons/assetgrove_review_test/plugin.cfg",
    "addons/assetgrove_review_test/driver.gd",
    "game/notes/private.txt",
  ])
    assert.ok(existsSync(join(project.dir, file)), file);
  assert.deepEqual(names(runsDir), [runId]);
  const run = runJson();
  assert.deepEqual(
    run.candidates.map((c) => c.id),
    ["c1", "c2"],
  );
  for (const c of run.candidates) {
    assert.ok(existsSync(join(runsDir, runId, `${c.id}.png`)), c.id);
    assert.match(c.provenance.route, /scripted/);
  }
});

test("the shim adds the provider script to vary only", () => {
  const echo = join(stage, "echo-cli.mjs");
  writeFileSync(echo, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const ran = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [shimPath, echo, "script.mjs", ...args], { encoding: "utf8" }),
    ) as string[];
  assert.deepEqual(ran("vary", "--run", "r"), [
    "vary",
    "--run",
    "r",
    "--provider-script",
    "script.mjs",
  ]);
  assert.deepEqual(ran("pick", "--run", "r"), ["pick", "--run", "r"]);
  const failing = join(stage, "failing-cli.mjs");
  writeFileSync(failing, "process.exit(8);\n");
  const code = spawnSync(process.execPath, [shimPath, failing, "script.mjs", "vary"]).status;
  assert.equal(code, 8);
});

test("the shim runs core: runs list sees the staged run and vary takes the scripted provider", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [shimPath, CLI, scriptPath, ...args], {
      cwd: project.dir,
      env: project.env,
      encoding: "utf8",
    });
  const listed = run("runs", "list", "--runs", runsDir, "--json");
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.match(listed.stdout, new RegExp(runId));
  const dry = run(
    ...["vary", "--run", join(runsDir, runId), "--candidate", "c1", "--runs", runsDir],
    ...["--dry-run", "--json"],
  );
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
});

test(
  "the dock loads a candidate with its provenance, and a cancelled request changes nothing",
  { skip: SKIP, timeout: TIMEOUT },
  () => {
    const before = records();
    const seen = drive({ phase: "inspect", command: dockCommand, candidate: "c1" });
    const c1 = runJson().candidates[0]!;
    assert.equal(seen.state, "pending");
    assert.ok(seen.details!.includes(c1.provenance.route), seen.details);
    assert.ok(seen.details!.includes(c1.provenance.prompt.split("\n")[0]!), seen.details);
    assert.ok(seen.details!.includes("c1"), seen.details);
    assert.equal(seen.hasPreview, true);
    assert.equal(seen.ran, 0);
    assert.equal(seen.lastOutcome, "cancelled");
    assert.ok(seen.opened!.length > 0);
    for (const path of seen.opened!)
      assert.ok(within(runsDir, path), `${path} is outside the runs`);
    assert.ok(!seen.opened!.some((p) => p.replaceAll("\\", "/").includes("private.txt")));
    assert.deepEqual(records(), before);
  },
);

test(
  "the dock rejects a candidate through the review command",
  { skip: SKIP, timeout: TIMEOUT },
  () => {
    const seen = drive({
      phase: "act",
      command: dockCommand,
      candidate: "c2",
      action: "reject",
      reason: "too dark",
    });
    assert.equal(seen.result?.outcome, "done", JSON.stringify(seen.result));
    assert.equal(seen.state, "rejected");
    const record = readFileSync(join(runsDir, runId, "reviews", "c2.review.json"), "utf8");
    assert.match(record, /"motivation":"assessing"/);
    assert.match(record, /"ag:action":"reject"/);
    assert.match(record, /too dark/);
  },
);

test(
  "the dock accepts a candidate only after the person confirms at a terminal",
  { skip: SKIP, timeout: TIMEOUT },
  async () => {
    const asked = drive({ phase: "act", command: dockCommand, candidate: "c1", action: "accept" });
    assert.equal(asked.result?.outcome, "confirm", JSON.stringify(asked.result));
    const confirmCommand = String(asked.result?.confirmCommand);
    assert.match(confirmCommand, /^assetgrove confirm [0-9a-f]+$/);
    assert.ok(!existsSync(join(project.dir, "game", "art", "fern.png")));
    assert.equal(asked.state, "pending");
    // Refresh only re-reads the runs: the person completes the request with the same button.
    assert.match(String(asked.status), /then press Accept again$/);
    assert.ok(!String(asked.status).includes("Refresh"), asked.status);

    await confirmAsPerson(confirmCommand);
    const done = drive({ phase: "act", command: dockCommand, candidate: "c1", action: "accept" });
    assert.equal(done.result?.outcome, "done", JSON.stringify(done.result));
    const after = drive({ phase: "state", command: dockCommand, candidate: "c1" });
    assert.equal(after.state, "picked");
    assert.ok(existsSync(join(project.dir, "game", "art", "fern.png")));
  },
);

test(
  "the dock regenerates a candidate through the worker, after the person confirms the spend",
  { skip: SKIP, timeout: TIMEOUT },
  async () => {
    const asked = drive({
      phase: "act",
      command: shimCommand,
      candidate: "c1",
      action: "regenerate",
    });
    assert.equal(asked.result?.outcome, "confirm", JSON.stringify(asked.result));
    assert.equal(asked.runIds?.length, 1);
    assert.match(String(asked.status), /then press Regenerate again$/);

    await confirmAsPerson(String(asked.result?.confirmCommand));
    const done = drive({
      phase: "act",
      command: shimCommand,
      candidate: "c1",
      action: "regenerate",
    });
    assert.equal(done.result?.outcome, "done", JSON.stringify(done.result));
    assert.equal(done.runIds?.length, 2, JSON.stringify(done.runIds));
    for (const path of done.opened!)
      assert.ok(within(runsDir, path), `${path} is outside the runs`);
  },
);
