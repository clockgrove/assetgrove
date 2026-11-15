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
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

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

/** The package must hold what a user needs and none of the TypeScript sources or tests. */
function assertContents(paths: string[]): void {
  for (const wanted of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/cli.js",
    "skills/assetgrove/SKILL.md",
  ]) {
    assert.ok(paths.includes(wanted), `package lacks ${wanted}`);
  }
  assert.deepEqual(
    paths.filter((p) => p.endsWith(".ts") || p.startsWith("src/") || p.startsWith("test/")),
    [],
  );
}

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
        const entries = await readdir(installed, { recursive: true, withFileTypes: true });
        assertContents(
          entries
            .filter((e) => e.isFile())
            .map((e) =>
              join(e.parentPath, e.name)
                .slice(installed.length + 1)
                .split(sep)
                .join("/"),
            ),
        );
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

      const world = await syntheticWorld();
      temps.push(world.dir);
      const spec = join(install, "spec.json");
      const bible = join(world.bibleDir, "bible.json");
      const profile = join(install, "profile.json");
      const script = join(install, "script.mjs");
      await writeFile(spec, JSON.stringify(shelterSpec));
      await writeFile(bible, JSON.stringify(world.bible));
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

      const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      const version = await run(["--version"]);
      assert.equal(version.stdout.trim(), pkg.version);
    } finally {
      await rm(join(root, "dist"), { recursive: true, force: true });
      for (const dir of temps) await rm(dir, { recursive: true, force: true });
    }
  },
);
