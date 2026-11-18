import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { GODOT_RELEASE } from "../../src/setup.ts";

/** The names a Godot 4.7.2 executable goes by on PATH: setup-godot's link, then the release's own. */
function names(platform: string): string[] {
  const release = Object.values(GODOT_RELEASE.platforms).map((p) => p.binary.split("/").pop()!);
  // On Windows a file runs only with an extension; setup-godot's extensionless link does not.
  const all =
    platform === "win32"
      ? ["godot.exe", ...release.filter((n) => n.endsWith(".exe"))]
      : ["godot", ...release.filter((n) => !n.endsWith(".exe"))];
  return [...new Set(all)];
}

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

/**
 * The Godot 4.7.2 the tests run: the first executable on PATH by one of its names whose
 * `--version` is 4.7.2. Otherwise `skip` says why the Godot tests do not run.
 */
export function findGodot(): { godot?: string; skip?: string } {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((d) => d !== "");
  const found: string[] = [];
  for (const dir of dirs)
    for (const name of names(process.platform)) {
      const path = join(dir, name);
      if (!isFile(path)) continue;
      const version = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 60_000 });
      const text = `${version.stdout ?? ""}`.trim();
      if (text.startsWith(`${GODOT_RELEASE.version}.`)) return { godot: path };
      found.push(`${path} (${text || "no version"})`);
    }
  return {
    skip:
      found.length === 0
        ? `no Godot ${GODOT_RELEASE.version} on PATH (${names(process.platform).join(", ")})`
        : `no Godot ${GODOT_RELEASE.version} on PATH; found ${found.join(", ")}`,
  };
}
