import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import jpeg from "jpeg-js";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { sha256Hex } from "../src/library/canonical.ts";
import { parseCard } from "../src/library/card.ts";
import { readLibrary, rebuildLibrary } from "../src/library/maintain.ts";
import { measureMedia, measureMediaBytes } from "../src/library/media-metadata.ts";
import { commitLibraryWrite, prepareLibraryWrite } from "../src/library/write.ts";
import { gitTarget } from "./fixtures/git.ts";
import { libraryProfile } from "./fixtures/library.ts";

async function temp(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "assetgrove-media-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("picked JPEG measures typed facts from final bytes and rebuild reproduces them without embedded GPS or serial data", async (t) => {
  const dir = gitTarget(await temp(t));
  const profile = libraryProfile();
  const assetDir = join(dir, "assets");
  await mkdir(assetDir);
  const image = jpeg.encode(createRaster(11, 7), 80).data;
  const privateValues = ["47.123456", "SYNTHETIC-SERIAL-464"];
  const xmp = Buffer.from(
    `http://ns.adobe.com/xap/1.0/\0<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:aux="http://ns.adobe.com/exif/1.0/aux/" exif:GPSLatitude="${privateValues[0]}" aux:SerialNumber="${privateValues[1]}"/>`,
  );
  const app1 = Buffer.from([0xff, 0xe1, 0, 0]);
  app1.writeUInt16BE(xmp.length + 2, 2);
  const bytes = Buffer.concat([image.subarray(0, 2), app1, xmp, image.subarray(2)]);
  const mediaPath = join(assetDir, "fixture.jpg");
  await writeFile(mediaPath, bytes);
  const spec = { kind: "still" as const, assetId: "fixture", subject: "fixture" };
  const plan = await prepareLibraryWrite({
    profile,
    spec,
    targetDir: dir,
    mediaPath,
    mediaBytes: bytes,
    manifestPath: join(assetDir, "fixture.json"),
  });
  const picked = await commitLibraryWrite(plan, {
    mediaBytes: bytes,
    spec,
    run: "r-fixture",
    candidate: "c1",
    assetgrove: "0.2.0",
    now: new Date("2026-11-18T00:00:00Z"),
    provenance: {
      route: "scripted",
      bibleVersion: "1",
      license: "CC0-1.0",
      finishedAt: "2026-11-18T00:00:00Z",
    },
  });
  const cardPath = join(assetDir, "fixture.md");
  const original = await readFile(cardPath, "utf8");
  const expected = {
    format: "assetgrove-media/1",
    sha256: picked.sha256,
    status: "available",
    mediaType: "image/jpeg",
    width: 11,
    height: 7,
  };
  assert.equal(picked.sha256, sha256Hex(bytes));
  assert.notEqual(picked.sha256, sha256Hex(image));
  assert.deepEqual(parseCard(original, cardPath).data["media"], expected);
  assert.deepEqual(await measureMedia(mediaPath, picked.sha256), expected);
  await writeFile(cardPath, original.replace("width: 11", "width: 99"));
  const state = await readLibrary(profile, dir);
  await rebuildLibrary(state);
  assert.equal(await readFile(cardPath, "utf8"), original);
  assert.deepEqual((await readLibrary(profile, dir)).writes, []);
  for (const name of ["fixture.md", "index.md", "log.md"]) {
    const text = await readFile(join(assetDir, name), "utf8");
    for (const value of [...privateValues, "GPSLatitude", "SerialNumber"])
      assert.equal(text.includes(value), false);
  }
});

test("measurement reports absent bytes, pointer-only bytes, mismatched bytes and unsupported media as unavailable", async (t) => {
  const dir = await temp(t);
  const bytes = encodePng(createRaster(10, 2));
  const sha256 = sha256Hex(bytes);
  const path = join(dir, "media.png");
  assert.deepEqual(await measureMedia(path, sha256), {
    format: "assetgrove-media/1",
    sha256,
    status: "unavailable",
    reason: "missing_file",
  });
  await writeFile(
    path,
    `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256}\nsize ${bytes.length}\n`,
  );
  assert.deepEqual(await measureMedia(path, sha256), {
    format: "assetgrove-media/1",
    sha256,
    status: "unavailable",
    reason: "lfs_pointer",
  });
  await writeFile(path, bytes);
  assert.deepEqual(await measureMedia(path, "0".repeat(64)), {
    format: "assetgrove-media/1",
    sha256: "0".repeat(64),
    status: "unavailable",
    reason: "hash_mismatch",
  });
  const unsupported = Buffer.from("not a measured media format");
  assert.deepEqual(measureMediaBytes(unsupported, sha256Hex(unsupported)), {
    format: "assetgrove-media/1",
    sha256: sha256Hex(unsupported),
    status: "unavailable",
    reason: "unsupported_media",
  });
  assert.deepEqual(await measureMedia(path, sha256), {
    format: "assetgrove-media/1",
    sha256,
    status: "available",
    mediaType: "image/png",
    width: 10,
    height: 2,
  });
});
