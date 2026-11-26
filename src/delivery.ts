/**
 * Delivery planning and writing (issue #478): a selection file names picked asset versions and the
 * recipes that turn each into project renditions. The plan resolves every item to its exact
 * mezzanine bytes (the media file, a Git LFS pointer's object or the local LFS store, never a fetch
 * and never Git), plans the renditions through `buildRendition` in preview, and checks the whole
 * set for missing objects and output collisions before a single file is written. A real delivery
 * writes the outputs and then `delivery.json`, which links each output to its mezzanine and
 * recipe. The manifest holds no time and no absolute path, so repeating a selection reproduces
 * the same files. The library and its review records are only read; a version is staged in a
 * temporary folder so no sidecar of the current pick is applied to an older version.
 * A release delivery (neither `preview` nor `draft`) is also the release gate (issue #479): a
 * selected placeholder, and what the profile's `release` policy refuses, is a problem; a preview
 * or a draft reports the same release findings without refusing on them.
 */
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { InputError } from "./errors.ts";
import { readFormat } from "./formats.ts";
import { locateAsset, loadAsset, selectVersion } from "./library/actions.ts";
import { sha256Hex } from "./library/canonical.ts";
import { findGitDir, lfsObjectPath, readMedia } from "./library/lfs.ts";
import { parseDigitalSourceType } from "./metadata.ts";
import type { DigitalSourceType } from "./metadata.ts";
import { checkWrites } from "./paths.ts";
import { evaluateRelease } from "./release-policy.ts";
import type { ReleaseCheck, ReleaseFinding, ReleasePolicy } from "./release-policy.ts";
import type { ContentSigner } from "./credentials.ts";
import { buildRendition } from "./transform/rendition.ts";
import type { RunOptions } from "./transform/run.ts";

export interface DeliveryOptions extends Pick<RunOptions, "style" | "frame" | "engines"> {
  /** The selection JSON file. */
  selection: string;
  /** The delivery root directory. */
  out: string;
  /** A dry run: never writes and never creates a directory. */
  preview?: boolean;
  /** A draft: written like a release but never refused on, or presented as, a release. */
  draft?: boolean;
  /** The target profile's `release` section; the placeholder check applies without one. */
  policy?: ReleasePolicy;
  /** The time licence windows are checked at; now by default. */
  now?: Date;
  /** Signs an Ogg rendition's C2PA sidecar; by default as `buildRendition` signs. */
  signer?: ContentSigner;
}

export type DeliveryProblemCode =
  | "asset_missing"
  | "version_missing"
  | "object_missing"
  | "recipe_missing"
  | "item_invalid"
  | "output_collision"
  | "placeholder_selected"
  | "version_unapproved"
  | "license_window";

/** The problem a failed release check is, in a release delivery. */
const RELEASE_PROBLEMS: Record<ReleaseCheck, DeliveryProblemCode> = {
  placeholder: "placeholder_selected",
  approval: "version_unapproved",
  "license-window": "license_window",
};

export interface DeliveryProblem {
  /** The 0-based index of the selection item. */
  item: number;
  file?: string;
  code: DeliveryProblemCode;
  message: string;
}

export interface DeliveryOutput {
  path: string;
  sha256: string;
  mediaType: string;
  size: number;
  digitalSourceType: string;
  /** An Ogg rendition's C2PA sidecar manifest, written beside it. */
  contentCredentials?: { path: string; sha256: string; size: number };
}

export interface DeliveryItem {
  asset: string;
  version: number;
  mezzanine: { sha256: string; mediaType: string };
  recipe: { name: string; sha256: string };
  digest: string;
  build: unknown;
  outputs: DeliveryOutput[];
}

export interface DeliveryManifest {
  format: "assetgrove-delivery-manifest/1";
  /** Present on a draft delivery, which is not a release. */
  draft?: true;
  items: DeliveryItem[];
}

/** An item as far as it resolved; complete items carry everything the manifest lists. */
export type DeliveryResultItem = (DeliveryItem & { item: number }) | PartialItem;
interface PartialItem {
  item: number;
  asset?: string;
  version?: number;
  sha256?: string;
}

export interface DeliveryResult {
  preview: boolean;
  draft: boolean;
  /** True only for a release delivery that passed every check and was written. */
  release: boolean;
  /** Every release check of every item whose version resolved, passed or failed. */
  policy: ReleaseFinding[];
  out: string;
  manifestPath: string;
  manifest: DeliveryManifest;
  items: DeliveryResultItem[];
  problems: DeliveryProblem[];
  written: boolean;
}

interface Entry {
  item: number;
  rel: string;
  bytes: Uint8Array;
}

interface SelectionItem {
  asset: string;
  version: string;
  recipe: string;
  to: string;
  name?: string;
  digitalSourceType?: DigitalSourceType;
}

function text(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || value === "") {
    throw new InputError(`${where}: "${field}" must be a non-empty string`);
  }
  return value;
}

function safeTo(to: string, where: string): string {
  if (to === ".") return ".";
  if (
    to.startsWith("/") ||
    /^[A-Za-z]:/.test(to) ||
    to.includes("\\") ||
    to.split("/").some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new InputError(`${where}: "to" must be a relative folder without "..": ${to}`);
  }
  return to;
}

function parseSelection(value: unknown, source: string) {
  const { value: selection } = readFormat("delivery", value, source);
  const recipes = text(selection["recipes"], "recipes", source);
  const raw = selection["items"];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InputError(`${source}: "items" must be a non-empty array`);
  }
  const items = raw.map((entry: unknown, i): SelectionItem => {
    const where = `${source} item ${i + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new InputError(`${where} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const version = e["version"];
    if (
      !(typeof version === "number" && Number.isInteger(version) && version > 0) &&
      !(typeof version === "string" && version !== "")
    ) {
      throw new InputError(`${where}: "version" must be a stack number or a sha256`);
    }
    const item: SelectionItem = {
      asset: text(e["asset"], "asset", where),
      version: String(version),
      recipe: text(e["recipe"], "recipe", where),
      to: safeTo(text(e["to"], "to", where), where),
    };
    if (e["name"] !== undefined) item.name = text(e["name"], "name", where);
    if (e["digitalSourceType"] !== undefined) {
      item.digitalSourceType = parseDigitalSourceType(
        text(e["digitalSourceType"], "digitalSourceType", where),
      );
    }
    return item;
  });
  return { recipes, items };
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** The exact bytes of a version when they are here: the media file or the local LFS store. */
async function versionBytes(
  mediaPath: string,
  dir: string,
  sha256: string,
): Promise<Uint8Array | undefined> {
  try {
    const media = await readMedia(mediaPath);
    if ((media.kind === "file" || media.kind === "lfs-object") && media.sha256 === sha256) {
      return media.bytes;
    }
  } catch {
    // Fall through to the LFS store.
  }
  const gitDir = findGitDir(dir);
  if (gitDir === undefined) return undefined;
  const bytes = await readFile(lfsObjectPath(gitDir, sha256)).catch(() => undefined);
  return bytes !== undefined && sha256Hex(bytes) === sha256 ? new Uint8Array(bytes) : undefined;
}

/** Plans a delivery and, unless `preview`, writes it when no problem was found. */
export async function planDelivery(options: DeliveryOptions): Promise<DeliveryResult> {
  const selectionPath = resolve(options.selection);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(selectionPath, "utf8"));
  } catch (error) {
    throw new InputError(
      `cannot read selection ${options.selection}: ${(error as Error).message}`,
      {
        cause: error,
      },
    );
  }
  const { recipes, items } = parseSelection(value, options.selection);
  const base = dirname(selectionPath);
  const recipesDir = resolve(base, recipes);
  const out = resolve(options.out);
  const problems: DeliveryProblem[] = [];
  const policy: ReleaseFinding[] = [];
  const now = options.now ?? new Date();
  const gated = options.preview !== true && options.draft !== true;
  const resultItems: DeliveryResultItem[] = [];
  const entries: Entry[] = [];
  const stage = await mkdtemp(join(tmpdir(), "assetgrove-delivery-"));
  try {
    for (const [index, item] of items.entries()) {
      const problem = (code: DeliveryProblemCode, message: string, file?: string) =>
        problems.push({ item: index, ...(file !== undefined && { file }), code, message });
      const partial: PartialItem = { item: index };
      resultItems.push(partial);
      const cardPath = resolve(base, item.asset);
      let loaded;
      try {
        loaded = await loadAsset(locateAsset(cardPath));
      } catch (error) {
        problem("asset_missing", (error as Error).message, item.asset);
        continue;
      }
      partial.asset = loaded.assetId;
      let version;
      try {
        version = selectVersion(loaded.record, item.version);
      } catch (error) {
        problem("version_missing", `${item.asset}: ${(error as Error).message}`, item.asset);
        continue;
      }
      const stack = loaded.record.versions.indexOf(version) + 1;
      partial.version = stack;
      partial.sha256 = version.sha256;
      for (const finding of evaluateRelease(
        {
          item: index,
          asset: loaded.assetId,
          version: stack,
          sha256: version.sha256,
          record: loaded.record,
          card: loaded.card.data,
        },
        options.policy,
        now,
      )) {
        policy.push(finding);
        if (gated && finding.status === "failed") {
          problem(RELEASE_PROBLEMS[finding.check], finding.message, item.asset);
        }
      }
      const bytes = await versionBytes(loaded.mediaPath, loaded.dir, version.sha256);
      if (bytes === undefined) {
        problem(
          "object_missing",
          `${item.asset} version ${stack} (${version.sha256}): its bytes are not in the library or the local LFS store`,
          item.asset,
        );
        continue;
      }
      const recipeFile = join(recipesDir, `${item.recipe}.json`);
      if (!existsSync(recipeFile)) {
        problem("recipe_missing", `recipe ${item.recipe} not found at ${recipeFile}`, item.recipe);
        continue;
      }
      const staged = join(stage, `${index}-mezzanine.bin`);
      await writeFile(staged, bytes);
      let built;
      try {
        built = await buildRendition({
          recipes: recipesDir,
          recipe: item.recipe,
          source: staged,
          sourceSha256: version.sha256,
          out: join(stage, "out"),
          preview: true,
          name: item.name ?? loaded.assetId,
          // A sidecar already delivered is kept while it still holds for the same bytes, so a
          // repeated delivery writes the same files.
          existingSidecar: async (name) => {
            const rel = item.to === "." ? name : posix.join(item.to, name);
            const path = join(out, ...rel.split("/"));
            const found = await lstat(path).catch(() => undefined);
            return found?.isFile() ? new Uint8Array(await readFile(path)) : undefined;
          },
          ...(options.signer !== undefined && { signer: options.signer }),
          ...(item.digitalSourceType !== undefined && {
            digitalSourceType: item.digitalSourceType,
          }),
          ...(options.style !== undefined && { style: options.style }),
          ...(options.frame !== undefined && { frame: options.frame }),
          ...(options.engines !== undefined && { engines: options.engines }),
        });
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        problem("item_invalid", error.message, item.asset);
        continue;
      }
      const destination = (path: string) =>
        item.to === "." ? basename(path) : posix.join(item.to, basename(path));
      const outputs = built.record.outputs.map((output, i): DeliveryOutput => {
        const rel = destination(output.path);
        entries.push({ item: index, rel, bytes: built.files[i]!.bytes });
        const sidecar = built.sidecars.find((s) => s.output === i);
        if (sidecar !== undefined)
          entries.push({ item: index, rel: destination(sidecar.path), bytes: sidecar.bytes });
        return {
          path: rel,
          sha256: output.sha256,
          mediaType: output.mediaType,
          size: built.files[i]!.bytes.length,
          digitalSourceType: output.digitalSourceType,
          ...(sidecar !== undefined && {
            contentCredentials: {
              path: destination(sidecar.path),
              sha256: sha256Hex(sidecar.bytes),
              size: sidecar.bytes.length,
            },
          }),
        };
      });
      const rendition = built.record.rendition as { recipe: { sha256: string }; build: unknown };
      resultItems[index] = {
        item: index,
        asset: loaded.assetId,
        version: stack,
        mezzanine: { sha256: version.sha256, mediaType: built.record.sources[0]!.mediaType },
        recipe: { name: item.recipe, sha256: rendition.recipe.sha256 },
        digest: built.digest,
        build: rendition.build,
        outputs,
      };
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  const complete = resultItems.filter((r): r is DeliveryItem & { item: number } => "outputs" in r);
  const manifest: DeliveryManifest = {
    format: "assetgrove-delivery-manifest/1",
    ...(options.draft === true && { draft: true as const }),
    items: complete.map(({ item: _item, ...rest }) => rest),
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestEntry: Entry = { item: -1, rel: "delivery.json", bytes: manifestBytes };
  await collisions([...entries, manifestEntry], out, problems);

  const written = problems.length === 0 && options.preview !== true;
  if (written) {
    await mkdir(out, { recursive: true });
    for (const entry of [...entries, manifestEntry]) {
      const path = join(out, ...entry.rel.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.bytes);
    }
  }
  return {
    preview: options.preview ?? false,
    draft: options.draft ?? false,
    release: gated && written,
    policy,
    out,
    manifestPath: join(out, "delivery.json"),
    manifest,
    items: resultItems,
    problems,
    written,
  };
}

const label = (entry: Entry) => (entry.item < 0 ? "delivery.json" : `item ${entry.item + 1}`);

/** Collects clashes among planned paths and with what already lies at the destinations. */
async function collisions(entries: Entry[], out: string, problems: DeliveryProblem[]) {
  const seen = new Map<string, Entry>();
  for (const entry of entries) {
    const add = (message: string) =>
      problems.push({
        item: Math.max(entry.item, 0),
        file: entry.rel,
        code: "output_collision",
        message,
      });
    try {
      checkWrites([entry.rel]);
    } catch (error) {
      add(`${label(entry)}: ${(error as Error).message}`);
      continue;
    }
    const key = entry.rel.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined) {
      add(
        `${label(entry)} and ${label(other)} write the same path${other.rel === entry.rel ? "" : ` (differing only by case: "${other.rel}" and "${entry.rel}")`}: ${entry.rel}`,
      );
      continue;
    }
    seen.set(key, entry);
    // A folder on the way must be a real folder, not a planned file, a file or a link.
    const segments = entry.rel.split("/");
    let blocked = false;
    for (let n = 1; n < segments.length && !blocked; n++) {
      const folder = segments.slice(0, n).join("/");
      const planned = entries.find((e) => e.rel.toLowerCase() === folder.toLowerCase());
      const found = planned
        ? undefined
        : await lstatOrUndefined(join(out, ...segments.slice(0, n)));
      if (planned || (found !== undefined && (found.isSymbolicLink() || !found.isDirectory()))) {
        add(
          `${label(entry)}: ${entry.rel} needs folder ${folder}, which is ${planned ? `written as a file by ${label(planned)}` : "not a folder"}`,
        );
        blocked = true;
      }
    }
    if (blocked) continue;
    const out0 = await lstatOrUndefined(out);
    if (out0 !== undefined && (out0.isSymbolicLink() || !out0.isDirectory())) {
      add(`${out} is not a folder`);
      continue;
    }
    const path = join(out, ...segments);
    const existing = await lstatOrUndefined(path);
    if (existing === undefined) continue;
    if (existing.isSymbolicLink() || !existing.isFile()) {
      add(`${label(entry)}: ${entry.rel} exists and is not a regular file`);
    } else if (sha256Hex(await readFile(path)) !== sha256Hex(entry.bytes)) {
      add(`${label(entry)}: ${entry.rel} exists with different bytes`);
    }
  }
}
