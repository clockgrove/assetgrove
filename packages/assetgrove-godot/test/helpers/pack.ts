import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
const coreRoot = fileURLToPath(new URL("../../../..", import.meta.url));

/**
 * Builds the pack as a pack outside this repository is: against core's emitted declarations (the
 * `types` export condition), the pack's src compiled to `dist/`, and its `build.gd` beside
 * it, where `src/scratch.ts` reads the build script. Returns the pack's directory under `stage`.
 */
export function buildPack(stage: string): string {
  const tsc = (...args: string[]) =>
    execFileSync(
      process.execPath,
      [join(pkgRoot, "node_modules", "typescript", "bin", "tsc"), ...args],
      { stdio: "inherit" },
    );
  const core = join(stage, "core");
  tsc(
    "-p",
    join(coreRoot, "tsconfig.build.json"),
    "--emitDeclarationOnly",
    "--outDir",
    join(core, "dist"),
  );
  cpSync(join(coreRoot, "package.json"), join(core, "package.json"));
  symlinkSync(join(coreRoot, "node_modules"), join(core, "node_modules"), "junction");
  const build = join(stage, "build");
  cpSync(join(pkgRoot, "src"), join(build, "src"), { recursive: true });
  for (const file of ["package.json", "tsconfig.json", "tsconfig.build.json"])
    cpSync(join(pkgRoot, file), join(build, file));
  mkdirSync(join(build, "node_modules", "@clockgrove"), { recursive: true });
  for (const entry of readdirSync(join(pkgRoot, "node_modules")))
    if (entry !== "@clockgrove")
      symlinkSync(
        join(pkgRoot, "node_modules", entry),
        join(build, "node_modules", entry),
        "junction",
      );
  symlinkSync(core, join(build, "node_modules", "@clockgrove", "assetgrove"), "junction");
  const pack = join(stage, "pack");
  tsc("-p", join(build, "tsconfig.build.json"), "--outDir", join(pack, "dist"));
  cpSync(join(pkgRoot, "package.json"), join(pack, "package.json"));
  cpSync(join(pkgRoot, "src", "build.gd"), join(pack, "dist", "build.gd"));
  return pack;
}

/** The pack's own dependencies, which the installed copy resolves through a link. */
export const packNodeModules = join(pkgRoot, "node_modules");
