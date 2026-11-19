import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import jpeg from "jpeg-js";
import { extensionContext, tempProject } from "@clockgrove/assetgrove/testing";
import { createLibraryReader } from "../../../src/search/reader.ts";
import { SearchIndex } from "../src/find.ts";
import { ScriptedEmbedder } from "../src/scripted.ts";
import { GAME, writeLibrary } from "./helpers/core-library.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("real library bytes feed numeric Lance filters, unavailable evidence and privacy-safe rebuilt results", async (t) => {
  const project = tempProject();
  t.after(() => project.close());
  writeLibrary(project.dir);
  const root = join(project.dir, "assets");
  const { raster } = extensionContext("media-metadata-test");
  const privateValues = ["47.123456", "SYNTHETIC-SERIAL-464"];
  const image = jpeg.encode(raster.create(11, 7), 80).data;
  const xmp = Buffer.from(
    `http://ns.adobe.com/xap/1.0/\0<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:aux="http://ns.adobe.com/exif/1.0/aux/" exif:GPSLatitude="${privateValues[0]}" aux:SerialNumber="${privateValues[1]}"/>`,
  );
  const app1 = Buffer.from([0xff, 0xe1, 0, 0]);
  app1.writeUInt16BE(xmp.length + 2, 2);
  const embedded = Buffer.concat([image.subarray(0, 2), app1, xmp, image.subarray(2)]);
  assert.ok(embedded.includes(Buffer.from(privateValues[1]!)));
  const files = [
    { id: "small", bytes: raster.encodePng(raster.create(2, 3)) },
    { id: "large", bytes: raster.encodePng(raster.create(10, 4)) },
    { id: "embedded", bytes: embedded },
    { id: "missing", bytes: undefined },
    { id: "pointer", bytes: undefined },
    { id: "unsupported", bytes: Buffer.from("unsupported media") },
  ];
  for (const { id, bytes } of files) {
    const sha256 = bytes ? hash(bytes) : "a".repeat(64);
    writeFileSync(
      join(root, `${id}.md`),
      `---\ntype: Game Asset\nformat: assetgrove-card/1\ntitle: ${id}\nresource: ${id}.bin\nlock: { sha256: "${sha256}" }\n---\n`,
    );
    if (bytes) writeFileSync(join(root, `${id}.bin`), bytes);
    if (id === "pointer")
      writeFileSync(
        join(root, `${id}.bin`),
        `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256}\nsize 100\n`,
      );
  }
  const logs: string[] = [];
  for (const method of ["log", "warn", "error"] as const)
    t.mock.method(console, method, (...values: unknown[]) => logs.push(values.join(" ")));
  const reader = await createLibraryReader({
    dir: project.dir,
    stateDir: project.stateDir,
    settings: { folders: [], candidates: false },
  });
  const open = (name: string) =>
    SearchIndex.open({
      dir: join(project.stateDir, name),
      worktree: project.dir,
      library: reader,
      embedder: new ScriptedEmbedder(),
    });
  const index = await open("first");
  t.after(() => index.close());
  const ids = (hits: { address: string }[]) => hits.map((h) => h.address.split("/").at(-1)).sort();
  for (const [where, expected] of [
    ["width<10", ["small"]],
    ["width<=10", ["large", "small"]],
    ["width=10", ["large"]],
    ["width>=10", ["embedded", "large"]],
    ["width>10", ["embedded"]],
    ["width!=10", ["embedded", "small"]],
    ["height=7", ["embedded"]],
  ] as Array<[string, string[]]>) {
    assert.deepEqual(ids((await index.find({ where })).hits), expected, where);
  }
  const all = (await index.find({ limit: 50 })).hits;
  for (const [id, reason] of [
    ["missing", "missing_file"],
    ["pointer", "lfs_pointer"],
    ["unsupported", "unsupported_media"],
  ]) {
    const fields = all.find((h) => h.address === `asset://${GAME}/${id}`)!.fields;
    assert.equal(fields.mediaStatus, "unavailable", id);
    assert.equal(fields.mediaReason, reason, id);
    assert.equal(fields.width, undefined);
    assert.equal(fields.height, undefined);
  }
  const measured = all.find((h) => h.address.endsWith("/embedded"))!.fields;
  assert.equal(measured.width, 11);
  assert.equal(measured.height, 7);
  assert.equal(measured.mediaType, "image/jpeg");
  assert.equal(measured.mediaSha256, hash(embedded));
  assert.notEqual(measured.mediaSha256, hash(image));
  const rebuilt = await open("rebuilt");
  t.after(() => rebuilt.close());
  const again = (await rebuilt.find({ limit: 50 })).hits;
  assert.deepEqual(again, all);
  const persisted = await index.store.query({ limit: 50 });
  for (const value of [...privateValues, "GPSLatitude", "SerialNumber"])
    assert.equal(JSON.stringify({ all, again, persisted, logs }).includes(value), false, value);
  for (const { id } of files)
    for (const value of [...privateValues, "GPSLatitude", "SerialNumber"])
      assert.equal(readFileSync(join(root, `${id}.md`), "utf8").includes(value), false);
});
