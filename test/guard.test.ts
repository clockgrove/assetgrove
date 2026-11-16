import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { REFUSED_VARIABLES } from "../src/env.ts";
import {
  KeyTrackedError,
  checkTrackedKeys,
  configuredKeyEnv,
  findTrackedKeys,
} from "../src/guard.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(root, "src", "cli.ts");
const temporary: string[] = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

// Names and assignments are built at run time, so this tracked file never holds an assignment.
const GATEWAY = ["AI", "GATEWAY", "API", "KEY"].join("_");
const OPENAI = ["OPENAI", "API", "KEY"].join("_");
/** A synthetic key value: the guard matches values of 16 or more characters. */
const KEY_VALUE = `agk-test-${"0123456789abcdef".split("").reverse().join("")}-synthetic`;

/** A literal shaped like a key: long, one token, no placeholder word. */
const REAL_SHAPED = "sk-proj-AbC123dEf456GhI789jKl0";

/** The Git blob id of text, as `git hash-object` computes it. */
const blobOf = (text: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest("hex");

/** A temporary Git repository with the given files added to its index. */
async function repository(files: Record<string, string | Buffer>): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-guard-")));
  temporary.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], cwd: string, extra: Record<string, string>): Promise<Result> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [GATEWAY, OPENAI, ...REFUSED_VARIABLES]) delete env[name];
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, env: { ...env, ...extra } },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

test("a tracked key value makes a paid command, server start and pick exit 2 key_tracked", async () => {
  const repo = await repository({
    "README.md": "# a game\n",
    "notes/setup.txt": `the gateway key is ${KEY_VALUE}\n`,
  });
  const env = { [GATEWAY]: KEY_VALUE };
  const runs: [string, Result][] = [
    ["stage", await cli(["stage", "--json"], repo, env)],
    ["mcp", await cli(["mcp"], repo, env)],
    [
      "pick",
      await cli(
        [
          "pick",
          "--run",
          join(repo, "runs", "r1"),
          "--candidate",
          "c1",
          "--target",
          join(repo, "assets"),
          "--json",
        ],
        root,
        env,
      ),
    ],
  ];
  for (const [command, r] of runs) {
    assert.equal(r.code, 2, `${command}: ${r.stderr}`);
    assert.match(r.stderr, /notes\/setup\.txt/, command);
    assert.match(r.stderr, new RegExp(GATEWAY), command);
    assert.ok(!r.stdout.includes(KEY_VALUE) && !r.stderr.includes(KEY_VALUE), command);
    if (command !== "mcp") {
      const doc = JSON.parse(r.stdout) as { error: { code: string; message: string } };
      assert.equal(doc.error.code, "key_tracked", command);
      assert.match(doc.error.message, /notes\/setup\.txt/, command);
    }
  }
});

test("a clean repository lets pick reach its own checks", async () => {
  const repo = await repository({ "README.md": "# a game\n" });
  const r = await cli(
    [
      "pick",
      "--run",
      join(repo, "runs", "r1"),
      "--candidate",
      "c1",
      "--target",
      join(repo, "assets"),
      "--json",
    ],
    root,
    { [GATEWAY]: KEY_VALUE },
  );
  const doc = JSON.parse(r.stdout) as { error: { code: string } };
  assert.notEqual(doc.error.code, "key_tracked");
});

test("with an empty environment, named assignments are refused and empty ones are not", async () => {
  const repo = await repository({
    ".env": `${GATEWAY}=${REAL_SHAPED}\n`,
    "config/providers.json": `${JSON.stringify({ [OPENAI]: REAL_SHAPED }, null, 2)}\n`,
    "empty.env": `${GATEWAY}=\n`,
  });
  const found = findTrackedKeys(repo, { env: {} });
  assert.deepEqual(
    found.map((f) => [f.file, f.variable]),
    [
      [".env", GATEWAY],
      ["config/providers.json", OPENAI],
    ],
  );
  assert.throws(
    () => checkTrackedKeys(repo, { env: {} }),
    (error: unknown) =>
      error instanceof KeyTrackedError &&
      error.code === "key_tracked" &&
      /\.env/.test(error.message) &&
      /config\/providers\.json/.test(error.message) &&
      !/empty\.env/.test(error.message) &&
      !error.message.includes(REAL_SHAPED),
  );
});

test("export lines, YAML members and settings' keyEnv count; references and placeholders do not", async () => {
  const repo = await repository({
    "deploy.sh": `export ${GATEWAY}="${REAL_SHAPED}"\n`,
    "ci.yml": `env:\n  ${OPENAI}: ${REAL_SHAPED}\n`,
    "custom.env": `MY_PROVIDER_TOKEN=${REAL_SHAPED}\n`,
    "ref.yml": `env:\n  ${GATEWAY}: \${{ secrets.KEY }}\n`,
    "ref.sh": `export ${GATEWAY}=$${GATEWAY}\n`,
    "doc.md": `export ${GATEWAY}=...   # from the environment only\n${GATEWAY}=<your key>\n`,
    "code.ts": `const env = {\n  ${GATEWAY}: "only YAML files have YAML members",\n};\n`,
    "quoted.json": `{ "${GATEWAY}": "" }\n`,
  });
  const keyEnv = configuredKeyEnv({ providers: { custom: { keyEnv: "MY_PROVIDER_TOKEN" } } });
  assert.ok(keyEnv.includes(GATEWAY) && keyEnv.includes("MY_PROVIDER_TOKEN"));
  const found = findTrackedKeys(repo, { env: {}, keyEnv }).map((f) => f.file);
  assert.deepEqual(found.sort(), ["ci.yml", "custom.env", "deploy.sh"]);
});

test("LFS pointer files and files over 4 MB are skipped", async () => {
  const pointer = [
    "version https://git-lfs.github.com/spec/v1",
    "oid sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "size 12345",
    `${GATEWAY}=abc ${KEY_VALUE}`,
    "",
  ].join("\n");
  const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
  big.write(`${GATEWAY}=abc ${KEY_VALUE}\n`, 0);
  const repo = await repository({ "art/hero.png": pointer, "data/big.txt": big });
  assert.deepEqual(findTrackedKeys(repo, { env: { [GATEWAY]: KEY_VALUE } }), []);
  // The same content in an ordinary small file is refused.
  const plain = await repository({ "data/small.txt": `${GATEWAY}=abc ${KEY_VALUE}\n` });
  assert.equal(findTrackedKeys(plain, { env: { [GATEWAY]: KEY_VALUE } }).length, 1);
});

test("outside a Git repository nothing is tracked", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-noguard-")));
  temporary.push(dir);
  assert.deepEqual(findTrackedKeys(dir, { env: { [GATEWAY]: KEY_VALUE } }), []);
});

test("a key staged and then edited out of or deleted from the working file is refused", async () => {
  const dir = await repository({
    "edited.env": `${GATEWAY}=${REAL_SHAPED}\n`,
    "deleted.txt": `token ${KEY_VALUE}\n`,
  });
  await writeFile(join(dir, "edited.env"), `${GATEWAY}=\n`);
  rmSync(join(dir, "deleted.txt"));
  const found = findTrackedKeys(dir, { env: { [GATEWAY]: KEY_VALUE } });
  assert.deepEqual(found.map((f) => f.file).sort(), ["deleted.txt", "edited.env"]);
});

test("a key in the working file of a tracked file is refused before it is staged", async () => {
  const dir = await repository({ "later.env": `${GATEWAY}=\n` });
  await writeFile(join(dir, "later.env"), `${GATEWAY}=${REAL_SHAPED}\n`);
  assert.equal(findTrackedKeys(dir, { env: {} }).length, 1);
});

test("inside a .git that git cannot read, the guard refuses with key_tracked instead of passing", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-badgit-")));
  temporary.push(dir);
  await writeFile(join(dir, ".git"), "gitdir: ./missing-git-dir\n");
  assert.throws(
    () => checkTrackedKeys(dir, { env: { [GATEWAY]: KEY_VALUE } }),
    (error: unknown) =>
      error instanceof KeyTrackedError &&
      error.code === "key_tracked" &&
      /rev-parse/.test(error.message) &&
      !error.message.includes(KEY_VALUE),
  );
});

test("when git cannot run inside a repository, the guard refuses with key_tracked", async () => {
  const dir = await repository({ "clean.txt": "nothing here\n" });
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.throws(() => checkTrackedKeys(dir, { env: {} }), KeyTrackedError);
  } finally {
    process.env.PATH = path;
  }
});

test("names that only look assigned are not hits: expressions, placeholders, short test values", async () => {
  const repo = await repository({
    "config.py": `${OPENAI} = os.environ.get("${OPENAI}", "")\n`,
    ".env.example": `${OPENAI}=your-api-key-here\n`,
    "README.md": `export ANTHROPIC_API_KEY=sk-ant-...\n`,
    "fixture.json": `${JSON.stringify({ [OPENAI]: "test" })}\n`,
    "long.env": `${GATEWAY}=aaaaaaaaaaaaaaaaaaaa\n${OPENAI}=\${HOME}/some/long/path/x\n`,
  });
  assert.deepEqual(findTrackedKeys(repo, { env: {} }), []);
  assert.doesNotThrow(() => checkTrackedKeys(repo, { env: {} }));
});

test("a key-shaped literal is refused by name, naming the blob and never the value", async () => {
  const text = `${OPENAI}=${REAL_SHAPED}\n`;
  const repo = await repository({ "app.env": text });
  assert.throws(
    () => checkTrackedKeys(repo, { env: {} }),
    (error: unknown) =>
      error instanceof KeyTrackedError &&
      error.message.includes(blobOf(text)) &&
      /keyGuard\.acknowledgedBlobs/.test(error.message) &&
      /--acknowledge-blobs/.test(error.message) &&
      !error.message.includes(REAL_SHAPED),
  );
});

test("an acknowledged blob clears the by-name hit until the file is edited", async () => {
  const text = `${OPENAI}=${REAL_SHAPED}\n`;
  const repo = await repository({ "app.env": text });
  const settings = { providers: {}, keyGuard: { acknowledgedBlobs: [blobOf(text).toUpperCase()] } };
  assert.doesNotThrow(() => checkTrackedKeys(repo, { env: {}, settings }));
  await writeFile(join(repo, "app.env"), `${text}# edited\n`);
  assert.throws(() => checkTrackedKeys(repo, { env: {}, settings }), KeyTrackedError);
  // Settings that predate the field tolerate its absence.
  assert.throws(() => checkTrackedKeys(repo, { env: {}, settings: { providers: {} } }));
});

test("an acknowledged blob never clears the exact-value rule", async () => {
  const text = `the gateway key is ${KEY_VALUE}\n`;
  const repo = await repository({ "notes.txt": text });
  const settings = { providers: {}, keyGuard: { acknowledgedBlobs: [blobOf(text)] } };
  assert.throws(
    () => checkTrackedKeys(repo, { env: { [GATEWAY]: KEY_VALUE }, settings }),
    KeyTrackedError,
  );
});
