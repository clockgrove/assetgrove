/**
 * The library reader core supplies to the search package (design section 7.1): every indexable
 * file of the project with its card fields, loaded on demand. Picks follow the library path rule
 * and LFS pointer handling; core never imports the search package.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseBible, bibleReferences } from "../bible.ts";
import { InputError } from "../errors.ts";
import type {
  SearchLibrary,
  SearchLibraryItem,
  SearchLoadedItem,
  SearchSource,
} from "../extension/api.ts";
import { decodeImage } from "../image/raster.ts";
import { BIBLE_PATH } from "../init.ts";
import { findGitDir, readMedia } from "../library/lfs.ts";
import type { SearchSettings } from "../settings.ts";
import { loadAssets, mediaPath, openProject } from "../tree/project.ts";
import type { Project } from "../tree/project.ts";
import { runCandidateFiles, runIds } from "../tree/read.ts";

const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif)$/i;
const ALL: readonly SearchSource[] = ["pick", "reference", "candidate", "folder"];

export type LibraryReader = SearchLibrary & {
  game: string;
  /** The bytes of a path the reader lists; undefined for any other path or an unreadable file. */
  loadImageByPath(path: string): Promise<Uint8Array | undefined>;
  changedSince(commit: string): Promise<boolean>;
};

const slash = (path: string) => path.split(sep).join("/");

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function stat(path: string): { size: number; mtimeMs: number } | undefined {
  try {
    const s = statSync(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

function git(dir: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

function* walk(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* walk(path);
    else if (e.isFile()) yield path;
  }
}

/**
 * Opens the reader for the project at `dir`. An asset whose card path leaves the library root, or
 * whose media file is missing, is left out of `list()`, so `load()` refuses its path.
 */
export async function createLibraryReader(options: {
  dir: string;
  stateDir: string;
  settings: Pick<SearchSettings, "folders" | "candidates">;
}): Promise<LibraryReader> {
  const project: Project = await openProject(options.dir, options.stateDir);
  const { game } = project.library;
  const known = new Map<string, string>();

  const base = (
    source: SearchSource,
    abs: string,
    path: string,
    id: string,
    address: string,
  ): SearchLibraryItem | undefined => {
    const s = stat(abs);
    if (!s) return undefined;
    known.set(path, abs);
    return { path, size: s.size, mtimeMs: s.mtimeMs, source, id, address };
  };
  const rel = (abs: string) => slash(relative(project.dir, abs));

  function picks(): SearchLibraryItem[] {
    const out: SearchLibraryItem[] = [];
    for (const asset of loadAssets(project).values()) {
      let abs: string;
      try {
        abs = mediaPath(project, asset);
      } catch (error) {
        if (error instanceof InputError) continue;
        throw error;
      }
      const item = base("pick", abs, rel(abs), asset.id, `asset://${game}/${asset.id}`);
      if (!item) continue;
      const data = asset.card.data as Record<string, unknown>;
      const str = (k: string) =>
        typeof data[k] === "string" && data[k] !== "" ? (data[k] as string) : undefined;
      const title = str("title");
      const description = str("description");
      const text = [
        title,
        description,
        ...asset.tags,
        asset.kind,
        asset.subject,
        asset.card.body.trim(),
      ]
        .filter((t): t is string => typeof t === "string" && t !== "")
        .join("\n");
      const license = str("license");
      out.push({
        ...item,
        game,
        ...(asset.kind && { kind: asset.kind }),
        ...(asset.subject && { subject: asset.subject }),
        tags: asset.tags,
        ...(asset.state && { state: asset.state }),
        ...(asset.bible && { bible: asset.bible }),
        ...(license && { license }),
        ...(title && { title }),
        ...(description && { description }),
        text,
      });
    }
    return out;
  }

  /** The bible's references inside the project, listed or not, each with its project path. */
  function bibleRefs(): { path: string; abs: string; role: string; subject?: string }[] {
    const biblePath = join(project.dir, BIBLE_PATH);
    if (!existsSync(biblePath)) return [];
    let refs;
    try {
      refs = bibleReferences(parseBible(readFileSync(biblePath, "utf8")).data);
    } catch {
      return [];
    }
    return refs.flatMap((ref) => {
      const abs = resolve(dirname(biblePath), ref.path);
      return inside(project.dir, abs) ? [{ ...ref, abs, path: rel(abs) }] : [];
    });
  }

  function references(): SearchLibraryItem[] {
    const out: SearchLibraryItem[] = [];
    const seen = new Set<string>();
    for (const ref of bibleRefs()) {
      const { abs, path } = ref;
      if (seen.has(path)) continue;
      const item = base("reference", abs, path, path, `asset://${game}/references/${path}`);
      if (!item) continue;
      seen.add(path);
      out.push({ ...item, game, text: [ref.role, ref.subject].filter(Boolean).join("\n") });
    }
    return out;
  }

  function candidates(): SearchLibraryItem[] {
    const out: SearchLibraryItem[] = [];
    for (const run of runIds(project)) {
      for (const c of runCandidateFiles(project, run)) {
        const item = base(
          "candidate",
          c.file,
          rel(c.file),
          `${run}/${c.id}`,
          `asset://${game}/runs/${run}/${c.id}`,
        );
        if (item) out.push({ ...item, game });
      }
    }
    return out;
  }

  function folders(): SearchLibraryItem[] {
    const out: SearchLibraryItem[] = [];
    for (const folder of options.settings.folders) {
      for (const abs of walk(folder)) {
        if (!IMAGE_EXTENSION.test(abs)) continue;
        const item = base("folder", abs, abs, abs, pathToFileURL(abs).href);
        if (item) out.push(item);
      }
    }
    return out;
  }

  async function list(sources: readonly SearchSource[] = ALL): Promise<SearchLibraryItem[]> {
    const want = new Set(sources);
    return [
      ...(want.has("pick") ? picks() : []),
      ...(want.has("reference") ? references() : []),
      ...(want.has("candidate") && options.settings.candidates ? candidates() : []),
      ...(want.has("folder") ? folders() : []),
    ];
  }

  async function bytesOf(path: string): Promise<Uint8Array | { pointer: string } | undefined> {
    if (!known.has(path)) await list();
    const abs = known.get(path);
    if (abs === undefined) return undefined;
    const media = await readMedia(abs, { gitDir: findGitDir(dirname(abs)) });
    return media.kind === "lfs-pointer" ? { pointer: media.pointer.oid } : media.bytes;
  }

  async function load(item: SearchLibraryItem): Promise<SearchLoadedItem> {
    const got = await bytesOf(item.path);
    if (got === undefined) {
      throw new InputError(`${item.path} is not a file the library reader lists`);
    }
    if (!(got instanceof Uint8Array)) {
      return { bytes: new TextEncoder().encode(`lfs:${got.pointer}`), views: [] };
    }
    try {
      decodeImage(got);
    } catch {
      return { bytes: got, views: [] };
    }
    return { bytes: got, views: [{ view: "", image: got }] };
  }

  return {
    game,
    list,
    load,
    async head() {
      const r = git(project.dir, ["rev-parse", "HEAD"]);
      return r.ok ? r.out.trim() : "";
    },
    async origin() {
      const shallow = git(project.dir, ["rev-parse", "--is-shallow-repository"]);
      if (!shallow.ok || shallow.out.trim() !== "false") return "";
      const r = git(project.dir, ["rev-list", "--max-parents=0", "HEAD"]);
      return r.ok ? r.out.split(/\s+/).filter(Boolean).sort().join(" ") : "";
    },
    async clean() {
      const root = slash(relative(project.dir, project.library.root)) || ".";
      const r = git(project.dir, ["status", "--porcelain", "--untracked-files=all", "--", root]);
      return r.ok && r.out.trim() === "";
    },
    async changedSince(commit) {
      // The shared index holds picks (under the library root) and the bible's references, so a
      // commit touching anything else, such as code, leaves it as fresh as it was.
      const head = git(project.dir, ["rev-parse", "HEAD"]);
      if (!head.ok || commit === "") return true;
      if (head.out.trim() === commit) return false;
      const paths = new Set([
        slash(relative(project.dir, project.library.root)) || ".",
        BIBLE_PATH,
        ...bibleRefs().map((r) => r.path),
      ]);
      const r = spawnSync("git", ["diff", "--quiet", commit, "HEAD", "--", ...paths], {
        cwd: project.dir,
      });
      // 0: no difference; 1: a difference; anything else (an unknown commit): cannot tell.
      return r.status !== 0;
    },
    async loadImageByPath(path) {
      try {
        const got = await bytesOf(path);
        return got instanceof Uint8Array ? got : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
