import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  SearchContext,
  SearchLibrary,
  SearchSettings,
} from "@clockgrove/assetgrove/extension";
import { folderLibrary } from "./library.ts";
import { tempDir } from "./fixture.ts";

/** One file per source folder; the scripted embedder reads each file's bytes as its caption. */
export const PROJECT: Record<string, { caption: string; card: Record<string, unknown> }> = {
  "pick/lantern.png": {
    caption: "red lantern glowing on a wooden porch",
    card: { kind: "sprite", title: "Porch lantern", text: "A red lantern by the door." },
  },
  "pick/bridge.png": {
    caption: "stone bridge over a river at dawn",
    card: { kind: "tile", title: "Stone bridge", text: "An old stone bridge." },
  },
  "reference/crystal.png": {
    caption: "blue crystal cluster inside a dark cave",
    card: { kind: "tile", title: "Cave crystal", text: "Blue crystals in a cave." },
  },
  "candidate/lamp.png": {
    caption: "yellow street lamp at night",
    card: { kind: "sprite", title: "Street lamp", text: "A yellow street lamp." },
  },
  "folder/forest.png": {
    caption: "concept painting of a misty forest",
    card: { kind: "concept", title: "Forest concept", text: "A misty forest." },
  },
};

export interface ProjectState {
  head: string;
  clean: boolean;
  origin?: string;
  /** What `changedSince` answers for a commit other than `head`; without it, the method is absent. */
  changed?: boolean;
}

export async function writeProject(root: string): Promise<void> {
  for (const [path, f] of Object.entries(PROJECT)) {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.caption);
    await writeFile(abs.replace(/\.png$/, ".card.json"), JSON.stringify(f.card));
  }
}

/** A search library over a folder: the first path segment is the source. */
export function projectLibrary(root: string, state: ProjectState): SearchLibrary {
  const inner = folderLibrary(root);
  return {
    async list(sources) {
      const items = (await inner.list()).map((i) => ({
        ...i,
        source: i.path.split("/")[0] as SearchLibrary extends never ? never : typeof i.source,
      }));
      return sources ? items.filter((i) => sources.includes(i.source)) : items;
    },
    load: (item) => inner.load(item),
    head: async () => state.head,
    clean: async () => state.clean,
    origin: async () => state.origin ?? "root-1",
    ...(state.changed !== undefined && {
      changedSince: async (commit: string) => commit !== state.head && state.changed === true,
    }),
  };
}

export interface Project {
  root: string;
  stateDir: string;
  state: ProjectState;
  context(overrides?: Partial<SearchSettings>, state?: ProjectState): SearchContext;
}

export async function makeProject(): Promise<Project> {
  const root = await tempDir("project");
  const stateDir = await tempDir("state");
  await writeProject(root);
  const state: ProjectState = { head: "head-1", clean: true };
  return {
    root,
    stateDir,
    state,
    context(overrides = {}, own = state) {
      return {
        stateDir,
        worktree: root,
        game: "demo",
        settings: {
          embedder: "scripted",
          model: "siglip2-base",
          candidates: true,
          nearMatch: true,
          folders: [],
          ...overrides,
        },
        library: projectLibrary(root, own),
        env: {},
        log: () => undefined,
      };
    },
  };
}
