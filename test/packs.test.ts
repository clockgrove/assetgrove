import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  defaultRunner,
  listPacks,
  matrix,
  releasePlan,
  tarballName,
  touched,
  touchedPaths,
  type Runner,
} from "../scripts/packs.ts";

const temporary: string[] = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Load for ${name}.\n---\n# ${name}\n`;

/** A repository tree with core, two packs and one package that is not a pack. */
function tree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-packs-")));
  temporary.push(root);
  put(root, "package.json", JSON.stringify({ name: "@clockgrove/assetgrove", version: "0.2.0" }));
  put(root, "src/cli.ts", "export {};\n");
  put(root, "bench/tiles/fixture.ts", 'import "./helper.ts";\nexport const x = 1;\n');
  put(root, "bench/tiles/helper.ts", "export const y = 2;\n");
  put(root, "docs/tiles.md", "# Tiles\n");
  put(root, "other/unrelated.ts", "export {};\n");
  for (const short of ["alpha-pack", "tiles-pack"]) {
    put(
      root,
      `packages/${short}/package.json`,
      JSON.stringify({
        name: `@clockgrove/${short}`,
        version: "0.3.0",
        files: ["dist", "skills"],
        assetgrove: { api: 2, entry: "./dist/extension.js" },
      }),
    );
    put(root, `packages/${short}/src/extension.ts`, "export default {};\n");
    put(root, `packages/${short}/skills/${short}-skill/SKILL.md`, skill(`${short}-skill`));
  }
  put(
    root,
    "packages/tiles-pack/test/bench.test.ts",
    [
      'import { x } from "../../../bench/tiles/fixture.ts";',
      'import "../src/extension.ts";',
      'const doc = new URL("../../../docs/tiles.md", import.meta.url);',
      'const core = await import("../../../src/cli.ts");',
      "export { x, doc, core };",
      "",
    ].join("\n"),
  );
  put(
    root,
    "packages/not-a-pack/package.json",
    JSON.stringify({ name: "plain", version: "1.0.0" }),
  );
  put(root, "packages/no-manifest/README.md", "nothing\n");
  return root;
}

test("every directory under packages/ with an assetgrove field is a pack, and the matrix holds each", () => {
  const root = tree();
  const packs = listPacks(root);
  assert.deepEqual(
    packs.map((p) => [p.dir, p.short, p.name, p.version]),
    [
      ["packages/alpha-pack", "alpha-pack", "@clockgrove/alpha-pack", "0.3.0"],
      ["packages/tiles-pack", "tiles-pack", "@clockgrove/tiles-pack", "0.3.0"],
    ],
  );
  assert.deepEqual(packs[1]!.skills, [
    { name: "tiles-pack-skill", dir: "packages/tiles-pack/skills/tiles-pack-skill" },
  ]);
  // CI's matrix is this list: a second pack appears with no workflow edit.
  assert.deepEqual(matrix(root), [
    { dir: "packages/alpha-pack", short: "alpha-pack", name: "@clockgrove/alpha-pack" },
    { dir: "packages/tiles-pack", short: "tiles-pack", name: "@clockgrove/tiles-pack" },
  ]);
});

test("this repository's list holds the search package", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const search = listPacks(root).find((p) => p.short === "assetgrove-search");
  assert.ok(search);
  assert.deepEqual(
    search.skills.map((s) => s.name),
    ["assetgrove-search"],
  );
  // The bench its tests import and the bars file they read are the leg's too.
  const paths = touchedPaths(root, search);
  for (const wanted of [
    "packages/assetgrove-search",
    "src",
    "bench/search/bench.ts",
    "docs/decisions.md",
  ])
    assert.ok(paths.includes(wanted), wanted);
});

test("a pack's leg covers what it reaches outside itself, transitively, and nothing else", () => {
  const root = tree();
  const [alpha, tiles] = listPacks(root);
  const paths = touchedPaths(root, tiles!);
  for (const wanted of [
    "packages/tiles-pack",
    "src",
    "package.json",
    "pnpm-lock.yaml",
    "bench/tiles/fixture.ts",
    "bench/tiles/helper.ts",
    "docs/tiles.md",
  ])
    assert.ok(paths.includes(wanted), wanted);
  assert.ok(!paths.some((p) => p.startsWith("other/") || p.startsWith("src/")), paths.join(", "));
  assert.ok(!touchedPaths(root, alpha!).includes("bench/tiles/fixture.ts"));
});

test("the default runner hands Git's revision syntax over unchanged on every system", () => {
  // cmd.exe reads `^` as its escape character, so `<sha>^{commit}` must not pass through it.
  const out = defaultRunner(
    [process.execPath, "-e", "process.stdout.write(process.argv[1])", "abc^{commit}"],
    process.cwd(),
  );
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "abc^{commit}");
});

test("a leg runs when its pack, core or what it reads changed, and not for another pack's change", () => {
  const root = tree();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const [alpha, tiles] = listPacks(root);
  assert.equal(touched(root, tiles!, base), false);
  assert.deepEqual(
    matrix(root, base).map((m) => m.touched),
    [false, false],
  );

  put(root, "packages/alpha-pack/src/extension.ts", "export default { changed: true };\n");
  git("commit", "-q", "-am", "alpha");
  assert.equal(touched(root, alpha!, base), true);
  assert.equal(touched(root, tiles!, base), false);
  assert.deepEqual(
    matrix(root, base).map((m) => [m.short, m.touched]),
    [
      ["alpha-pack", true],
      ["tiles-pack", false],
    ],
  );

  const mid = git("rev-parse", "HEAD");
  put(root, "bench/tiles/helper.ts", "export const y = 3;\n");
  git("commit", "-q", "-am", "bench");
  assert.equal(touched(root, tiles!, mid), true);
  assert.equal(touched(root, alpha!, mid), false);

  const late = git("rev-parse", "HEAD");
  put(root, "src/cli.ts", "export const core = 1;\n");
  git("commit", "-q", "-am", "core");
  assert.equal(touched(root, alpha!, late), true);
  assert.equal(touched(root, tiles!, late), true);

  // No usable base: the legs run.
  assert.equal(touched(root, tiles!, "0".repeat(40)), true);
  assert.equal(touched(root, tiles!, "f".repeat(40)), true);
  assert.equal(touched(root, tiles!, ""), true);
});

test("release builds core and every pack whose version is not on the registry", () => {
  const root = tree();
  const asked: string[] = [];
  const registry = new Set([
    "@clockgrove/assetgrove",
    "@clockgrove/alpha-pack",
    "@clockgrove/alpha-pack@0.3.0",
  ]);
  const run: Runner = (argv) => {
    assert.deepEqual(argv.slice(0, 2), ["npm", "view"]);
    asked.push(argv[2]!);
    return { status: registry.has(argv[2]!) ? 0 : 1, stdout: "", stderr: "" };
  };
  const plan = releasePlan(root, run);
  assert.deepEqual(plan, [
    {
      dir: ".",
      short: "assetgrove",
      name: "@clockgrove/assetgrove",
      version: "0.2.0",
      core: true,
      tarball: "clockgrove-assetgrove-0.2.0.tgz",
      artifact: "assetgrove-0.2.0",
      onRegistry: true,
    },
    {
      dir: "packages/tiles-pack",
      short: "tiles-pack",
      name: "@clockgrove/tiles-pack",
      version: "0.3.0",
      core: false,
      tarball: "clockgrove-tiles-pack-0.3.0.tgz",
      artifact: "tiles-pack-0.3.0",
      onRegistry: false,
    },
  ]);
  assert.ok(asked.includes("@clockgrove/alpha-pack@0.3.0"));
  assert.equal(tarballName("plain", "1.0.0"), "plain-1.0.0.tgz");

  // Core's version already published: a pack whose version changed is released without core, so
  // core's refusal can't stop the pack's verify and publish.
  registry.add("@clockgrove/assetgrove@0.2.0");
  assert.deepEqual(
    releasePlan(root, run).map((t) => t.short),
    ["tiles-pack"],
  );
  // Nothing new at all: core stays, and its own steps refuse the published version.
  registry.add("@clockgrove/tiles-pack@0.3.0");
  assert.deepEqual(
    releasePlan(root, run).map((t) => t.short),
    ["assetgrove"],
  );
});
