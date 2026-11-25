import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
const coreRoot = fileURLToPath(new URL("../../../..", import.meta.url));
/** The tiles pack, whose `tiles:terrain` kind makes the assets `godot:tile-set` hands off. */
export const tilesRoot = fileURLToPath(new URL("../../../assetgrove-tiles", import.meta.url));

const tsc = (...args: string[]) =>
  execFileSync(
    process.execPath,
    [join(pkgRoot, "node_modules", "typescript", "bin", "tsc"), ...args],
    { stdio: "inherit" },
  );

/** Core's emitted declarations under `stage`, built once per stage. */
function buildCore(stage: string): string {
  const core = join(stage, "core");
  if (existsSync(join(core, "package.json"))) return core;
  tsc(
    "-p",
    join(coreRoot, "tsconfig.build.json"),
    "--emitDeclarationOnly",
    "--outDir",
    join(core, "dist"),
  );
  cpSync(join(coreRoot, "package.json"), join(core, "package.json"));
  symlinkSync(join(coreRoot, "node_modules"), join(core, "node_modules"), "junction");
  return core;
}

/**
 * Builds a pack as a pack outside this repository is: against core's emitted declarations (the
 * `types` export condition), the pack's src compiled to `dist/`, and for this pack its `build.gd`
 * beside it, where `src/scratch.ts` reads the build script. The pack compiles with this pack's
 * dependencies (TypeScript and Node's types). Returns the pack's directory under `stage`.
 */
export function buildPack(stage: string, root: string = pkgRoot): string {
  const core = buildCore(stage);
  const short = basename(root);
  const build = join(stage, `build-${short}`);
  cpSync(join(root, "src"), join(build, "src"), { recursive: true });
  for (const file of ["package.json", "tsconfig.json", "tsconfig.build.json"])
    cpSync(join(root, file), join(build, file));
  mkdirSync(join(build, "node_modules", "@clockgrove"), { recursive: true });
  for (const entry of readdirSync(join(pkgRoot, "node_modules")))
    if (entry !== "@clockgrove")
      symlinkSync(
        join(pkgRoot, "node_modules", entry),
        join(build, "node_modules", entry),
        "junction",
      );
  symlinkSync(core, join(build, "node_modules", "@clockgrove", "assetgrove"), "junction");
  const pack = join(stage, `pack-${short}`);
  tsc("-p", join(build, "tsconfig.build.json"), "--outDir", join(pack, "dist"));
  cpSync(join(root, "package.json"), join(pack, "package.json"));
  if (existsSync(join(root, "src", "build.gd")))
    cpSync(join(root, "src", "build.gd"), join(pack, "dist", "build.gd"));
  return pack;
}

/** The pack's own dependencies, which the installed copy resolves through a link. */
export const packNodeModules = join(pkgRoot, "node_modules");
