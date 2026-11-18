import "./fixtures/env.ts";
import { approve } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { machineProxyEnv } from "./fixtures/env.ts";
import { shelterSpec, syntheticWorld, writeStyleBible } from "./fixtures/synthetic.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
// npm reaches the registry through the machine's proxy, which the fixture removed for Assetgrove.
const npmEnv = { ...process.env, ...machineProxyEnv };
const FIVE_MINUTES = 5 * 60 * 1000;
// A tarball built elsewhere (a release candidate) is installed instead of packing this checkout.
const prebuilt = process.env["ASSETGROVE_TEST_TARBALL"];

/**
 * npm, run portably: its CLI script under the running Node when it is there (on Windows `npm` is a
 * .cmd file, which execFile cannot start without a shell), else `npm` on the PATH.
 */
function npm(args: string[], options: { cwd: string }) {
  const prefix = dirname(process.execPath);
  const script = [
    join(prefix, "node_modules", "npm", "bin", "npm-cli.js"),
    join(prefix, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((path) => existsSync(path));
  const [file, argv] = script ? [process.execPath, [script, ...args]] : ["npm", args];
  return exec(file, argv, { ...options, env: npmEnv });
}

/**
 * The package must hold what a user needs (the CLI, the extension API and the pack test kit with
 * their declarations)
 * and none of the TypeScript sources or tests.
 */
function assertContents(paths: string[]): void {
  for (const wanted of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/cli.js",
    "dist/extension/api.js",
    "dist/extension/api.d.ts",
    "dist/testing/index.js",
    "dist/testing/index.d.ts",
    "skills/assetgrove/SKILL.md",
    "policy/blocklist.json",
  ]) {
    assert.ok(paths.includes(wanted), `package lacks ${wanted}`);
  }
  assert.deepEqual(
    paths.filter(
      (p) =>
        (p.endsWith(".ts") && !p.endsWith(".d.ts")) ||
        p.startsWith("src/") ||
        p.startsWith("test/"),
    ),
    [],
  );
}

/** The tarball holds the manifest, the README, the licence and the three shipped directories, nothing else. */
const SHIPPED_FILES = ["package.json", "README.md", "LICENSE"];
const SHIPPED_DIRS = ["dist/", "skills/", "policy/"];

/** Each path is one of the shipped files or under a shipped directory, and each directory is there. */
function assertOnlyShipped(paths: string[]): void {
  assert.deepEqual(
    paths.filter((p) => !SHIPPED_FILES.includes(p) && !SHIPPED_DIRS.some((d) => p.startsWith(d))),
    [],
  );
  for (const dir of SHIPPED_DIRS) {
    assert.ok(
      paths.some((p) => p.startsWith(dir)),
      `package lacks ${dir}`,
    );
  }
}

test(
  "npm pack lists only package.json, README.md, LICENSE, dist/, skills/ and policy/",
  // With a prebuilt tarball the next test checks that tarball's own listing, and the checkout is
  // neither packed nor built.
  { timeout: FIVE_MINUTES, skip: prebuilt ? "ASSETGROVE_TEST_TARBALL is set" : false },
  async () => {
    try {
      await rm(join(root, "dist"), { recursive: true, force: true });
      const { stdout } = await npm(["pack", "--dry-run", "--json"], { cwd: root });
      const [packed] = JSON.parse(stdout) as Array<{ files: { path: string }[] }>;
      assert.ok(packed);
      const paths = packed.files.map((f) => f.path);
      assertOnlyShipped(paths);
      assertContents(paths);
    } finally {
      await rm(join(root, "dist"), { recursive: true, force: true });
    }
  },
);

test(
  "the packed tarball installs and its bin runs without TypeScript stripping",
  { timeout: FIVE_MINUTES },
  async () => {
    const temps: string[] = [];
    const temp = async () => {
      const dir = await mkdtemp(join(tmpdir(), "assetgrove-pkg-"));
      temps.push(dir);
      return dir;
    };
    try {
      let tarball: string;
      if (prebuilt) {
        tarball = resolve(prebuilt);
      } else {
        // Pack the way a publish does: no prebuilt dist/, so the tarball's dist/ can only come
        // from the package's own prepack script.
        await rm(join(root, "dist"), { recursive: true, force: true });
        const packDir = await temp();
        const { stdout } = await npm(["pack", "--json", "--pack-destination", packDir], {
          cwd: root,
        });
        const [packed] = JSON.parse(stdout) as Array<{
          filename: string;
          files: { path: string }[];
        }>;
        assert.ok(packed);
        assertContents(packed.files.map((f) => f.path));
        tarball = join(packDir, packed.filename);
      }

      const install = await temp();
      await writeFile(join(install, "package.json"), JSON.stringify({ private: true }));
      await npm(
        ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", tarball],
        { cwd: install },
      );
      await stat(join(install, "node_modules/.bin/assetgrove"));
      const installed = join(install, "node_modules/@clockgrove/assetgrove");
      if (prebuilt) {
        // The installed package directory holds exactly the tarball's files.
        const entries = await readdir(installed, { recursive: true, withFileTypes: true });
        const paths = entries
          .filter((e) => e.isFile())
          .map((e) =>
            join(e.parentPath, e.name)
              .slice(installed.length + 1)
              .split(sep)
              .join("/"),
          );
        assertOnlyShipped(paths);
        assertContents(paths);
      }

      const env = { ...process.env };
      delete env["AI_GATEWAY_API_KEY"];
      const bin = join(installed, "dist", "cli.js");
      const run = (args: string[]) =>
        exec(process.execPath, ["--no-experimental-strip-types", bin, ...args], {
          cwd: install,
          env,
        });

      const help = await run(["--help"]);
      assert.match(help.stdout, /stage/);
      assert.match(help.stdout, /pick/);

      // The installed bin answers the structured help agents read.
      const helpJson = JSON.parse((await run(["--help", "--json"])).stdout) as {
        ok: boolean;
        usage: string;
      };
      assert.equal(helpJson.ok, true);
      assert.match(helpJson.usage, /stage/);

      // The extension API resolves through the package's exports, compiled.
      const api = await exec(
        process.execPath,
        [
          "--no-experimental-strip-types",
          "--input-type=module",
          "-e",
          'const m = await import("@clockgrove/assetgrove/extension"); const t = await import("@clockgrove/assetgrove/testing"); console.log(m.EXTENSION_API, typeof m.z.object, typeof t.runConformance, typeof t.tempProject);',
        ],
        { cwd: install, env },
      );
      assert.equal(api.stdout.trim(), "2 function function function");

      const world = await syntheticWorld();
      temps.push(world.dir);
      const spec = join(install, "spec.json");
      const bible = join(world.bibleDir, "BIBLE.md");
      const profile = join(install, "profile.json");
      const script = join(install, "script.mjs");
      await writeFile(spec, JSON.stringify(shelterSpec));
      await writeStyleBible(bible, world.bible);
      await writeFile(profile, JSON.stringify(world.profile));
      await writeFile(
        script,
        `export default { image() { throw new Error("no"); }, vision() { throw new Error("no"); } };`,
      );
      approve(script);
      const dry = await run([
        "stage",
        "--spec",
        spec,
        "--bible",
        bible,
        "--profile",
        profile,
        "--provider-script",
        script,
        "--dry-run",
        "--json",
      ]);
      const doc = JSON.parse(dry.stdout);
      assert.equal(doc.ok, true);
      assert.ok(doc.plan.calls > 0);

      // Core works without search: installed alone, find exits 2 extension_unavailable, naming
      // the package that would fill the slot. The fixture's settings list no extension.
      await assert.rejects(
        exec(
          process.execPath,
          ["--no-experimental-strip-types", bin, "find", "lantern", "--json"],
          {
            cwd: install,
            env,
          },
        ),
        (error: { code?: number; stdout?: string }) => {
          assert.equal(error.code, 2);
          const found = JSON.parse(error.stdout ?? "") as {
            ok: boolean;
            error: { code: string; message: string };
          };
          assert.equal(found.ok, false);
          assert.equal(found.error.code, "extension_unavailable");
          assert.match(found.error.message, /@clockgrove\/assetgrove-search/);
          return true;
        },
      );
      assert.equal(existsSync(join(install, "node_modules/@clockgrove/assetgrove-search")), false);

      const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      const version = await run(["--version"]);
      assert.equal(version.stdout.trim(), pkg.version);
    } finally {
      if (!prebuilt) await rm(join(root, "dist"), { recursive: true, force: true });
      for (const dir of temps) await rm(dir, { recursive: true, force: true });
    }
  },
);
