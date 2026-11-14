import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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
    ".env": `${GATEWAY}=abc\n`,
    "config/providers.json": `${JSON.stringify({ [OPENAI]: "x" }, null, 2)}\n`,
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
      !error.message.includes("abc"),
  );
});

test("export lines, YAML members and settings' keyEnv count; references and placeholders do not", async () => {
  const repo = await repository({
    "deploy.sh": `export ${GATEWAY}="abc"\n`,
    "ci.yml": `env:\n  ${OPENAI}: sk-something\n`,
    "custom.env": `MY_PROVIDER_TOKEN=abc\n`,
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
