import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
// Pre-built tarball to install instead of packing the working tree.
const givenTarball = process.env["ASSETGROVE_TEST_TARBALL"]
  ? resolve(process.env["ASSETGROVE_TEST_TARBALL"])
  : undefined;

// Node refuses to spawn npm.cmd without a shell, so run npm's own script under this Node when it
// sits beside it (Windows and POSIX layouts); otherwise fall back to the npm on PATH.
const npmCli = [
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].find((candidate) => existsSync(candidate));
const npm = (args: string[], cwd: string) =>
  npmCli
    ? exec(process.execPath, [npmCli, ...args], { cwd, env: npmEnv })
    : exec("npm", args, { cwd, env: npmEnv, shell: process.platform === "win32" });
const wantedFiles = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/cli.js",
  "skills/assetgrove/SKILL.md",
];

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
      if (givenTarball) {
        tarball = givenTarball;
      } else {
        // Pack the way a publish does: no prebuilt dist/, so the tarball's dist/ can only come
        // from the package's own prepack script.
        await rm(join(root, "dist"), { recursive: true, force: true });
        const packDir = await temp();
        const { stdout } = await npm(["pack", "--json", "--pack-destination", packDir], root);
        const [packed] = JSON.parse(stdout) as Array<{
          filename: string;
          files: { path: string }[];
        }>;
        assert.ok(packed);
        const paths = packed.files.map((f) => f.path);
        for (const wanted of wantedFiles) {
          assert.ok(paths.includes(wanted), `tarball lacks ${wanted}`);
        }
        assert.deepEqual(
          paths.filter((p) => p.endsWith(".ts") || p.startsWith("src/") || p.startsWith("test/")),
          [],
        );
        tarball = join(packDir, packed.filename);
      }

      const install = await temp();
      await writeFile(join(install, "package.json"), JSON.stringify({ private: true }));
      await npm(
        ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", tarball],
        install,
      );
      await stat(join(install, "node_modules/.bin/assetgrove"));
      const installed = join(install, "node_modules/@clockgrove/assetgrove");
      if (givenTarball) {
        for (const wanted of wantedFiles) await stat(join(installed, wanted));
        for (const unwanted of ["src", "test"]) {
          await assert.rejects(stat(join(installed, unwanted)), `package ships ${unwanted}/`);
        }
      }

      const env = { ...process.env };
      delete env["AI_GATEWAY_API_KEY"];
      const bin = join(installed, "dist/cli.js");
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
      if (!givenTarball) await rm(join(root, "dist"), { recursive: true, force: true });
      for (const dir of temps) await rm(dir, { recursive: true, force: true });
    }
  },
);
