/** The numbered sheet `find` returns (design section 7.4): one row per hit, its image, numbers only. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderContact } from "../contact.ts";
import { decodeImage, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";

/** Writes the sheet to `<dir>/<sha256 of the PNG>.png` and returns its absolute path. */
export async function writeFindSheet(
  hits: { rank: number }[],
  images: (Uint8Array | undefined)[],
  dir: string,
): Promise<string> {
  const rows = hits.map((hit, i) => {
    const bytes = images[i];
    const decoded: Raster[] = [];
    if (bytes !== undefined) {
      try {
        decoded.push(decodeImage(bytes));
      } catch {
        // A hit whose image does not decode keeps its numbered row with no image.
      }
    }
    return { number: hit.rank, images: decoded };
  });
  const png = encodePng(renderContact(rows, []).raster);
  const folder = resolve(dir);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${createHash("sha256").update(png).digest("hex")}.png`);
  await writeFile(path, png);
  return path;
}
