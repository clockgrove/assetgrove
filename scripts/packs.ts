// The one list of packs (issue #415): a pack is a directory under packages/ whose package.json has
// an `assetgrove` field. CI, release and the gate read this list; none of them names a pack by path.
//
//   node scripts/packs.ts list [<base>]         the packs, one JSON line (CI's matrix); with <base>,
//                                               each says whether the change since it touches the pack
//   node scripts/packs.ts touched <dir> <base>  "true" when the change since <base> touches the pack
//                                               or what it reads outside itself, else "false"
//   node scripts/packs.ts release               core and every pack whose version is not yet on
//                                               the registry, one JSON line (release's matrix)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface PackSkill {
  /** The `name` in the skill's SKILL.md frontmatter. */
  name: string;
  /** The skill's directory, relative to the root, with `/`. */
  dir: string;
}

export interface Pack {
  /** The pack's directory, relative to the root, with `/` (`packages/<short>`). */
  dir: string;
  /** Its directory's name: what job and artifact names call it. */
  short: string;
  name: string;
  version: string;
  files: string[];
  skills: PackSkill[];
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one argv in a directory; injected so tests reach no registry. */
export type Runner = (argv: string[], cwd: string) => RunResult;

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const slash = (path: string) => path.split(sep).join("/");

interface Manifest {
  name?: unknown;
  version?: unknown;
  files?: unknown;
  assetgrove?: unknown;
}

function readManifest(path: string): Manifest | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Manifest)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The skills a pack ships: each `skills/<dir>/SKILL.md`, named by its frontmatter. */
export function packSkills(root: string, dir: string): PackSkill[] {
  const skillsDir = join(root, dir, "skills");
  if (!existsSync(skillsDir)) return [];
  const skills: PackSkill[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"))?.[1];
    const name = (front === undefined ? undefined : (parse(front) as { name?: unknown }))?.name;
    if (typeof name !== "string" || name === "")
      throw new Error(`${dir}/skills/${entry.name}/SKILL.md names no skill in its frontmatter`);
    skills.push({ name, dir: `${dir}/skills/${entry.name}` });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Every pack under `<root>/packages`, by directory name. */
export function listPacks(root: string = ROOT): Pack[] {
  const packages = join(root, "packages");
  if (!existsSync(packages)) return [];
  const packs: Pack[] = [];
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = `packages/${entry.name}`;
    const manifest = readManifest(join(root, dir, "package.json"));
    if (manifest?.assetgrove === undefined) continue;
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string")
      throw new Error(`${dir}/package.json declares assetgrove but no name and version`);
    packs.push({
      dir,
      short: entry.name,
      name: manifest.name,
      version: manifest.version,
      files: Array.isArray(manifest.files) ? manifest.files.map(String) : [],
      skills: packSkills(root, dir),
    });
  }
  return packs.sort((a, b) => a.short.localeCompare(b.short));
}

/**
 * What every pack leg reads of core and the repository: core's source (a pack imports it through
 * `@clockgrove/assetgrove`), the root manifests, this list and the workflow that runs the legs.
 */
export const SHARED_PATHS = [
  "src",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.build.json",
  "scripts/packs.ts",
  ".github/workflows/ci.yml",
] as const;

const SOURCE = /\.(?:[cm]?[jt]s)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
/** A relative specifier in an import, a dynamic import or a `new URL(..., import.meta.url)`. */
const SPECIFIERS = [
  /\bfrom\s*["'](\.\.?\/[^"']*)["']/g,
  /\bimport\s*["'](\.\.?\/[^"']*)["']/g,
  /\bimport\(\s*["'](\.\.?\/[^"']*)["']\s*\)/g,
  /\bnew URL\(\s*["'](\.\.?\/[^"']*|\.\.?)["']\s*,\s*import\.meta\.url/g,
];

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesUnder(path));
    else if (entry.isFile() && SOURCE.test(entry.name)) out.push(path);
  }
  return out;
}

function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The paths a change must touch for the pack's leg to run: the pack, `SHARED_PATHS`, and every
 * file or folder outside the pack and outside core's `src` that its sources reach by a relative
 * path, followed through the sources it reaches. Relative to the root, with `/`, sorted.
 */
export function touchedPaths(root: string, pack: Pick<Pack, "dir">): string[] {
  const top = resolve(root);
  const packDir = resolve(top, pack.dir);
  const core = resolve(top, "src");
  const found = new Set<string>();
  const queue = sourcesUnder(packDir);
  const seen = new Set(queue);
  while (queue.length > 0) {
    const file = queue.pop()!;
    const text = readFileSync(file, "utf8");
    for (const pattern of SPECIFIERS) {
      for (const match of text.matchAll(pattern)) {
        const target = resolve(dirname(file), match[1]!);
        if (!inside(target, top) || target === top) continue;
        if (inside(target, packDir) || inside(target, core)) continue;
        found.add(slash(relative(top, target)));
        if (seen.has(target) || !existsSync(target) || !statSync(target).isFile()) continue;
        if (!SOURCE.test(target)) continue;
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...new Set([pack.dir, ...SHARED_PATHS, ...found])].sort();
}

export const defaultRunner: Runner = (argv, cwd) => {
  const [file, ...args] = argv;
  if (!file) return { status: 1, stdout: "", stderr: "empty command" };
  const out = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    // npm is a .cmd shim on Windows, so it needs the shell; nothing else goes through cmd.exe,
    // which would read the `^` in `<sha>^{commit}` as its escape character.
    shell: process.platform === "win32" && file === "npm",
  });
  return {
    status: out.status,
    stdout: out.stdout ?? "",
    stderr: out.error ? String(out.error.message) : (out.stderr ?? ""),
  };
};

/**
 * Whether the change from `base` to HEAD touches the pack's leg: true when any of its
 * `touchedPaths` differs, and when Git cannot tell (a base the clone lacks).
 */
export function touched(
  root: string,
  pack: Pick<Pack, "dir">,
  base: string,
  run: Runner = defaultRunner,
): boolean {
  if (!/^[0-9a-f]{40}$/.test(base) || /^0+$/.test(base)) return true;
  if (run(["git", "cat-file", "-e", `${base}^{commit}`], root).status !== 0) return true;
  const diff = run(
    ["git", "diff", "--quiet", base, "HEAD", "--", ...touchedPaths(root, pack)],
    root,
  );
  return diff.status !== 0;
}

export interface ReleaseTarget {
  /** `.` for core, else the pack's directory. */
  dir: string;
  short: string;
  name: string;
  version: string;
  core: boolean;
  /** The file `pnpm pack` writes. */
  tarball: string;
  /** The run artifact that carries the tarball, its sha256 and its attestation. */
  artifact: string;
  /** Whether the package exists on the registry, so publish may run for it. */
  onRegistry: boolean;
}

/** The file name `pnpm pack` gives a package: the scope's `@` dropped and its `/` a `-`. */
export function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

/**
 * What release builds: every pack whose `name@version` is not on the registry yet, that is, whose
 * version changed since it was last published, and core unless its `name@version` is already there
 * while a pack is to be released. So a pack released on its own is verified and published without
 * core's leg failing, and a run with no pack still lists core, whose own steps refuse a version or
 * tag that already exists. `run` asks the registry (`npm view`).
 */
export function releasePlan(root: string = ROOT, run: Runner = defaultRunner): ReleaseTarget[] {
  const exists = (spec: string) => run(["npm", "view", spec, "version"], root).status === 0;
  const core = readManifest(join(root, "package.json"));
  if (typeof core?.name !== "string" || typeof core.version !== "string")
    throw new Error("package.json names no core package and version");
  const target = (
    dir: string,
    short: string,
    name: string,
    version: string,
    isCore: boolean,
  ): ReleaseTarget => ({
    dir,
    short,
    name,
    version,
    core: isCore,
    tarball: tarballName(name, version),
    artifact: `${short}-${version}`,
    onRegistry: exists(name),
  });
  const packs: ReleaseTarget[] = [];
  for (const pack of listPacks(root)) {
    if (exists(`${pack.name}@${pack.version}`)) continue;
    packs.push(target(pack.dir, pack.short, pack.name, pack.version, false));
  }
  if (packs.length > 0 && exists(`${core.name}@${core.version}`)) return packs;
  return [target(".", "assetgrove", core.name, core.version, true), ...packs];
}

export type MatrixEntry = Pick<Pack, "dir" | "short" | "name"> & { touched?: boolean };

/**
 * CI's matrix: each pack's directory, short name and package name; with `base`, whether the change
 * since it touches the pack's leg (`touched`).
 */
export function matrix(
  root: string = ROOT,
  base?: string,
  run: Runner = defaultRunner,
): MatrixEntry[] {
  return listPacks(root).map((pack) => ({
    dir: pack.dir,
    short: pack.short,
    name: pack.name,
    ...(base !== undefined && { touched: touched(root, pack, base, run) }),
  }));
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (command === "list" && args.length <= 1) {
    out(matrix(ROOT, args[0]));
  } else if (command === "touched" && args.length === 2) {
    const pack = listPacks().find((p) => p.dir === args[0] || p.short === args[0]);
    if (!pack) {
      process.stderr.write(`no pack at ${args[0]}\n`);
      process.exit(2);
    }
    out(touched(ROOT, pack, args[1]!));
  } else if (command === "release") {
    out(releasePlan());
  } else {
    process.stderr.write(
      "usage: node scripts/packs.ts list [<base>] | touched <dir> <base> | release\n",
    );
    process.exit(2);
  }
}
