/** Fetches the manifest's images into a cache folder, checking every sha256. Never committed. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Manifest, ManifestImage } from "./manifest.ts";

export interface ImageSource {
  bytes(image: ManifestImage): Promise<Uint8Array>;
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

const run = promisify(execFile);

/** Reads `path` out of a zip with `unzip`; falls back to the one entry that ends with it. */
async function fromZip(zip: string, path: string): Promise<Uint8Array> {
  const read = async (name: string) =>
    (await run("unzip", ["-p", zip, name], { encoding: "buffer", maxBuffer: 1 << 28 })).stdout;
  try {
    return new Uint8Array(await read(path));
  } catch {
    const names = (await run("unzip", ["-Z1", zip], { maxBuffer: 1 << 26 })).stdout.split("\n");
    const hit = names.filter((n) => n.endsWith(`/${path}`));
    if (hit.length !== 1) throw new Error(`${path}: not found in ${zip}`);
    return new Uint8Array(await read(hit[0]!));
  }
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchImages(manifest: Manifest, dir: string): Promise<ImageSource> {
  await mkdir(dir, { recursive: true });
  for (const image of manifest.images) {
    const path = join(dir, `${image.id}.bin`);
    const cached = await readFile(path).catch(() => undefined);
    if (cached && sha256(cached) === image.sha256) continue;
    // `<zip address>#<path in pack>` reads the image out of the pack's zip, downloaded once.
    const [address, inner] = image.url.split("#") as [string, string | undefined];
    let body: Uint8Array;
    if (inner === undefined) body = await download(address);
    else {
      const zip = join(
        dir,
        `zip-${createHash("sha256").update(address).digest("hex").slice(0, 16)}.zip`,
      );
      if (!(await readFile(zip).catch(() => undefined)))
        await writeFile(zip, await download(address));
      body = await fromZip(zip, inner);
    }
    if (sha256(body) !== image.sha256) throw new Error(`${image.id}: sha256 does not match`);
    await writeFile(path, body);
  }
  return {
    bytes: async (image) => new Uint8Array(await readFile(join(dir, `${image.id}.bin`))),
  };
}
