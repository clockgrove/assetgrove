/**
 * The read-only doctor of a Godot project: orphan and duplicate UIDs, a tracked `.godot/` cache,
 * and text files Git stores as LFS objects. It reads only through core's `list`, `read`, `tracked`
 * and `lfs`, and writes nothing.
 */
import type { DoctorContext, DoctorFinding, TargetRead } from "@clockgrove/assetgrove/extension";
import { headerAttribute, importUid, textHeaderUid } from "./godot-text.ts";

const decoder = new TextDecoder();
const LFS_POINTER = "version https://git-lfs.github.com/spec/v1";
const LFS_TEXT = /\.(import|uid|tres|tscn|gd|gdshader)$/;
const SCENE_OR_RESOURCE = /\.(tscn|tres)$/;

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function readOrUndefined(read: TargetRead, path: string): Promise<Uint8Array | undefined> {
  try {
    return await read(path);
  } catch {
    return undefined;
  }
}

const sidecarUid = (content: Uint8Array): string | undefined => {
  const uid = decoder.decode(content).trim();
  return /^uid:\/\/[0-9a-z]+$/.test(uid) ? uid : undefined;
};

const isPointer = (content: Uint8Array) =>
  decoder.decode(content.subarray(0, LFS_POINTER.length)) === LFS_POINTER;

/**
 * The `.gitattributes` in the file's own folder and the file's name as a pattern there: anchored,
 * a space escaped. Git lets a deeper `.gitattributes` override a shallower one, so a line in the
 * file's own folder wins over a rule from any folder above it.
 */
const gitattributesFor = (path: string) => {
  const slash = path.lastIndexOf("/");
  return {
    file: `${path.slice(0, slash + 1)}.gitattributes`,
    pattern: `/${path.slice(slash + 1).replaceAll(" ", "[[:space:]]")}`,
  };
};

export async function godotDoctor(
  ctx: DoctorContext,
  project: string,
  read: TargetRead,
): Promise<DoctorFinding[]> {
  const prefix = project === "" ? "" : `${project}/`;
  const files = (await ctx.list(project))
    .map((entry) => entry.path)
    .filter((path) => {
      const inside = path.slice(prefix.length);
      return path.startsWith(prefix) && inside !== ".godot" && !inside.startsWith(".godot/");
    })
    .sort(order);
  if (!files.includes(`${prefix}project.godot`)) return [];

  const present = new Set(files);
  const findings: DoctorFinding[] = [];
  const contents = new Map<string, Uint8Array>();
  const load = async (path: string) => {
    if (!contents.has(path)) {
      const bytes = await readOrUndefined(read, path);
      if (bytes !== undefined) contents.set(path, bytes);
    }
    return contents.get(path);
  };
  // The listing holds regular files only; a link to a file still answers a read. A read the
  // target refuses is no proof the file is missing.
  const exists = async (path: string) => {
    if (present.has(path)) return true;
    try {
      return (await read(path)) !== undefined;
    } catch {
      return true;
    }
  };
  /**
   * Whether the UID `path` answers to cannot be known here: its `.import`, `.uid` or text header
   * is unreadable or an LFS pointer, or it is a binary `.res` or `.scn` with its UID inside.
   */
  const uidUnknowable = async (path: string) => {
    const holder = present.has(`${path}.import`)
      ? `${path}.import`
      : present.has(`${path}.uid`)
        ? `${path}.uid`
        : SCENE_OR_RESOURCE.test(path)
          ? path
          : undefined;
    if (holder === undefined) return /\.(res|scn)$/.test(path);
    const content = await load(holder);
    return content === undefined || isPointer(content);
  };

  // Which files define which UID, and the UID each project file answers to.
  const definers = new Map<string, string[]>();
  const uidOfFile = new Map<string, string>();
  const define = (uid: string, file: string, owner: string) => {
    definers.set(uid, [...(definers.get(uid) ?? []), file]);
    uidOfFile.set(owner, uid);
  };
  for (const file of files) {
    const isImport = file.endsWith(".import");
    const isSidecar = file.endsWith(".uid");
    if (!isImport && !isSidecar && !SCENE_OR_RESOURCE.test(file)) continue;
    const content = await load(file);
    if (content === undefined) continue;
    if (isImport) {
      const uid = importUid(content);
      if (uid !== undefined) define(uid, file, file.slice(0, -".import".length));
    } else if (isSidecar) {
      const uid = sidecarUid(content);
      if (uid !== undefined) define(uid, file, file.slice(0, -".uid".length));
    } else {
      const uid = textHeaderUid(content);
      if (uid !== undefined) define(uid, file, file);
    }
  }

  // 1a, 1b: a sidecar or `.import` whose source is gone.
  for (const file of files) {
    for (const [suffix, what] of [
      [".uid", "UID sidecar"],
      [".import", "import file"],
    ] as const) {
      if (!file.endsWith(suffix)) continue;
      const source = file.slice(0, -suffix.length);
      if (await exists(source)) continue;
      findings.push({
        code: "orphan-uid",
        path: file,
        problem: `${file} is a ${what} whose source ${source} is missing, so its UID belongs to nothing.`,
        correction: `delete ${file}; if ${source} was moved or renamed, move ${file} beside it instead so its UID stays the same`,
      });
    }
  }

  // 1c: an ext_resource whose UID no file of the project defines.
  for (const file of files) {
    if (!SCENE_OR_RESOURCE.test(file)) continue;
    const content = contents.get(file);
    if (content === undefined) continue;
    const lines = decoder.decode(content).split(/\r?\n/);
    for (const [index, text] of lines.entries()) {
      if (!text.startsWith("[ext_resource")) continue;
      const uid = headerAttribute(text, "uid");
      if (uid === undefined || uid === "" || definers.has(uid)) continue;
      const line = index + 1;
      const path = headerAttribute(text, "path");
      const resolved =
        path !== undefined && path.startsWith("res://")
          ? `${prefix}${path.slice("res://".length)}`
          : undefined;
      const found = resolved !== undefined && (await exists(resolved));
      // The file is there but its UID cannot be read, so the reference may well be right.
      if (found && (await uidUnknowable(resolved))) continue;
      let correction: string;
      if (!found) {
        correction = `the reference is broken: ${path ?? "it has no path"} is not in the project; point it at the file that replaced it in the Godot editor, or remove the [ext_resource] line and the ExtResource uses of its id`;
      } else {
        const actual = uidOfFile.get(resolved);
        correction =
          actual === undefined
            ? `remove the uid="${uid}" attribute on line ${line} of ${file} so Godot loads ${path} by path`
            : `change uid="${uid}" to uid="${actual}" on line ${line} of ${file}, or open and re-save ${file} in the Godot editor`;
      }
      findings.push({
        code: "orphan-uid",
        path: file,
        line,
        problem: `${file} line ${line} references ${uid}, which no file of the project defines.`,
        correction,
      });
    }
  }

  // 1d: one UID defined by several files.
  for (const [uid, owners] of definers) {
    const sorted = [...owners].sort(order);
    for (const file of sorted.slice(1)) {
      findings.push({
        code: "duplicate-uid",
        path: file,
        problem: `${file} defines ${uid}, which ${sorted[0]} already defines; Godot resolves a UID to only one of them.`,
        correction: file.endsWith(".import")
          ? `give the copy a new UID: remove only the line uid="${uid}" under [remap] in ${file}, keeping its other import options, then reimport ${file.slice(0, -".import".length)} in the Godot editor, which writes a new UID`
          : file.endsWith(".uid")
            ? `give the copy a new UID: delete ${file} and let the Godot editor generate a new one the next time it opens the project`
            : `give the copy a new UID: re-save ${file} with "Save As" in the Godot editor, or reimport it`,
      });
    }
  }

  // 2: Godot's cache folder under Git.
  const cache = `${prefix}.godot`;
  const cached = await ctx.tracked(cache);
  if (cached.length > 0) {
    const ignores = await readOrUndefined(read, `${prefix}.gitignore`);
    const ignored =
      ignores !== undefined &&
      decoder
        .decode(ignores)
        .split(/\r?\n/)
        .some((line) => ["/.godot/", ".godot/", "/.godot", ".godot"].includes(line.trim()));
    const examples = cached.slice(0, 3).join(", ");
    const more = cached.length > 3 ? ", ..." : "";
    findings.push({
      code: "tracked-engine-cache",
      path: cache,
      problem: `Git tracks ${cached.length} ${cached.length === 1 ? "file" : "files"} of Godot's cache folder ${cache} (${examples}${more}); the editor regenerates it, so it churns and conflicts.`,
      correction: ignored
        ? `run git rm -r --cached -- ${cache} (it keeps the files on disk), then commit`
        : `run git rm -r --cached -- ${cache} (it keeps the files on disk) and add .godot/ to ${prefix}.gitignore, then commit`,
    });
  }

  // 3: text Godot reads, stored as an LFS object.
  const texts = files.filter((f) => LFS_TEXT.test(f) || f === `${prefix}project.godot`);
  const routed = new Set(await ctx.lfs(texts));
  for (const file of texts) {
    const content = await load(file);
    const pointer = content !== undefined && isPointer(content);
    if (!routed.has(file) && !pointer) continue;
    const attributes = gitattributesFor(file);
    const attribute = `${attributes.pattern} -filter -diff -merge text`;
    const store = `add the line "${attribute}" to the end of ${attributes.file} (create it if it is missing; a line in the file's own folder overrides every .gitattributes above it), so Git stores it as text again, then run git add --renormalize -- ${file} and commit`;
    findings.push({
      code: "lfs-text-resource",
      path: file,
      problem: `${file} is ${pointer ? "an LFS pointer in the work tree" : "routed to Git LFS"}, but Godot reads it as text; as an LFS object it diffs and merges as binary, and a clone without LFS gets a pointer Godot cannot parse.`,
      correction: pointer
        ? `run git lfs pull --include="${file}" to restore its contents (or restore it from Godot), then ${store}`
        : store,
    });
  }

  return findings.sort(
    (a, b) => order(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || order(a.code, b.code),
  );
}
