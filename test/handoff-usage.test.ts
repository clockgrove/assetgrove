/**
 * The replacement preview lists each preset's known usage of the asset it replaces (issue #469):
 * `details.usage` and the summary, outside the digest, with the context a preset's `usage` gets.
 */
import "./fixtures/env.ts";
import { approve, approveProfile, stateDir } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { pickRequest } from "../src/commands/pick.ts";
import { PRESETS } from "../src/handoff/presets/index.ts";
import type {
  HandoffPreset,
  PresetRegistry,
  UsageContext,
  UsageReport,
} from "../src/handoff/presets/index.ts";
import { replacementUsage } from "../src/handoff/usage.ts";
import { currentVersion } from "../src/library/write.ts";
import { shelterSpec, syntheticWorld, writeStyleBible } from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";
import { gitTarget } from "./fixtures/git.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(passingScript);

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args],
      { cwd: root, env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

async function stage(world: World, handoff?: unknown[]): Promise<string> {
  const specPath = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "BIBLE.md");
  const profile = join(world.dir, "profile.json");
  if (handoff !== undefined) world.profile.handoff = handoff as never;
  approveProfile(world.profile, { targetDir: world.targetDir });
  await writeFile(specPath, JSON.stringify(shelterSpec));
  await writeStyleBible(bible, world.bible);
  await writeFile(profile, JSON.stringify(world.profile));
  const r = await cli([
    "stage",
    ...["--spec", specPath, "--bible", bible, "--profile", profile],
    ...["--runs", world.runsDir, "--candidates", "1"],
    ...["--provider-script", passingScript, "--json"],
  ]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return (JSON.parse(r.stdout) as { runDir: string }).runDir;
}

async function pickRun(runDir: string, targetDir: string) {
  const r = await cli([
    "pick",
    "--run",
    runDir,
    "--candidate",
    "c1",
    "--target",
    targetDir,
    "--json",
  ]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
}

const REPORT: UsageReport = {
  asset: { path: "res://assets/source/fern/shelter.png", uid: "uid://abc" },
  references: [
    {
      file: "game/scenes/level.tscn",
      line: 4,
      path: "res://assets/source/fern/shelter.png",
      uid: "uid://abc",
      status: "resolved",
      locations: ['node "Level/Player" scene'],
    },
    {
      file: "game/x.tscn",
      line: 7,
      path: "res://gone.png",
      uid: "uid://zzz",
      status: "unresolved",
      locations: [],
      reason: "resolves to nothing",
    },
    { file: "game/y.scn", status: "unreadable", locations: [], reason: "binary resource" },
  ],
};

function fakeRegistry(usage: (ctx: UsageContext) => Promise<UsageReport>): PresetRegistry {
  const fake: HandoffPreset = {
    name: "fake:usage",
    optionsSchema: z.object({}).passthrough(),
    write: async () => [],
    check: async () => [],
    usage: async (ctx) => usage(ctx),
  };
  return { presets: new Map([...PRESETS, [fake.name, fake]]) };
}

const HANDOFF = [{ preset: "manifest" }, { preset: "fake:usage" }];

/** A git world with the asset picked once and a second run staged to replace it. */
async function replacement() {
  const world = await syntheticWorld();
  gitTarget(world.targetDir);
  execFileSync("git", [
    "-C",
    world.targetDir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
  const first = await stage(world);
  await pickRun(first, world.targetDir);
  const second = await stage(world, HANDOFF);
  return { world, args: { run: second, candidate: "c1", target: world.targetDir } };
}

async function listing(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { recursive: true })) {
    const rel = entry.toString();
    if (rel === ".git" || rel.startsWith(`.git${join("/", "")}`)) continue;
    const s = await stat(join(dir, rel));
    out.push(`${rel}:${s.size}:${s.mtimeMs}`);
  }
  return out.sort();
}

test("the replacement form lists usage, marks unresolved and unreadable, and leaves the digest", async () => {
  const { world, args } = await replacement();
  let seen: UsageContext | undefined;
  let listed: string[] = [];
  let roundTrip: unknown;
  const registry = fakeRegistry(async (ctx) => {
    seen = ctx;
    listed = (await ctx.list("")).map((e) => e.path);
    await ctx.cache.set("k", { n: 1 });
    roundTrip = await ctx.cache.get("k");
    return REPORT;
  });
  const before = await listing(world.targetDir);
  const plain = await pickRequest(args);
  const request = await pickRequest(args, { registry, stateDir });
  assert.equal(request.id, plain.id);
  assert.deepEqual(request.body, plain.body);
  const usage = (request.details as Record<string, unknown>)["usage"];
  assert.deepEqual(usage, [{ preset: "fake:usage", report: REPORT }]);
  assert.equal((plain.details as Record<string, unknown>)["usage"], undefined);
  assert.match(
    request.summary,
    /replacing version 1 of fern-shelter \(sha256 [0-9a-f]{64}\); known usage \(fake:usage\): game\/scenes\/level\.tscn:4 res:\/\/assets\/source\/fern\/shelter\.png uid:\/\/abc \(node "Level\/Player" scene\)/,
  );
  assert.match(
    request.summary,
    /; UNRESOLVED game\/x\.tscn:7 res:\/\/gone\.png uid:\/\/zzz \(resolves to nothing\)/,
  );
  assert.match(request.summary, /; UNREADABLE game\/y\.scn \(binary resource\)/);

  assert.ok(seen);
  const current = await currentVersion(world.profile, shelterSpec, world.targetDir);
  assert.equal(
    seen.media,
    relative(await realpath(world.targetDir), await realpath(current.media!)).replaceAll("\\", "/"),
  );
  assert.equal(seen.assetId, "fern-shelter");
  assert.ok(listed.includes(seen.media));
  assert.ok(!listed.some((p) => p === ".git" || p.startsWith(".git/")));
  assert.deepEqual(await seen.list("../"), []);
  assert.deepEqual(await seen.list("missing"), []);
  assert.equal(
    seen.revision,
    execFileSync("git", ["-C", world.targetDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  );
  assert.deepEqual(roundTrip, { n: 1 });
  assert.deepEqual(await listing(world.targetDir), before);
});

test("a usage that throws is an advisory and the request still builds", async () => {
  const { args } = await replacement();
  const registry = fakeRegistry(async () => {
    throw new Error("cannot scan");
  });
  const plain = await pickRequest(args);
  const request = await pickRequest(args, { registry, stateDir });
  assert.equal(request.id, plain.id);
  assert.deepEqual((request.details as Record<string, unknown>)["usage"], [
    { preset: "fake:usage", error: "cannot scan" },
  ]);
  assert.match(request.summary, /; usage unknown \(fake:usage\): cannot scan/);
});

test("a state directory inside the target is never written, and reads outside it are refused", async () => {
  const { world } = await replacement();
  const inside = join(world.targetDir, "state");
  let cacheGet: unknown = "unset";
  let refused = "";
  const registry = fakeRegistry(async (ctx) => {
    await ctx.cache.set("k", 1);
    cacheGet = await ctx.cache.get("k");
    return { asset: { path: "x" }, references: [] };
  });
  registry.presets.get("fake:usage")!.usage = async (ctx, _o, read) => {
    await ctx.cache.set("k", 1);
    cacheGet = await ctx.cache.get("k");
    await read(".git/config").catch((e: Error) => (refused = e.message));
    return { asset: { path: "x" }, references: [] };
  };
  const before = await listing(world.targetDir);
  const media = join(world.targetDir, "assets/source/fern/shelter.png");
  const out = await replacementUsage({
    profile: { ...world.profile, handoff: HANDOFF } as never,
    assetId: "fern-shelter",
    media,
    targetDir: world.targetDir,
    registry,
    stateDir: inside,
  });
  assert.equal(out[0]?.report?.references.length, 0);
  assert.equal(cacheGet, undefined);
  assert.match(refused, /\.git/);
  assert.deepEqual(await listing(world.targetDir), before);
  assert.deepEqual(
    await replacementUsage({
      profile: { ...world.profile, handoff: HANDOFF } as never,
      assetId: "fern-shelter",
      media: join(world.dir, "elsewhere.png"),
      targetDir: world.targetDir,
      registry,
      stateDir,
    }),
    [],
  );
});
