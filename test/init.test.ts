import { resetSettings, settingsPath, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { routeDataFlows } from "../src/dataflows.ts";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { HARNESSES, keyRecipe } from "../src/keys.ts";
import { searchSteps } from "../src/init.ts";
import { loadSettings } from "../src/settings.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const temporary: string[] = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

// Built at run time, so this tracked file never holds an assignment.
const OPENAI = ["OPENAI", "API", "KEY"].join("_");
const GATEWAY = ["AI", "GATEWAY", "API", "KEY"].join("_");
const KEY_VALUE = `agk-test-${"fedcba9876543210"}-synthetic-init`;

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-init-")));
  temporary.push(dir);
  return dir;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
  json: InitJson;
}

/** The parsed --json output. */
interface InitJson {
  files: Array<{ path: string; role: string; status: string }>;
  steps: Array<{ id: string; status: string; tool?: string; detail: string }>;
  providers: unknown;
  conflicts: string[];
  error: { code: string };
}

function cli(args: string[], extra: Record<string, string> = {}, cwd?: string): Promise<Result> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [GATEWAY, OPENAI, ...REFUSED_VARIABLES]) delete env[name];
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args],
      { env: { ...env, ...extra }, ...(cwd && { cwd }) },
      (error, stdout, stderr) => {
        let json: InitJson;
        try {
          json = JSON.parse(stdout) as InitJson;
        } catch {
          json = undefined as unknown as InitJson;
        }
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr, json });
      },
    );
    child.stdin?.end();
  });
}

function initArgs(dir: string, world = "Synthetic world", more: string[] = []): string[] {
  return [
    "init",
    "--directory",
    dir,
    "--profile-preset",
    "sprite-32",
    "--style-preset",
    "cozy-storybook",
    "--world",
    world,
    ...more,
    "--json",
  ];
}

/** Every file under `dir` (not `.git`) with its content and mtime. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const info = await stat(path);
        out[path] = `${info.mtimeMs}:${await readFile(path, "utf8")}`;
      }
    }
  }
  await walk(dir);
  return out;
}

async function repository(files: Record<string, string>): Promise<string> {
  const dir = tempDir();
  execFileSync("git", ["init", "-q", dir]);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

async function checkSkill(path: string): Promise<void> {
  const text = await readFile(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, `${path}: front matter`);
  const doc = parseDocument(match[1]!, { strict: true, uniqueKeys: true });
  assert.deepEqual(doc.errors, [], `${path}: strict YAML`);
  const data = doc.toJS() as { name?: unknown; description?: unknown };
  assert.equal(data.name, basename(dirname(path)), `${path}: name matches its folder`);
  assert.match(String(data.name), /^[a-z0-9-]{1,64}$/, `${path}: name characters`);
  assert.equal(typeof data.description, "string", `${path}: description`);
  assert.ok((data.description as string).length <= 1024, `${path}: description length`);
  assert.ok(text.split("\n").length < 500, `${path}: under 500 lines`);
}

test("a second run changes nothing and reports done", async () => {
  const dir = tempDir();
  const first = await cli(initArgs(dir));
  assert.equal(first.code, 0, first.stderr);
  assert.ok(first.json.files.every((f: { status: string }) => f.status !== "unchanged"));
  const before = await snapshot(dir);
  const second = await cli(initArgs(dir));
  assert.equal(second.code, 0, second.stderr);
  assert.ok(second.json.files.length > 0);
  assert.ok(second.json.files.every((f: { status: string }) => f.status === "unchanged"));
  assert.equal(second.json.steps.find((s) => s.id === "files")!.status, "done");
  assert.deepEqual(await snapshot(dir), before);
});

test("a differing file is refused without --overwrite and replaced with it", async () => {
  const dir = tempDir();
  assert.equal((await cli(initArgs(dir))).code, 0);
  const bible = join(dir, ".assetgrove", "art-direction", "BIBLE.md");
  await writeFile(bible, `${await readFile(bible, "utf8")}\nedited\n`);
  const edited = await snapshot(dir);
  const refused = await cli(initArgs(dir));
  assert.equal(refused.code, 2);
  assert.equal(refused.json.error.code, "invalid_input");
  assert.ok(refused.json.conflicts.includes(bible));
  assert.deepEqual(await snapshot(dir), edited);

  const another = await cli(initArgs(dir, "Another world"));
  assert.equal(another.code, 2);
  assert.ok(another.json.conflicts.includes(bible));
  assert.deepEqual(await snapshot(dir), edited);

  const replaced = await cli(initArgs(dir, "Another world", ["--overwrite"]));
  assert.equal(replaced.code, 0, replaced.stderr);
  const status = (role: string) => replaced.json.files.find((f) => f.role === role)!.status;
  assert.equal(status("bible"), "overwritten");
  assert.match(await readFile(bible, "utf8"), /Another world/);
});

test("a tracked key value refuses init with the guard step and writes nothing", async () => {
  const dir = await repository({ "notes.txt": `the key is ${KEY_VALUE}\n` });
  const before = await snapshot(dir);
  const result = await cli(initArgs(dir), { [OPENAI]: KEY_VALUE });
  assert.equal(result.code, 2);
  assert.equal(result.json.error.code, "key_tracked");
  assert.ok(
    result.json.steps.some(
      (s: { id: string; status: string }) => s.id === "guard" && s.status === "refused",
    ),
  );
  assert.ok(!result.stdout.includes(KEY_VALUE) && !result.stderr.includes(KEY_VALUE));
  assert.deepEqual(await snapshot(dir), before);
  assert.deepEqual(
    (await readdir(dir)).sort(),
    [".git", "notes.txt"].sort(),
    "no .assetgrove, no .gitignore",
  );
});

test("a tracked key-name assignment refuses init with an empty environment", async () => {
  const dir = await repository({ ".env": `${OPENAI}=sk-something\n` });
  const before = await snapshot(dir);
  const result = await cli(initArgs(dir));
  assert.equal(result.code, 2);
  assert.equal(result.json.error.code, "key_tracked");
  assert.ok(
    result.json.steps.some(
      (s: { id: string; status: string }) => s.id === "guard" && s.status === "refused",
    ),
  );
  assert.ok(!result.stdout.includes("sk-something"));
  assert.deepEqual(await snapshot(dir), before);
  assert.equal((await readdir(dir)).includes(".assetgrove"), false);
});

test("init writes no settings file, key or harness config", async () => {
  const dir = tempDir();
  const settingsBefore = await readFile(settingsPath, "utf8");
  const result = await cli(initArgs(dir), { [OPENAI]: KEY_VALUE });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes(KEY_VALUE));
  const forbidden = [
    "settings.json",
    "settings.local.json",
    ".mcp.json",
    "config.toml",
    "mcp-config.json",
    ".claude.json",
    ".env",
  ];
  for (const file of result.json.files as Array<{ path: string }>) {
    assert.notEqual(file.path, settingsPath);
    for (const name of forbidden) assert.ok(!file.path.endsWith(name), `${file.path} ends ${name}`);
    assert.ok(!(await readFile(file.path, "utf8")).includes(KEY_VALUE), file.path);
  }
  for (const path of Object.keys(await snapshot(dir)))
    for (const name of forbidden) assert.ok(!path.endsWith(name), path);
  assert.equal(await readFile(settingsPath, "utf8"), settingsBefore);
});

test("the settings step needs a person and the key recipe steps follow per harness", async () => {
  const settings = loadSettings();
  for (const harness of ["claude-code", "codex"] as const) {
    assert.ok((HARNESSES as readonly string[]).includes(harness));
    const dir = tempDir();
    const result = await cli(initArgs(dir, "Synthetic world", ["--harness", harness]));
    assert.equal(result.code, 0, result.stderr);
    const steps = result.json.steps as Array<{
      id: string;
      status: string;
      tool?: string;
      detail: string;
    }>;
    const settingsStep = steps.find((s) => s.id === "settings")!;
    assert.equal(settingsStep.status, "needs-person");
    assert.equal(settingsStep.tool, "settings_change");
    assert.match(settingsStep.detail, /settings_change/);
    const recipe = keyRecipe(harness, {
      configDir: settings.configDir,
      stateDir: settings.stateDir,
    });
    assert.ok(recipe.steps.length > 0);
    const ids = steps.map((s) => s.id);
    const keySteps = steps.slice(ids.indexOf("files") + 1, ids.indexOf("settings"));
    assert.deepEqual(
      keySteps.map((s) => s.id),
      recipe.steps.map((s) => s.id),
    );
    for (const step of keySteps) assert.equal(step.status, "needs-person", step.id);
    assert.deepEqual(result.json.providers, JSON.parse(JSON.stringify(routeDataFlows(settings))));
  }
});

test("bible init is gone", async () => {
  const dir = tempDir();
  const result = await cli([
    "bible",
    "init",
    "--directory",
    dir,
    "--world",
    "W",
    "--preset",
    "cozy-storybook",
  ]);
  assert.equal(result.code, 2);
  assert.deepEqual(await readdir(dir), []);
});

test("the skills init writes meet the Agent Skills rules and are identical", async () => {
  const dir = tempDir();
  assert.equal((await cli(initArgs(dir))).code, 0);
  const paths = [".claude", ".agents"].map((root) =>
    join(dir, root, "skills", "art-direction", "SKILL.md"),
  );
  for (const path of paths) await checkSkill(path);
  const [claude, agents] = await Promise.all(paths.map((p) => readFile(p, "utf8")));
  assert.equal(claude, agents);
});

test("init reports a step when the search package is installed but not listed, and none once it is", async () => {
  const dir = tempDir();
  const pkg = join(dir, "node_modules", "@clockgrove", "assetgrove-search");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@clockgrove/assetgrove-search", version: "0.0.0" }),
  );
  try {
    writeSettings({});
    const unlisted = await cli(initArgs(dir));
    assert.equal(unlisted.code, 0, unlisted.stderr);
    const step = unlisted.json.steps.find((s) => s.id === "search");
    assert.equal(step?.status, "needs-person");
    assert.match(step!.detail, /@clockgrove\/assetgrove-search/);
    assert.ok(step!.detail.includes(settingsPath), step!.detail);

    // Listed, it loads (src/extensions/registry.ts) and init asks nothing more of the person.
    const listed = { ...loadSettings(), extensions: ["@clockgrove/assetgrove-search"] };
    assert.deepEqual(searchSteps(dir, listed), []);

    const bare = await cli(initArgs(tempDir()));
    assert.equal(
      bare.json.steps.find((s) => s.id === "search"),
      undefined,
    );
  } finally {
    resetSettings();
  }
});

test("with a remote store configured, init's output carries the shared-index notice", async () => {
  try {
    writeSettings({ search: { store: { uri: "s3://team-bucket/assets" } } });
    const result = await cli(initArgs(tempDir()));
    assert.equal(result.code, 0, result.stderr);
    const notice = result.json.steps.find((s) => s.id === "notice.shared-index");
    assert.equal(notice?.status, "notice");
    assert.match(
      notice!.detail,
      /a shared index exposes embeddings to whoever can read the bucket/i,
    );
    assert.match(notice!.detail, /s3:\/\/team-bucket\/assets/);

    writeSettings({});
    const none = await cli(initArgs(tempDir()));
    assert.equal(
      none.json.steps.find((s) => s.id === "notice.shared-index"),
      undefined,
    );
  } finally {
    resetSettings();
  }
});
