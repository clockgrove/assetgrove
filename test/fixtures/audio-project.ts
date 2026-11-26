/**
 * A target project for audio CLI tests (#481): a temporary Git repository with a library, an audio
 * profile and a style bible, the scripted audio provider (test/fixtures/audio-script.ts), and
 * helpers that stage a spec and pick its candidate through the CLI, a person confirming at the
 * terminal. Synthetic only: no key, no recorded audio.
 */
import { approve } from "./env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirmCommand } from "../../src/commands/confirm.ts";
import { runCommand } from "../../src/commands/runner.ts";
import type { ConfirmPort } from "../../src/confirm/prompt.ts";
import { loadSettings } from "../../src/settings.ts";
import { gitTarget } from "./git.ts";
import { syntheticWorld, writeStyleBible } from "./synthetic.ts";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const AUDIO_SCRIPT = fileURLToPath(new URL("./audio-script.ts", import.meta.url));
approve(AUDIO_SCRIPT);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any>;

export interface CliResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export const LOUDNESS = { target: -23, tolerance: 1, truePeakCeiling: -1, encoderHeadroom: 1 };

/** Runs the CLI in `cwd` without a gateway key. */
export function cli(args: string[], cwd = ROOT): Promise<CliResult> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      [join(ROOT, "src/cli.ts"), ...args],
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

export const doc = (r: CliResult): Doc => JSON.parse(r.stdout) as Doc;

/** A person at the terminal who confirms whatever they are asked. */
export const person: ConfirmPort = {
  method: "tty",
  confirm: async () => true,
  choose: async (r) => r.choices?.[0],
};

/** Confirms a pending request by its id, as `assetgrove confirm <id>` at the terminal. */
export async function confirm(id: string): Promise<void> {
  const done = await runCommand(
    confirmCommand,
    { id },
    { settings: loadSettings(), log: () => {}, prompt: person },
  );
  assert.equal(done.exitCode, 0, done.error?.message);
}

export interface AudioProject {
  dir: string;
  target: string;
  profilePath: string;
  bible: string;
  runs: string;
  /** Writes `spec` beside the profile; returns its path. */
  spec(spec: Record<string, unknown>): Promise<string>;
}

/** Temporary directories the tests made; remove them with `cleanAudioProjects` in `after`. */
const temporary: string[] = [];

export async function cleanAudioProjects(): Promise<void> {
  await Promise.all(temporary.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

/** A target repository with a library, an audio profile (with `audio`) and a style bible. */
export async function audioProject(audio: Record<string, unknown> = {}): Promise<AudioProject> {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const target = realpathSync(gitTarget(world.targetDir));
  const profile = {
    ...world.profile,
    audio: { loudness: LOUDNESS, ...audio },
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
  return {
    dir: world.dir,
    target,
    profilePath,
    bible,
    runs: world.runsDir,
    async spec(spec) {
      const path = join(world.dir, `${spec["assetId"] as string}.spec.json`);
      await writeFile(path, JSON.stringify(spec));
      return path;
    },
  };
}

/** Stages `specPath` with one candidate on the scripted audio provider; the person confirms the spend. */
export async function stageAudio(p: AudioProject, specPath: string): Promise<Doc> {
  const args = [
    ...["stage", "--spec", specPath, "--bible", p.bible, "--profile", p.profilePath],
    ...["--runs", p.runs, "--candidates", "1", "--provider-script", AUDIO_SCRIPT, "--json"],
  ];
  const asked = await cli(args);
  assert.equal(asked.code, 8, asked.stdout + asked.stderr);
  await confirm(doc(asked)["error"].confirmation.id as string);
  const staged = await cli(args);
  assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  return doc(staged);
}

/** Picks `c1` of a staged run into the target; the person confirms the pick. */
export async function pickAudio(p: AudioProject, runDir: string): Promise<Doc> {
  const pick = ["pick", "--run", runDir, "--candidate", "c1", "--target", p.target, "--json"];
  const asked = await cli(pick, p.target);
  assert.equal(asked.code, 8, asked.stdout + asked.stderr);
  await confirm(doc(asked)["error"].confirmation.id as string);
  const picked = await cli(pick, p.target);
  assert.equal(picked.code, 0, picked.stdout + picked.stderr);
  return doc(picked);
}

/** Stages and picks `spec` into the library; returns the stage and pick JSON. */
export async function pickedAudio(
  p: AudioProject,
  spec: Record<string, unknown>,
): Promise<{ staged: Doc; picked: Doc }> {
  const staged = await stageAudio(p, await p.spec(spec));
  const picked = await pickAudio(p, staged["runDir"] as string);
  return { staged, picked };
}
