import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Embedder } from "../../src/embedder.ts";
import type { Library, LibraryItem, LoadedItem } from "../../src/library.ts";
import { ScriptedEmbedder } from "../../src/scripted.ts";

/**
 * A fixture library: every `*.png` under a folder is an item. With the scripted embedder a
 * file's bytes are its caption. A `<name>.card.json` beside it holds card fields, and its
 * optional `views` maps view names to captions (a turntable); otherwise the file is one view.
 */
export function folderLibrary(root: string, source: LibraryItem["source"] = "pick"): Library {
  const cards = new Map<string, { views?: Record<string, string> }>();
  return {
    async list() {
      const items: LibraryItem[] = [];
      for (const name of (await readdir(root, { recursive: true })).sort()) {
        if (!name.endsWith(".png") || name.split(sep).includes(".git")) continue;
        const abs = join(root, name);
        const s = await stat(abs);
        const path = relative(root, abs).split(sep).join("/");
        const cardFile = abs.replace(/\.png$/, ".card.json");
        const card = JSON.parse(await readFile(cardFile, "utf8").catch(() => "{}"));
        cards.set(path, card);
        const id = path.replace(/\.png$/, "");
        const fields = { ...card };
        delete fields.views;
        items.push({
          path,
          size: s.size,
          mtimeMs: s.mtimeMs,
          source,
          id,
          address: `asset://g/${id}`,
          ...fields,
        });
      }
      return items;
    },
    async load(item): Promise<LoadedItem> {
      const bytes = new Uint8Array(await readFile(join(root, item.path)));
      const views = cards.get(item.path)?.views;
      return {
        bytes,
        views: views
          ? Object.entries(views).map(([view, caption]) => ({ view, image: Buffer.from(caption) }))
          : [{ view: "", image: bytes }],
      };
    },
    async head() {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    },
  };
}

/** The scripted embedder, counting what it is asked to embed. */
export class CountingEmbedder implements Embedder {
  readonly inner = new ScriptedEmbedder();
  readonly id = this.inner.id;
  readonly revision = this.inner.revision;
  readonly dimension = this.inner.dimension;
  images = 0;
  texts = 0;
  async embedImages(images: Uint8Array[]): Promise<Float32Array[]> {
    this.images += images.length;
    return this.inner.embedImages(images);
  }
  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    this.texts += texts.length;
    return this.inner.embedTexts(texts);
  }
  reset(): void {
    this.images = 0;
    this.texts = 0;
  }
}
