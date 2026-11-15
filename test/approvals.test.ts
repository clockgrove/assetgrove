import "./fixtures/env.ts";
import { approve, approveCommand, approvalsDir, stateDir, useHeadless } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  commandIdentity,
  requireApproval,
  scriptIdentity,
  type CommandIdentity,
} from "../src/approvals.ts";
import { confirmCommand } from "../src/commands/confirm.ts";
import { runCommand } from "../src/commands/runner.ts";
import type { ConfirmPort, ConfirmRequest } from "../src/confirm/prompt.ts";
import { loadSettings } from "../src/settings.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(passingScript);

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
function doc(result: Result): Record<string, any> {
  return JSON.parse(result.stdout);
}

/** A synthetic world whose profile names `validator`, and one staged candidate to pick. */
async function stagedWorld(validator: string[]) {
  const world = await syntheticWorld();
  world.profile.validator = { command: validator };
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
  const pick = () =>
    cli([
      "pick",
      "--run",
      doc(staged)["runDir"],
      "--candidate",
      "c1",
      "--target",
      world.targetDir,
      "--json",
    ]);
  return { world, base, pick };
}

/** One repository's files under `top`, with a `.git` directory marking its top level. */
async function checkout(top: string, tool: string): Promise<string> {
  await mkdir(join(top, ".git"), { recursive: true });
  await mkdir(join(top, "tools"), { recursive: true });
  await writeFile(join(top, "tools", "check.mjs"), tool);
  return top;
}

test("the hash is equal for one repository at two paths, and changes with argv, a file's bytes or the kind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-approvals-"));
  const a = await checkout(join(dir, "first", "game"), "process.exit(0);\n");
  const b = await checkout(join(dir, "second", "elsewhere", "game-copy"), "process.exit(0);\n");
  const argv = ["node", "tools/check.mjs", "{{manifest}}"];
  const first = commandIdentity("validator", argv, a);
  const second = commandIdentity("validator", argv, b);
  assert.equal(first.hash, second.hash);
  assert.equal(first.cwd, ".");
  assert.deepEqual(Object.keys(first.files), ["tools/check.mjs"]);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  // A subdirectory of the repository is named relative to its top level.
  assert.equal(commandIdentity("validator", ["node"], join(a, "tools")).cwd, "tools");

  assert.notEqual(commandIdentity("validator", [...argv, "--strict"], a).hash, first.hash);
  assert.notEqual(commandIdentity("material-preview", argv, a).hash, first.hash);
  await writeFile(join(a, "tools", "check.mjs"), "process.exit(1);\n");
  assert.notEqual(commandIdentity("validator", argv, a).hash, first.hash);
  assert.equal(commandIdentity("validator", argv, b).hash, first.hash);

  // Outside a repository the cwd is absolute, so the same command elsewhere is another command.
  const loose = await mkdtemp(join(tmpdir(), "assetgrove-loose-"));
  const outside = commandIdentity("validator", ["node"], loose);
  assert.ok(outside.cwd.startsWith("/") || /^[A-Za-z]:\//.test(outside.cwd), outside.cwd);
  assert.equal(outside.cwd.includes("\\"), false);

  // A provider script's identity follows its bytes and its place in its repository.
  await writeFile(join(a, "tools", "script.mjs"), "export default {};\n");
  await writeFile(join(b, "tools", "script.mjs"), "export default {};\n");
  assert.equal(
    scriptIdentity(join(a, "tools", "script.mjs")).hash,
    scriptIdentity(join(b, "tools", "script.mjs")).hash,
  );
  await writeFile(join(b, "tools", "script.mjs"), "export default { changed: true };\n");
  assert.notEqual(
    scriptIdentity(join(a, "tools", "script.mjs")).hash,
    scriptIdentity(join(b, "tools", "script.mjs")).hash,
  );
});

test("pick with an unapproved validator exits 8 carrying the command; approved in settings it runs and provenance records method settings", async () => {
  const validator = [process.execPath, "-e", "process.exit(0)", "{{manifest}}"];
  const { world, pick } = await stagedWorld(validator);
  const refused = await pick();
  assert.equal(refused.code, 8, refused.stderr);
  const d = doc(refused);
  assert.equal(d["error"].code, "confirmation_required");
  const confirmation = d["error"].confirmation;
  const expected = commandIdentity("validator", validator, world.targetDir);
  assert.equal(confirmation.kind, "command");
  assert.equal(confirmation.id, expected.hash);
  assert.equal(confirmation.confirmCommand, `assetgrove confirm ${expected.hash}`);
  assert.deepEqual(confirmation.command, {
    kind: "validator",
    hash: expected.hash,
    argv: validator,
    cwd: expected.cwd,
    files: {},
  });
  // Nothing was written into the target, and the request waits for `assetgrove confirm`.
  assert.deepEqual(await readdir(world.targetDir), []);
  assert.ok(existsSync(join(stateDir, "pending", `${expected.hash}.json`)));

  approveCommand({ hash: expected.hash, kind: "validator", argv: validator });
  const picked = await pick();
  assert.equal(picked.code, 0, picked.stderr);
  const p = doc(picked);
  assert.equal(p["validator"].accepted, true);
  assert.deepEqual(p["validator"].approval, {
    kind: "validator",
    hash: expected.hash,
    method: "settings",
  });
  // The synthetic profile embeds the provenance record in the manifest.
  const manifest = JSON.parse(await readFile(p["manifestPath"], "utf8"));
  assert.deepEqual(manifest.provenance.generated.commands, [
    { kind: "validator", hash: expected.hash, method: "settings" },
  ]);
});

test("--provider-script without an approval exits 8; under headless settings only a settings approval counts", async () => {
  const world = await syntheticWorld();
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  // A copy of the passing script in another place is another command.
  const copy = join(world.dir, "unapproved-script.ts");
  await copyFile(passingScript, copy);
  await writeFile(copy, `${await readFile(copy, "utf8")}\n// a copy\n`);
  const args = (script: string) => [
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
    "--json",
  ];
  const refused = await cli(args(copy));
  assert.equal(refused.code, 8, refused.stderr);
  const d = doc(refused);
  assert.equal(d["error"].code, "confirmation_required");
  assert.equal(d["error"].confirmation.command.kind, "provider-script");
  assert.equal(d["error"].confirmation.id, scriptIdentity(copy).hash);

  // Headless: an approval record (here the passing script's) is not enough.
  useHeadless();
  const headless = await cli(args(passingScript));
  assert.equal(headless.code, 8, headless.stderr);
  assert.equal(doc(headless)["error"].code, "confirmation_required");
  assert.match(doc(headless)["error"].message, /headless/);
  const identity = scriptIdentity(passingScript);
  approveCommand({ hash: identity.hash, kind: identity.kind, argv: identity.argv });
  const listed = await cli(args(passingScript));
  assert.equal(listed.code, 0, listed.stderr);
});

function port(answer: boolean, asked: ConfirmRequest[]): ConfirmPort {
  return {
    method: "tty",
    confirm: async (request) => {
      asked.push(request);
      return answer;
    },
  };
}

test("accepting through an injected TTY port writes configDir/approvals/<hex>.json; declining exits 8", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-tty-"));
  await writeFile(join(dir, "check.mjs"), "process.exit(0);\n");
  const identity: CommandIdentity = commandIdentity(
    "validator",
    ["node", "check.mjs", "{{manifest}}"],
    dir,
  );
  const settings = loadSettings();
  const asked: ConfirmRequest[] = [];
  await assert.rejects(requireApproval(identity, { settings, prompt: port(false, asked) }), {
    code: "confirmation_declined",
  });
  const path = join(settings.configDir, "approvals", `${identity.hash}.json`);
  assert.equal(path, join(approvalsDir, `${identity.hash}.json`));
  assert.equal(existsSync(path), false);

  const step = await requireApproval(identity, { settings, prompt: port(true, asked) });
  assert.deepEqual(step, { kind: "validator", hash: identity.hash, method: "tty" });
  assert.equal(asked.length, 2);
  assert.equal(asked[1]!.kind, "command");
  assert.deepEqual(asked[1]!.details["argv"], identity.argv);
  assert.deepEqual(asked[1]!.details["files"], identity.files);
  const record = JSON.parse(await readFile(path, "utf8"));
  assert.equal(record.hash, identity.hash);
  assert.equal(record.method, "tty");
  // The record answers next time without asking.
  const again = await requireApproval(identity, { settings, prompt: port(false, asked) });
  assert.equal(again.method, "tty");
  assert.equal(asked.length, 2);
});

test("confirm <hex> approves a pending request at a terminal and exits 2 without one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-confirm-"));
  const identity = commandIdentity("material-preview", ["node", "render.mjs"], dir);
  const settings = loadSettings();
  await assert.rejects(requireApproval(identity, { settings }), {
    code: "confirmation_required",
  });
  const ctx = { settings, log: () => {} };
  const noTty = await runCommand(confirmCommand, { id: identity.hash }, ctx);
  assert.equal(noTty.exitCode, 2);
  const cli2 = await cli(["confirm", identity.hash, "--json"]);
  assert.equal(cli2.code, 2, cli2.stderr);

  const asked: ConfirmRequest[] = [];
  const ok = await runCommand(
    confirmCommand,
    { id: identity.hash },
    { ...ctx, prompt: port(true, asked) },
  );
  assert.equal(ok.exitCode, 0, ok.error?.message);
  assert.equal(asked[0]!.id, identity.hash);
  assert.deepEqual(await requireApproval(identity, { settings }), {
    kind: "material-preview",
    hash: identity.hash,
    method: "terminal",
  });
  assert.equal(existsSync(join(stateDir, "pending", `${identity.hash}.json`)), false);
  const gone = await runCommand(
    confirmCommand,
    { id: identity.hash },
    { ...ctx, prompt: port(true, asked) },
  );
  assert.equal(gone.exitCode, 2);
});

test("confirm <hex> refuses a pending request whose command does not hash to its id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-confirm-tampered-"));
  const identity = commandIdentity("material-preview", ["node", "tampered.mjs"], dir);
  const settings = loadSettings();
  await assert.rejects(requireApproval(identity, { settings }), {
    code: "confirmation_required",
  });
  const path = join(stateDir, "pending", `${identity.hash}.json`);
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved.details.argv = ["node", "other.mjs"];
  await writeFile(path, JSON.stringify(saved));
  const asked: ConfirmRequest[] = [];
  const ctx = { settings, log: () => {}, prompt: port(true, asked) };
  const edited = await runCommand(confirmCommand, { id: identity.hash }, ctx);
  assert.equal(edited.exitCode, 2);
  assert.equal(asked.length, 0);
  saved.details = "not a command";
  await writeFile(path, JSON.stringify(saved));
  const malformed = await runCommand(confirmCommand, { id: identity.hash }, ctx);
  assert.equal(malformed.exitCode, 2);
  assert.equal(asked.length, 0);
  assert.equal(existsSync(join(settings.configDir, "approvals", `${identity.hash}.json`)), false);
});

test(
  "on Windows a validator resolving to a .cmd file exits 2 command_refused",
  { skip: process.platform !== "win32" && "win32 only" },
  async () => {
    const bin = await mkdtemp(join(tmpdir(), "assetgrove-shim-"));
    await writeFile(join(bin, "shimtool.cmd"), "@echo off\r\nexit /b 0\r\n");
    const validator = ["shimtool", "{{manifest}}"];
    const { world, pick } = await stagedWorld(validator);
    approve({ kind: "validator", argv: validator, cwd: world.targetDir });
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    process.env[pathKey] = `${bin};${process.env[pathKey] ?? ""}`;
    const r = await pick();
    assert.equal(r.code, 2, r.stderr);
    assert.equal(doc(r)["error"].code, "command_refused");
    assert.match(doc(r)["error"].message, /node/);
    assert.deepEqual(await readdir(world.targetDir), []);
  },
);
