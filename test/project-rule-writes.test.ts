import "./fixtures/env.ts";
import { approve } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { sha256Hex } from "../src/library/canonical.ts";
import { readLibrary } from "../src/library/maintain.ts";
import type { RuleFinding, ProjectRule } from "../src/project-rules.ts";
import { syntheticWorld, writeStyleBible } from "./fixtures/synthetic.ts";
import { libraryProfile } from "./fixtures/library.ts";
import { gitTarget } from "./fixtures/git.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(script);
function cli(
  args: string[],
  json = true,
): Promise<{ code: number; body: Record<string, unknown>; stdout: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args, ...(json ? ["--json"] : [])],
      { cwd: root, env },
      (error, stdout) =>
        resolve({
          code: error ? Number(error.code) : 0,
          body: json ? JSON.parse(stdout) : {},
          stdout,
        }),
    );
    child.stdin?.end();
  });
}
async function fixture(t: { after(fn: () => Promise<void>): void }, rules: ProjectRule[]) {
  const world = await syntheticWorld();
  t.after(() => rm(world.dir, { recursive: true, force: true }));
  gitTarget(world.targetDir);
  world.profile = libraryProfile();
  world.profile.rules = rules;
  const profile = join(world.dir, "profile.json"),
    bible = join(world.bibleDir, "BIBLE.md"),
    spec = join(world.dir, "spec.json");
  await writeFile(profile, JSON.stringify(world.profile));
  await writeStyleBible(bible, world.bible);
  await writeFile(
    spec,
    JSON.stringify({
      kind: "still",
      assetId: "fern",
      subject: "fern",
      fields: { tags: ["actor"] },
    }),
  );
  const staged = await cli([
    "stage",
    "--spec",
    spec,
    "--bible",
    bible,
    "--profile",
    profile,
    "--runs",
    world.runsDir,
    "--candidates",
    "1",
    "--provider-script",
    script,
  ]);
  assert.equal(staged.code, 0, staged.stdout);
  return { ...world, profilePath: profile, runDir: String(staged.body["runDir"]) };
}
const rules = (severity: "error" | "warning"): ProjectRule[] => [
  { id: "bytes", kind: "media", metric: "bytes", max: 1, severity },
  { id: "width", kind: "media", metric: "width", max: 1, severity },
  { id: "labels", kind: "labels", required: ["missing"], severity },
  { id: "description", kind: "required", source: "card", field: "description", severity },
];
async function mcpPick(run: string, target: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "AI_GATEWAY_API_KEY" && value !== undefined,
    ),
  ) as Record<string, string>;
  const client = new Client({ name: "rule-proof", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp"],
      cwd: root,
      env,
      stderr: "pipe",
    }),
  );
  try {
    return await client.callTool({ name: "pick", arguments: { run, candidate: "c1", target } });
  } finally {
    await client.close();
  }
}

test("shared CLI and MCP picks reject measured/card rules before writing or recording a partial pick", async (t) => {
  const world = await fixture(t, rules("error"));
  const before = (await readdir(world.targetDir, { recursive: true })).sort();
  const result = await cli([
    "pick",
    "--run",
    world.runDir,
    "--candidate",
    "c1",
    "--target",
    world.targetDir,
  ]);
  assert.equal(result.code, 2, result.stdout);
  assert.match(result.stdout, /project rule bytes: fern \(media\)/);
  assert.match(result.stdout, /project rule width: fern \(media\)/);
  assert.match(result.stdout, /project rule labels: fern \(card\)/);
  assert.match(result.stdout, /project rule description: fern \(card\)/);
  const mcp = await mcpPick(world.runDir, world.targetDir);
  assert.equal(mcp.isError, true);
  assert.match(JSON.stringify(mcp), /project rule width: fern \(media\)/);
  assert.deepEqual((await readdir(world.targetDir, { recursive: true })).sort(), before);
  assert.equal(
    JSON.parse(await readFile(join(world.runDir, "run.json"), "utf8")).picked,
    undefined,
  );
});

test("warnings preserve severity and phase evidence across writes, library check, CLI and MCP", async (t) => {
  const world = await fixture(t, rules("warning"));
  const result = await cli([
    "pick",
    "--run",
    world.runDir,
    "--candidate",
    "c1",
    "--target",
    world.targetDir,
  ]);
  assert.equal(result.code, 0, result.stdout);
  const findings = result.body["ruleFindings"] as RuleFinding[];
  assert.deepEqual(
    findings.map(({ rule, asset, severity, evidence, status }) => ({
      rule,
      asset,
      severity,
      evidence,
      status,
    })),
    [
      { rule: "bytes", asset: "fern", severity: "warning", evidence: "media", status: "failed" },
      { rule: "width", asset: "fern", severity: "warning", evidence: "media", status: "failed" },
      { rule: "labels", asset: "fern", severity: "warning", evidence: "card", status: "failed" },
      {
        rule: "description",
        asset: "fern",
        severity: "warning",
        evidence: "card",
        status: "failed",
      },
    ],
  );
  assert.deepEqual((await readLibrary(world.profile, world.targetDir)).ruleFindings, findings);
  const check = await cli([
    "library",
    "check",
    "--target",
    world.targetDir,
    "--profile",
    world.profilePath,
  ]);
  assert.equal(check.code, 0, check.stdout);
  assert.deepEqual(check.body["ruleFindings"], findings);
  const human = await cli(
    ["library", "check", "--target", world.targetDir, "--profile", world.profilePath],
    false,
  );
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /warning: project rule bytes: fern \(media\)/);
  assert.match(human.stdout, /warning: project rule labels: fern \(card\)/);
  const mcp = await mcpPick(world.runDir, world.targetDir);
  assert.notEqual(mcp.isError, true);
  assert.deepEqual((mcp.structuredContent as Record<string, unknown>)["ruleFindings"], findings);
  const mediaPath = join(world.targetDir, "assets", "fern.png");
  const finalBytes = await readFile(mediaPath);
  world.profile.rules = [
    {
      id: "exact-bytes",
      kind: "media",
      metric: "bytes",
      max: finalBytes.length,
      severity: "error",
    },
  ];
  assert.equal(
    (await readLibrary(world.profile, world.targetDir)).ruleFindings[0]?.status,
    "passed",
  );
  world.profile.rules = [
    {
      id: "exact-bytes",
      kind: "media",
      metric: "bytes",
      max: finalBytes.length - 1,
      severity: "error",
    },
  ];
  assert.equal(
    (await readLibrary(world.profile, world.targetDir)).ruleFindings[0]?.status,
    "failed",
  );
  world.profile.rules = rules("error");
  const state = await readLibrary(world.profile, world.targetDir);
  assert.deepEqual(
    state.problems.map((p) => p.code),
    ["project_rule:bytes", "project_rule:width", "project_rule:labels", "project_rule:description"],
  );
  await writeFile(
    mediaPath,
    `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256Hex(finalBytes)}\nsize ${finalBytes.length}\n`,
  );
  const pointer = (await readLibrary(world.profile, world.targetDir)).ruleFindings;
  assert.deepEqual(
    pointer.map((f) => f.status),
    ["unavailable", "unavailable", "failed", "failed"],
  );
  await rm(mediaPath);
  assert.deepEqual((await readLibrary(world.profile, world.targetDir)).ruleFindings, pointer);
});
