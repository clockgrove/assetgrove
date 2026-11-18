/**
 * A pack's tools (issue #421): declared as `<name>:<id>` and run only through the runner core hands
 * a preset, identified by the bytes of the executable and of every script the argv names, approved
 * by the command rules (headless honours only settings), run in scratch outside the game project
 * without key variables, its outputs returned as data the hand-off checks like any preset file.
 */
import "./fixtures/env.ts";
import { approveCommand, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { ConfirmationError, type ApprovalGate } from "../src/approvals.ts";
import { failureOutcome } from "../src/commands/result.ts";
import type { ConfirmPort } from "../src/confirm/prompt.ts";
import { toolRunner, type ToolResult, type ToolRunner } from "../src/extension/tools.ts";
import type { RegisteredTool } from "../src/extensions/registry.ts";
import { writeToTarget } from "../src/handoff.ts";
import type { TargetWrite } from "../src/handoff.ts";
import { PRESETS } from "../src/handoff/presets/index.ts";
import type { HandoffPreset, PresetRegistry } from "../src/handoff/presets/index.ts";
import { encodePng } from "../src/image/raster.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { loadSettings } from "../src/settings.ts";
import type { Provenance } from "../src/types.ts";
import { gitTarget } from "./fixtures/git.ts";
import { drawSubject, shelterSpec, syntheticProfile } from "./fixtures/synthetic.ts";

/** A temporary directory by its real path. */
const temp = async (prefix: string) => realpathSync(await mkdtemp(join(tmpdir(), prefix)));

/**
 * The pack's own script, outside scratch and the project (as one inside its package is): it
 * records that it ran, then writes what it saw into scratch.
 */
async function packScript(): Promise<{ script: string; marker: string }> {
  const dir = await temp("assetgrove-pack-pkg-");
  const marker = join(dir, "ran.log");
  const script = join(dir, "build.cjs");
  await writeFile(
    script,
    [
      `const fs = require("node:fs");`,
      `fs.appendFileSync(${JSON.stringify(marker)}, "ran\\n");`,
      `const input = fs.existsSync("input.txt") ? fs.readFileSync("input.txt", "utf8") : "";`,
      `fs.mkdirSync("out", { recursive: true });`,
      `fs.writeFileSync("out/seen.json", JSON.stringify({ cwd: process.cwd(), input, key: process.env.OPENAI_API_KEY ?? null }));`,
    ].join("\n"),
  );
  return { script, marker };
}

const runs = async (marker: string) =>
  existsSync(marker) ? (await readFile(marker, "utf8")).split("\n").filter(Boolean).length : 0;

/** The pack "tooler" declaring `tooler:node`, its executable at the settings field `node`. */
function tools(executable: string): Map<string, RegisteredTool> {
  return new Map([
    [
      "tooler:node",
      {
        id: "tooler:node",
        pack: "tooler",
        package: "@example/tooler",
        setting: "node",
        settings: { node: executable },
      },
    ],
  ]);
}

const gate = (prompt?: ConfirmPort): ApprovalGate => ({
  settings: loadSettings(),
  ...(prompt && { prompt }),
});

async function project(): Promise<string> {
  return gitTarget(join(await temp("assetgrove-tools-"), "game"));
}

/** The approval id a refused run asked for. */
async function askedId(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => assert.fail("the run was not refused"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ConfirmationError, String(error));
  assert.equal(error.code, "confirmation_required");
  assert.equal(error.confirmation?.kind, "command");
  return error.confirmation.id;
}

test("a tool the pack does not declare is refused before anything runs", async () => {
  const { script, marker } = await packScript();
  const dir = await project();
  const run = toolRunner({
    pack: "tooler",
    tools: tools(process.execPath),
    gate: gate(),
    projectDir: dir,
  });
  for (const id of ["tooler:other", "other:node", "node"]) {
    const outcome = failureOutcome(
      await run(id, { args: [script] }).then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
    assert.equal(outcome.error?.code, "command_refused", id);
  }
  // Another pack's runner does not reach tooler's tool.
  const other = toolRunner({
    pack: "other",
    tools: tools(process.execPath),
    gate: gate(),
    projectDir: dir,
  });
  const outcome = failureOutcome(
    await other("tooler:node", { args: [script] }).then(
      () => undefined,
      (e: unknown) => e,
    ),
  );
  assert.equal(outcome.error?.code, "command_refused");
  assert.equal(await runs(marker), 0);
});

test("headless, a tool runs only with a settings approval; it runs in scratch without keys", async () => {
  const { script, marker } = await packScript();
  const dir = await project();
  const runner = (): ToolRunner =>
    toolRunner({ pack: "tooler", tools: tools(process.execPath), gate: gate(), projectDir: dir });
  const id = await askedId(runner()("tooler:node", { args: [script] }));
  assert.equal(await runs(marker), 0, "nothing runs before the approval");
  approveCommand({ hash: id, kind: "tool", argv: [process.execPath, script] });

  const saved = process.env["OPENAI_API_KEY"];
  process.env["OPENAI_API_KEY"] = "sk-synthetic-not-a-key";
  let result: ToolResult;
  try {
    result = await runner()("tooler:node", {
      args: [script],
      files: { "input.txt": "data the pack passed" },
    });
  } finally {
    if (saved === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = saved;
  }
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.step, {
    kind: "tool",
    tool: "tooler:node",
    hash: id,
    method: "settings",
  });
  assert.equal(await runs(marker), 1);
  // Only what the tool made comes back; the unchanged input does not.
  assert.deepEqual(
    result.files.map((f) => f.path),
    ["out/seen.json"],
  );
  const seen = JSON.parse(Buffer.from(result.files[0]!.content).toString("utf8")) as {
    cwd: string;
    input: string;
    key: string | null;
  };
  assert.equal(seen.input, "data the pack passed");
  assert.equal(seen.key, null, "the tool runs without key variables");
  // The working directory was scratch: outside the game project, and gone after the run.
  const cwd = seen.cwd;
  const rel = relative(dir, cwd);
  assert.ok(rel.startsWith("..") || rel === cwd, `${cwd} is outside ${dir}`);
  assert.match(cwd, /assetgrove-tool-/);
  assert.equal(existsSync(cwd), false, "scratch is removed after the run");
});

test("an approval lapses when the binary changes", async () => {
  const dir = await project();
  const bin = join(await temp("assetgrove-tool-bin-"), "engine");
  await writeFile(bin, "engine v1");
  const runner = () =>
    toolRunner({ pack: "tooler", tools: tools(bin), gate: gate(), projectDir: dir });
  const first = await askedId(runner()("tooler:node", { args: ["--headless"] }));
  assert.equal(await askedId(runner()("tooler:node", { args: ["--headless"] })), first);
  approveCommand({ hash: first, kind: "tool", argv: [bin, "--headless"] });
  await writeFile(bin, "engine v2");
  const second = await askedId(runner()("tooler:node", { args: ["--headless"] }));
  assert.notEqual(second, first, "a changed binary is another tool run");
});

test("a person's approval holds while the bytes hold and lapses when the script changes", async () => {
  useAttended();
  const { script, marker } = await packScript();
  const dir = await project();
  let asked = 0;
  const prompt: ConfirmPort = {
    method: "tty",
    confirm: async (request) => {
      asked += 1;
      assert.equal(request.kind, "command");
      return true;
    },
  };
  const runner = () =>
    toolRunner({
      pack: "tooler",
      tools: tools(process.execPath),
      gate: gate(prompt),
      projectDir: dir,
    });
  const a = await runner()("tooler:node", { args: [script] });
  const b = await runner()("tooler:node", { args: [script] });
  assert.equal(asked, 1, "the recorded approval holds across runs");
  assert.equal(b.step.hash, a.step.hash);
  assert.equal(b.step.method, "tty");
  await writeFile(script, `${await readFile(script, "utf8")}\n// changed\n`);
  const c = await runner()("tooler:node", { args: [script] });
  assert.equal(asked, 2, "a changed script is asked again");
  assert.notEqual(c.step.hash, a.step.hash);
  assert.equal(await runs(marker), 3);

  // A script the pack writes into scratch and names in the argv is hashed too.
  const inScratch = (source: string) =>
    runner()("tooler:node", { args: ["gen.cjs"], files: { "gen.cjs": source } });
  const d = await inScratch(`require("node:fs").writeFileSync("x.txt", "1")`);
  await inScratch(`require("node:fs").writeFileSync("x.txt", "1")`);
  assert.equal(asked, 3);
  const e = await inScratch(`require("node:fs").writeFileSync("x.txt", "2")`);
  assert.equal(asked, 4);
  assert.notEqual(e.step.hash, d.step.hash);
});

const PNG = encodePng(drawSubject(32));

const provenance: Provenance = {
  digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  generator: "sprite-strip",
  route: "scripted",
  models: ["scripted"],
  prompt: "a grey fox sheltering",
  parameters: { size: 32 },
  requestIds: ["req-1"],
  referenceHashes: ["abc"],
  bibleVersion: "synthetic-1",
  license: "MIT",
  providerTerms: [],
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  costUsd: 0,
  calls: [],
};

/** A hand-off whose second preset, `tooler:build`, runs the tool and returns its output at `to`. */
async function toolHandoff(to: string, script: string): Promise<TargetWrite> {
  const preset: HandoffPreset = {
    name: "tooler:build",
    optionsSchema: z.strictObject({}),
    write: async (ctx) => {
      const ran = await ctx.run!("tooler:node", {
        args: [script],
        files: { "input.txt": String((ctx.context["spec"] as { assetId: string }).assetId) },
      });
      const seen = ran.files.find((f) => f.path === "out/seen.json");
      assert.ok(seen);
      return [{ path: to, content: seen.content }];
    },
    check: async () => [],
  };
  const registry: PresetRegistry = {
    presets: new Map([...PRESETS, ["tooler:build", preset]]),
    tools: tools(process.execPath),
  };
  const profile = syntheticProfile();
  delete profile.validator;
  profile.handoff = [{ preset: "manifest" }, { preset: "tooler:build" }];
  return {
    profile,
    spec: shelterSpec,
    bibleVersion: "synthetic-1",
    output: {
      bytes: PNG,
      mediaType: "image/png",
      extension: "png",
      fields: {
        frames: { width: 32, height: 32, count: 1 },
        anchor: { x: 16, y: 30 },
        bounds: { x: 3, y: 12, width: 26, height: 15 },
        palette: ["#26242c"],
      },
    },
    provenance,
    run: { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
    registry,
    targetDir: await project(),
  };
}

test("a preset's tool output reaches the target only through the hand-off's path checks", async () => {
  const { script } = await packScript();
  const probe = await toolHandoff("engine/seen.json", script);
  const id = await askedId(writeToTarget(probe));
  approveCommand({ hash: id, kind: "tool", argv: [process.execPath, script] });

  const write = await toolHandoff("engine/seen.json", script);
  const result = await writeToTarget(write);
  const built = result.handoff.find((h) => h.preset === "tooler:build");
  assert.deepEqual(built?.files, ["engine/seen.json"]);
  assert.deepEqual(built?.tools, [
    { kind: "tool", tool: "tooler:node", hash: id, method: "settings" },
  ]);
  const seen = JSON.parse(await readFile(join(write.targetDir, "engine", "seen.json"), "utf8")) as {
    input: string;
  };
  assert.equal(seen.input, shelterSpec.assetId, "target data reached scratch as data");

  // A returned path outside the target is invalid input, and nothing is written.
  const escape = await toolHandoff("../escaped.json", script);
  const outcome = failureOutcome(
    await writeToTarget(escape).then(
      () => undefined,
      (e: unknown) => e,
    ),
  );
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.error?.code, "invalid_input");
  assert.equal(existsSync(join(dirname(escape.targetDir), "escaped.json")), false);
});
