/**
 * The release candidate's tarball (issue #244): the package packs at its version with its compiled
 * dist/ and its skill and nothing else, and the entry core loads imports from the packed files
 * with type stripping off, as Node runs a package under node_modules.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, realpathSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const FIVE_MINUTES = 5 * 60 * 1000;
/** A tarball the release workflow already packed and attested; when set, it is tested instead of a fresh pack. */
const prebuilt = process.env["ASSETGROVE_TEST_TARBALL"];

/** npm's CLI script under the running Node when it is there (npm is a .cmd file on Windows). */
function npm(args: string[], cwd: string) {
  const prefix = dirname(process.execPath);
  const script = [
    join(prefix, "node_modules", "npm", "bin", "npm-cli.js"),
    join(prefix, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((path) => existsSync(path));
  const [file, argv] = script ? [process.execPath, [script, ...args]] : ["npm", args];
  return exec(file, argv, { cwd, shell: !script && process.platform === "win32" });
}

const SHIPPED_FILES = ["package.json", "README.md", "LICENSE"];
const SHIPPED_DIRS = ["dist/", "skills/"];

test(
  "the tarball packs at 0.2.0 with dist/ and the skill, and its entry imports without type stripping",
  { timeout: FIVE_MINUTES },
  async () => {
    const temp = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-search-pack-")));
    try {
      const packed =
        prebuilt === undefined ? await packFresh(temp) : await listPrebuilt(prebuilt, temp);
      assert.equal(packed.version, "0.2.0");
      const paths = packed.files;
      assert.deepEqual(
        paths.filter(
          (p) => !SHIPPED_FILES.includes(p) && !SHIPPED_DIRS.some((d) => p.startsWith(d)),
        ),
        [],
      );
      for (const wanted of [
        "package.json",
        "README.md",
        "LICENSE",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/extension.js",
        "dist/model-manifest.json",
        "skills/assetgrove-search/SKILL.md",
      ])
        assert.ok(paths.includes(wanted), `package lacks ${wanted}`);
      assert.deepEqual(
        paths.filter((p) => p.endsWith(".ts") && !p.endsWith(".d.ts")),
        [],
        "no TypeScript sources",
      );

      // The packed files, with the package's own dependencies linked beside them.
      await exec("tar", ["-xzf", packed.filename], { cwd: temp });
      const unpacked = join(temp, "package");
      symlinkSync(join(pkgRoot, "node_modules"), join(unpacked, "node_modules"), "junction");
      const manifest = JSON.parse(await readFile(join(unpacked, "package.json"), "utf8")) as {
        version: string;
        main: string;
        assetgrove: { api: number; entry: string };
        peerDependencies: Record<string, string>;
      };
      assert.equal(manifest.version, "0.2.0");
      assert.deepEqual(manifest.assetgrove, { api: 2, entry: "./dist/extension.js" });
      assert.equal(manifest.peerDependencies["@clockgrove/assetgrove"], "^0.2.0");
      const probe = `const e = await import(${JSON.stringify(pathToFileURL(join(unpacked, manifest.assetgrove.entry)).href)});
const m = await import(${JSON.stringify(pathToFileURL(join(unpacked, manifest.main)).href)});
console.log(typeof e.default, typeof m.SearchIndex);`;
      const run = await exec(process.execPath, [
        "--no-experimental-strip-types",
        "--input-type=module",
        "-e",
        probe,
      ]);
      assert.equal(run.stdout.trim(), "function function");
    } finally {
      if (prebuilt === undefined) await rm(join(pkgRoot, "dist"), { recursive: true, force: true });
      await rm(temp, { recursive: true, force: true });
    }
  },
);

interface Packed {
  /** The tarball's name in the temporary folder. */
  filename: string;
  version: string;
  /** Its files, relative to the package. */
  files: string[];
}

/** Packed the way a publish packs: no dist/ beforehand, so it can only come from prepack. */
async function packFresh(temp: string): Promise<Packed> {
  await rm(join(pkgRoot, "dist"), { recursive: true, force: true });
  const { stdout } = await npm(["pack", "--json", "--pack-destination", temp], pkgRoot);
  const [packed] = JSON.parse(stdout.slice(stdout.indexOf("["))) as Array<{
    filename: string;
    version: string;
    files: { path: string }[];
  }>;
  assert.ok(packed);
  return {
    filename: packed.filename,
    version: packed.version,
    files: packed.files.map((f) => f.path),
  };
}

/** The given tarball, copied into the temporary folder (tar is given a name, never a drive path). */
async function listPrebuilt(tarball: string, temp: string): Promise<Packed> {
  const filename = basename(tarball);
  copyFileSync(tarball, join(temp, filename));
  const { stdout } = await exec("tar", ["-tzf", filename], { cwd: temp });
  const files = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("package/") && !line.endsWith("/"))
    .map((line) => line.slice("package/".length));
  const version = /-(\d+\.\d+\.\d+[^/]*)\.tgz$/.exec(filename)?.[1] ?? "";
  return { filename, version, files };
}
