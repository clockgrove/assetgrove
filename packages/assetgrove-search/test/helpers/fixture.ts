import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SearchIndex } from "../../src/find.ts";
import { CountingEmbedder, folderLibrary } from "./library.ts";

export interface FixtureFile {
  /** The scripted embedder reads a file's bytes as its caption. */
  caption: string;
  card?: Record<string, unknown>;
}

/** A small library: varied card fields, a two-view turntable, and awkward literal values. */
export const LIBRARY: Record<string, FixtureFile> = {
  "sprites/lantern-porch.png": {
    caption: "red lantern glowing on a wooden porch",
    card: {
      kind: "sprite",
      subject: "lantern",
      tags: ["light", "prop"],
      state: "approved",
      bible: "village",
      license: "CC0-1.0",
      title: "Porch lantern",
      text: "Porch lantern. A red lantern hanging by the door of a wooden porch.",
    },
  },
  "sprites/crystal-cave.png": {
    caption: "blue crystal cluster inside a dark cave",
    card: {
      kind: "sprite",
      subject: "crystal",
      tags: ["gem"],
      state: "pending",
      bible: "caves",
      license: "CC-BY-4.0",
      title: "Cave crystal",
      text: "Cave crystal. A cluster of blue crystals.",
    },
  },
  "tiles/stone-bridge.png": {
    caption: "stone bridge over a river at dawn",
    card: {
      kind: "tile",
      subject: "bridge",
      tags: [],
      state: "approved",
      bible: "village",
      license: "CC0-1.0",
      title: "Stone bridge",
      text: "Stone bridge. An old stone bridge crossing a river.",
    },
  },
  "models/lantern-turntable.png": {
    caption: "turntable of a brass lantern",
    card: {
      kind: "model",
      subject: "lantern",
      tags: ["light"],
      state: "changes-requested",
      bible: "village",
      license: "CC0-1.0",
      title: "Brass lantern",
      text: "Brass lantern model, three views.",
      views: {
        front: "brass lantern front view",
        side: "brass lantern side view glowing red",
        back: "brass lantern back view",
      },
    },
  },
  "sprites/quoted.png": {
    caption: "a signpost with painted words",
    card: {
      kind: "sprite",
      subject: `it's "x"; DROP TABLE rows; --`,
      tags: ["o'brien", "sign"],
      state: "pending",
      bible: "village",
      license: "CC0-1.0",
      title: "x' OR '1'='1",
      text: "A wooden signpost.",
    },
  },
  "folders/concept-forest.png": {
    caption: "concept painting of a misty forest",
    card: {
      source: "folder",
      game: "other",
      title: "Forest concept",
      text: "A misty forest at night.",
    },
  },
};

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `ag-search-${prefix}-`));
}

export async function writeFixture(root: string, files: Record<string, FixtureFile>) {
  for (const [path, f] of Object.entries(files)) {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.caption);
    if (f.card) await writeFile(abs.replace(/\.png$/, ".card.json"), JSON.stringify(f.card));
  }
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

/** A Git repository holding the fixture library on `main`. */
export async function fixtureRepo(files = LIBRARY): Promise<string> {
  const root = await tempDir("repo");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  await writeFixture(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

export async function openIndex(
  storeDir: string,
  worktree: string,
  embedder = new CountingEmbedder(),
) {
  const index = await SearchIndex.open({
    dir: storeDir,
    embedder,
    library: folderLibrary(worktree),
    worktree,
  });
  return { index, embedder };
}

/** Every file under a folder with its size and mtime: equal snapshots mean nothing was written. */
export async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    const s = await stat(join(dir, name));
    // Listed with `/` on every system, so a caller can match a path the same way everywhere.
    out.push(`${name.replaceAll("\\", "/")} ${s.isDirectory() ? "d" : s.size} ${s.mtimeMs}`);
  }
  return out;
}

export const cleanup = (...dirs: string[]) =>
  Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
