import { approve, approveScript, settingsPath, stateDir, useHeadless } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  identifyCommand,
  providerScriptCommand,
  refuseShims,
  requireApproval,
} from "../src/approvals.ts";
import type { GatedCommand } from "../src/approvals.ts";
import { confirmCommand } from "../src/commands/confirm.ts";
import { runCommand } from "../src/commands/runner.ts";
import type { TtyPort } from "../src/confirm/prompt.ts";
import { loadSettings } from "../src/settings.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approveScript(passingScript);

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Result> {
  return new Promise((resolve) => {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = (result: Result): Record<string, any> => JSON.parse(result.stdout);

/** A synthetic world with one staged candidate, ready to pick. */
async function stagedWorld() {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  const base = ["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir];
  const staged = await cli([
    "stage",
    ...base,
    "--candidates",
    "1",
    "--provider-script",
    passingScript,
    "--json",
  ]);
  assert.equal(staged.code, 0, staged.stderr);
  await mkdir(world.targetDir, { recursive: true });
  const pick = (env?: NodeJS.ProcessEnv) =>
    cli(
      [
        "pick",
        "--run",
        doc(staged)["runDir"],
        "--candidate",
        "c1",
        "--target",
        world.targetDir,
        "--json",
      ],
      env,
    );
  return { world, pick };
}

async function checkout(dir: string, tool: string): Promise<string> {
  await mkdir(join(dir, ".git"), { recursive: true });
  await mkdir(join(dir, "assets", "tools"), { recursive: true });
  await writeFile(join(dir, "assets", "tools", "check.mjs"), tool);
  return join(dir, "assets");
}

test("the command hash is equal across checkouts and changes with argv, file bytes and kind", async () => {
  const base = await mkdtemp(join(tmpdir(), "assetgrove-approvals-"));
  const a = await checkout(join(base, "one"), "process.exit(0);\n");
  const b = await checkout(join(base, "elsewhere", "two"), "process.exit(0);\n");
  const argv = ["node", "tools/check.mjs", "{{manifest}}"];
  const command = (cwd: string, over: Partial<GatedCommand> = {}): GatedCommand => ({
    kind: "validator",
    argv,
    cwd,
    ...over,
  });
  const first = identifyCommand(command(a));
  assert.equal(first.cwd, "assets");
  assert.deepEqual(
    first.files.map((f) => f.path),
    ["tools/check.mjs"],
  );
  assert.equal(identifyCommand(command(b)).hash, first.hash);
  assert.notEqual(
    identifyCommand(command(a, { argv: [...argv, "--strict"] })).hash,
    first.hash,
    "argv",
  );
  assert.notEqual(identifyCommand(command(a, { kind: "material-preview" })).hash, first.hash);
  await writeFile(join(b, "tools", "check.mjs"), "process.exit(1);\n");
  assert.notEqual(identifyCommand(command(b)).hash, first.hash, "a named file's bytes");
  // The provider-script module is named from its own Git top level, whatever the cwd.
  await writeFile(join(a, "script.mjs"), "export default {};\n");
  await writeFile(join(b, "script.mjs"), "export default {};\n");
  const script = identifyCommand(providerScriptCommand(join(a, "script.mjs")));
  assert.deepEqual(script.argv, ["assets/script.mjs"]);
  assert.equal(identifyCommand(providerScriptCommand(join(b, "script.mjs"))).hash, script.hash);
});

test("pick with an unapproved validator exits 8 and writes nothing; approved in settings it runs", async () => {
  const { world, pick } = await stagedWorld();
  const refused = await pick();
  assert.equal(refused.code, 8, refused.stderr);
  const error = doc(refused)["error"];
  assert.equal(error.code, "confirmation_required");
  const confirmation = error.confirmation;
  assert.equal(confirmation.kind, "command");
  assert.equal(confirmation.command.kind, "validator");
  assert.match(confirmation.command.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(confirmation.command.argv, world.profile.validator!.command);
  // The target lies outside any repository, so cwd is its absolute real path; the validator
  // script lies outside cwd, so no file is hashed.
  assert.equal(confirmation.command.cwd, realpathSync(world.targetDir));
  assert.deepEqual(confirmation.command.files, []);
  assert.equal(confirmation.id, confirmation.command.hash);
  assert.equal(confirmation.confirmCommand, `assetgrove confirm ${confirmation.id}`);
  assert.deepEqual(await readdir(world.targetDir), []);
  assert.ok(existsSync(join(stateDir, "pending", `${confirmation.id}.json`)));

  const hash = approve({
    kind: "validator",
    argv: world.profile.validator!.command,
    cwd: world.targetDir,
  });
  assert.equal(hash, confirmation.id);
  const picked = await pick();
  assert.equal(picked.code, 0, picked.stderr);
  const d = doc(picked);
  assert.equal(d["validator"].accepted, true, d["validator"].output);
  assert.equal(d["validator"].hash, hash);
  assert.equal(d["validator"].method, "settings");
  // This profile embeds the provenance in the manifest.
  const manifest = JSON.parse(await readFile(d["manifestPath"], "utf8"));
  const provenance = manifest.provenance.generated;
  assert.deepEqual(
    provenance.commands.map((c: { kind: string; hash: string; method: string }) => [
      c.kind,
      c.hash,
      c.method,
    ]),
    [["validator", hash, "settings"]],
  );
});

test("--provider-script without an approval exits 8; headless ignores an approval file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-script-"));
  const script = join(dir, "script.mjs");
  await writeFile(
    script,
    `export default { image() { throw new Error("unexpected call"); }, vision() { return { text: "" }; } };\n`,
  );
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  const args = ["stage", "--spec", spec, "--bible", bible, "--profile", profile];
  const run = () =>
    cli([...args, "--runs", world.runsDir, "--provider-script", script, "--dry-run", "--json"]);

  const refused = await run();
  assert.equal(refused.code, 8, refused.stderr);
  assert.equal(doc(refused)["error"].code, "confirmation_required");
  const { confirmation } = doc(refused)["error"];
  assert.equal(confirmation.command.kind, "provider-script");

  // `assetgrove confirm <hex>` approves the saved request on a terminal (an injected port here)...
  const ctx = { settings: loadSettings(), log: () => {} };
  const noTerminal = await runCommand(confirmCommand, { id: confirmation.id }, ctx);
  assert.equal(noTerminal.exitCode, 2);
  const yes: TtyPort = { interactive: true, ask: () => Promise.resolve(true) };
  const confirmed = await runCommand(confirmCommand, { id: confirmation.id }, { ...ctx, tty: yes });
  assert.equal(confirmed.exitCode, 0, confirmed.error?.message);
  const record = JSON.parse(await readFile(confirmed.fields["approvalPath"] as string, "utf8"));
  assert.equal(record.method, "terminal");
  assert.equal(record.hash, identifyCommand(providerScriptCommand(script)).hash);

  // ...and the approval file approves it when attended...
  const attended = await run();
  assert.equal(attended.code, 0, attended.stderr);
  // ...but headless runs only commands listed in settings.
  useHeadless();
  const headless = await run();
  assert.equal(headless.code, 8, headless.stderr);
  assert.equal(doc(headless)["error"].code, "confirmation_required");
  assert.match(doc(headless)["error"].message, /headless/);
});

test("accepting through an injected TTY port writes configDir/approvals/<hex>.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-tty-"));
  const settings = loadSettings();
  assert.equal(settings.configDir, dirname(settingsPath));
  const asked: string[] = [];
  const port = (answer: boolean): TtyPort => ({
    interactive: true,
    ask: (text) => {
      asked.push(text);
      return Promise.resolve(answer);
    },
  });
  const command: GatedCommand = { kind: "validator", argv: ["node", "check.mjs"], cwd: dir };
  await assert.rejects(requireApproval(command, { settings, tty: port(false) }), {
    code: "confirmation_declined",
  });
  const approved = await requireApproval(command, { settings, tty: port(true) });
  assert.equal(approved.method, "tty");
  assert.match(asked[0]!, /argv: \["node","check.mjs"\]/);
  const file = join(settings.configDir, "approvals", `${approved.command.hash}.json`);
  const record = JSON.parse(await readFile(file, "utf8"));
  assert.equal(record.hash, approved.command.hash);
  assert.equal(record.method, "tty");
  // The approval holds for the next run, which asks no one.
  const again = await requireApproval(command, { settings });
  assert.equal(again.method, "tty");
  assert.equal(asked.length, 2);
});

test("a relative shim name resolves against the command's cwd, not the process's", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-shim-cwd-"));
  await mkdir(join(dir, "tools"));
  await writeFile(join(dir, "tools", "check.cmd"), "@echo off\r\n");
  for (const name of ["tools/check.cmd", "tools/check"]) {
    assert.throws(
      () => refuseShims([name, "{{manifest}}"], dir, "win32", { PATHEXT: ".EXE;.CMD" }),
      (error: Error & { code?: string }) => error.code === "command_refused",
      name,
    );
  }
  assert.equal(refuseShims(["tools/check.cmd"], dir, "linux", {}), undefined);
});

test(
  "a command resolving to a .cmd file exits 2 command_refused",
  { skip: process.platform !== "win32" && "Windows only" },
  async () => {
    const { world, pick } = await stagedWorld();
    const bin = await mkdtemp(join(tmpdir(), "assetgrove-shim-"));
    await writeFile(join(bin, "check-assets.cmd"), "@echo off\r\nexit /b 0\r\n");
    // The staged run carries its own profile: name the shim as its validator.
    const runs = await readdir(world.runsDir);
    const runFile = join(world.runsDir, runs[0]!, "run.json");
    const record = JSON.parse(await readFile(runFile, "utf8"));
    record.profile.validator = { command: ["check-assets", "{{manifest}}"] };
    await writeFile(runFile, JSON.stringify(record));
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const refused = await pick({
      ...process.env,
      [pathKey]: `${bin};${process.env[pathKey] ?? ""}`,
    });
    assert.equal(refused.code, 2, refused.stderr);
    assert.equal(doc(refused)["error"].code, "command_refused");
    assert.match(doc(refused)["error"].message, /node <script>/);
    assert.deepEqual(await readdir(world.targetDir), []);
  },
);
