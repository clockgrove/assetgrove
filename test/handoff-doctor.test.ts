/**
 * The doctor report (issue #483): a preset's read-only `doctor` hook, the context core gives it
 * (`tracked`, `lfs`, the guarded read), the merge of presets' findings and the `doctor` command.
 */
import "./fixtures/env.ts";
import { settingsPath, stateDir } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { doctorCommand } from "../src/commands/doctor.ts";
import type { RunContext } from "../src/commands/types.ts";
import { projectDoctor } from "../src/handoff/doctor.ts";
import { PRESETS } from "../src/handoff/presets/index.ts";
import type {
  DoctorContext,
  DoctorFinding,
  HandoffPreset,
  PresetRegistry,
  TargetRead,
} from "../src/handoff/presets/index.ts";
import { BLOCK, withBlock } from "../src/gitlfs.ts";
import { syntheticProfile } from "./fixtures/synthetic.ts";
import { bareGitTarget } from "./fixtures/git.ts";

const configDir = dirname(settingsPath);
const root = fileURLToPath(new URL("..", import.meta.url));

type Doctor = (ctx: DoctorContext, read: TargetRead) => Promise<DoctorFinding[]>;

function fake(name: string, doctor: Doctor): HandoffPreset {
  return {
    name,
    optionsSchema: z.object({}).passthrough(),
    write: async () => [],
    check: async () => [],
    doctor: async (ctx, _options, read) => doctor(ctx, read),
  };
}

function registryOf(...presets: HandoffPreset[]): PresetRegistry {
  return { presets: new Map([...PRESETS, ...presets.map((p) => [p.name, p] as const)]) };
}

const profileOf = (...names: string[]) =>
  syntheticProfile({ handoff: [{ preset: "manifest" }, ...names.map((preset) => ({ preset }))] });

async function gitProject(): Promise<string> {
  const dir = bareGitTarget(await realpath(await mkdtemp(join(tmpdir(), "assetgrove-doctor-"))));
  await mkdir(join(dir, "game/.godot"), { recursive: true });
  await mkdir(join(dir, "art"), { recursive: true });
  await writeFile(join(dir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(join(dir, "game/.godot/cache.bin"), "cache");
  await writeFile(join(dir, "game/main.tscn"), "scene");
  await writeFile(join(dir, "art/a.png"), "png");
  execFileSync("git", [
    "-C",
    dir,
    "add",
    ".gitattributes",
    "game/.godot/cache.bin",
    "game/main.tscn",
  ]);
  await writeFile(join(dir, "game/untracked.tscn"), "x");
  return dir;
}

async function hashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else
        out[relative(dir, full)] = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
    }
  };
  await walk(dir);
  return out;
}

const run = (target: string, registry: PresetRegistry, names: string[]) =>
  projectDoctor({ profile: profileOf(...names), targetDir: target, registry, stateDir, configDir });

test("tracked lists the files Git tracks under a folder, not untracked ones", async () => {
  const dir = await gitProject();
  let all: string[] = [];
  let sub: string[] = [];
  let outside: string[] = [];
  let inGit: string[] = [];
  const registry = registryOf(
    fake("fake:a", async (ctx) => {
      all = await ctx.tracked("");
      sub = await ctx.tracked("game/.godot");
      outside = await ctx.tracked("..");
      inGit = await ctx.tracked(".git");
      return [];
    }),
  );
  await run(dir, registry, ["fake:a"]);
  assert.deepEqual(all, [".gitattributes", "game/.godot/cache.bin", "game/main.tscn"]);
  assert.deepEqual(sub, ["game/.godot/cache.bin"]);
  assert.deepEqual(outside, []);
  assert.deepEqual(inGit, []);
});

test("tracked and lfs are empty outside Git", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "assetgrove-doctor-")));
  await writeFile(join(dir, "a.png"), "x");
  await writeFile(join(dir, ".gitattributes"), "*.png filter=lfs\n");
  let seen: [string[], string[]] = [["?"], ["?"]];
  await run(
    dir,
    registryOf(
      fake("fake:a", async (ctx) => {
        seen = [await ctx.tracked(""), await ctx.lfs(["a.png"])];
        return [];
      }),
    ),
    ["fake:a"],
  );
  assert.deepEqual(seen, [[], []]);
});

test("lfs reports the paths .gitattributes routes to LFS, existing or not", async () => {
  const dir = await gitProject();
  let routed: string[] = [];
  await run(
    dir,
    registryOf(
      fake("fake:a", async (ctx) => {
        routed = await ctx.lfs(["art/a.png", "art/missing.png", "game/main.tscn", "../x.png"]);
        return [];
      }),
    ),
    ["fake:a"],
  );
  assert.deepEqual(routed, ["art/a.png", "art/missing.png"]);
});

test("identical findings of two presets merge with both names; the rest sort by path, line, code", async () => {
  const dir = await gitProject();
  const same: DoctorFinding = {
    code: "orphan-uid",
    path: "b.tscn",
    line: 2,
    problem: "p",
    correction: "c",
  };
  const registry = registryOf(
    fake("fake:a", async () => [
      same,
      { code: "z", path: "a.tscn", problem: "p", correction: "c" },
      { code: "a", path: "b.tscn", line: 1, problem: "p", correction: "c" },
    ]),
    fake("fake:b", async () => [same, { ...same, correction: "other" }]),
  );
  const { findings, errors } = await run(dir, registry, ["fake:a", "fake:b"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    findings.map((f) => [f.path, f.line, f.code, f.correction, f.presets]),
    [
      ["a.tscn", undefined, "z", "c", ["fake:a"]],
      ["b.tscn", 1, "a", "c", ["fake:a"]],
      ["b.tscn", 2, "orphan-uid", "c", ["fake:a", "fake:b"]],
      ["b.tscn", 2, "orphan-uid", "other", ["fake:b"]],
    ],
  );
});

test("a throwing doctor is an error entry and the others still report", async () => {
  const dir = await gitProject();
  const registry = registryOf(
    fake("fake:bad", async () => {
      throw new Error("boom");
    }),
    fake("fake:ok", async () => [{ code: "c", path: "p", problem: "x", correction: "y" }]),
  );
  const { findings, errors } = await run(dir, registry, ["fake:bad", "fake:ok"]);
  assert.deepEqual(errors, [{ preset: "fake:bad", error: "boom" }]);
  assert.equal(findings.length, 1);
});

test("the guarded read refuses .git, a path outside the target and the settings", async () => {
  const dir = await gitProject();
  const refused: string[] = [];
  const registry = registryOf(
    fake("fake:a", async (_ctx, read) => {
      for (const path of [".git/config", "../x", join("..", "y")]) {
        await read(path).catch((error: Error) => refused.push(error.message));
      }
      assert.deepEqual(await read("game/main.tscn"), new TextEncoder().encode("scene"));
      return [];
    }),
  );
  const { errors } = await run(dir, registry, ["fake:a"]);
  assert.deepEqual(errors, []);
  assert.equal(refused.length, 3);
  assert.match(refused[0]!, /in \.git/);
});

test("the doctor command prints each finding and leaves the target, .git included, unchanged", async () => {
  const dir = await gitProject();
  const registry = registryOf(
    fake("fake:a", async (ctx) => [
      ...(await ctx.tracked("game/.godot")).map((path) => ({
        code: "tracked-cache",
        path,
        problem: "Git tracks an engine cache",
        correction: "git rm --cached -r game/.godot and ignore it",
      })),
    ]),
  );
  const profile = join(dir, "..", `doctor-profile-${process.pid}.json`);
  await writeFile(profile, JSON.stringify(profileOf("fake:a")));
  const before = await hashes(dir);
  const result = await doctorCommand.run({ profile, target: dir }, {
    extensions: registry,
    settings: { stateDir, configDir },
  } as unknown as RunContext);
  assert.equal(result.exitCode, 0);
  assert.match(
    result.human!,
    /^game\/\.godot\/cache\.bin {2}tracked-cache\n {2}problem: Git tracks an engine cache\n {2}correction: git rm/,
  );
  assert.deepEqual(await hashes(dir), before);
});

test("assetgrove doctor through the CLI exits 0, says no findings for a healthy project and changes nothing", async () => {
  const dir = await gitProject();
  const profile = join(dir, "..", `doctor-cli-profile-${process.pid}.json`);
  await writeFile(profile, JSON.stringify(syntheticProfile()));
  const before = await hashes(dir);
  const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", "doctor", "--profile", profile, "--target", dir, "--json"],
      { cwd: root },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const doc = JSON.parse(r.stdout) as { findings: unknown[]; errors: unknown[] };
  assert.deepEqual([doc.findings, doc.errors], [[], []]);
  assert.deepEqual(await hashes(dir), before);
});

const OLD_BLOCK = `${[
  "# BEGIN assetgrove (managed block: edits inside are replaced)",
  ...["png", "jpg", "jpeg", "webp", "gif", "glb", "ktx2"].map(
    (ext) => `*.${ext} filter=lfs diff=lfs merge=lfs -text`,
  ),
  "# END assetgrove",
].join("\n")}\n`;

async function libraryTarget(attributes: string): Promise<string> {
  const dir = bareGitTarget(await realpath(await mkdtemp(join(tmpdir(), "assetgrove-doctor-"))));
  await mkdir(join(dir, "assets/source"), { recursive: true });
  await writeFile(join(dir, "assets/source/.gitattributes"), attributes);
  return dir;
}

test("an old managed block without the audio rules is one lfs-rules-outdated finding", async () => {
  const dir = await libraryTarget(OLD_BLOCK);
  const before = await hashes(dir);
  const { findings } = await run(dir, registryOf(), []);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.code, "lfs-rules-outdated");
  assert.equal(findings[0]!.path, "assets/source/.gitattributes");
  assert.deepEqual(findings[0]!.presets, ["core"]);
  assert.match(findings[0]!.problem, /\.wav, \.ogg files/);
  assert.deepEqual(await hashes(dir), before);
});

test("the current managed block, no block and a target outside Git give no lfs finding", async () => {
  assert.deepEqual((await run(await libraryTarget(BLOCK), registryOf(), [])).findings, []);
  assert.deepEqual(
    (await run(await libraryTarget("*.png binary\n"), registryOf(), [])).findings,
    [],
  );
  const plain = await realpath(await mkdtemp(join(tmpdir(), "assetgrove-doctor-")));
  await mkdir(join(plain, "assets/source"), { recursive: true });
  await writeFile(join(plain, "assets/source/.gitattributes"), OLD_BLOCK);
  assert.deepEqual((await run(plain, registryOf(), [])).findings, []);
});

test("the finding is gone once init's block update runs", async () => {
  const dir = await libraryTarget(OLD_BLOCK);
  assert.equal((await run(dir, registryOf(), [])).findings.length, 1);
  await writeFile(join(dir, "assets/source/.gitattributes"), withBlock(OLD_BLOCK));
  assert.deepEqual((await run(dir, registryOf(), [])).findings, []);
});
