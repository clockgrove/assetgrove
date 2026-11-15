import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExifTool } from "exiftool-vendored";
import jpeg from "jpeg-js";
import {
  DIGITAL_SOURCE_TYPES as types,
  embedDigitalSourceType,
  readDigitalSourceType,
  readMarkedModels,
} from "../src/metadata.ts";
import { encodePng } from "../src/image/raster.ts";
import { encodeWebpLossless } from "../src/image/webp.ts";

const exiftool = new ExifTool({ maxProcs: 1 });
after(() => exiftool.end());

const raster = { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(200) };
const fixtures: [string, string, () => Uint8Array][] = [
  ["image/png", "png", () => encodePng(raster)],
  ["image/jpeg", "jpg", () => jpeg.encode({ ...raster, data: Buffer.from(raster.data) }, 90).data],
  ["image/webp", "webp", () => encodeWebpLossless(raster)],
];
const prompt = "a secret prompt about dragons";

async function tags(bytes: Uint8Array, ext: string): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), "mark-"));
  const file = join(dir, `a.${ext}`);
  await writeFile(file, bytes);
  return (await exiftool.readRaw(file, ["-G1", "-s", "-XMP-iptcExt:all"])) as Record<
    string,
    unknown
  >;
}

for (const [mediaType, ext, make] of fixtures) {
  test(`${ext}: exiftool reads the source type and models`, async () => {
    const marked = embedDigitalSourceType(make(), mediaType, types.generated, {
      models: ["model-a", "model-b & c"],
    });
    const read = await tags(marked, ext);
    assert.equal(read["XMP-iptcExt:DigitalSourceType"], types.generated);
    assert.equal(read["XMP-iptcExt:AISystemUsed"], "model-a; model-b & c");
    assert.equal(readDigitalSourceType(marked, mediaType), types.generated);
    assert.equal(readMarkedModels(marked, mediaType), "model-a; model-b & c");
    assert.ok(!Buffer.from(marked).includes(Buffer.from(prompt)));
    const iptc = Object.keys(read)
      .filter((k) => k.startsWith("XMP-iptcExt:"))
      .sort();
    assert.deepEqual(iptc, ["XMP-iptcExt:AISystemUsed", "XMP-iptcExt:DigitalSourceType"]);
  });
  test(`${ext}: source type without models writes none`, async () => {
    const marked = embedDigitalSourceType(make(), mediaType, types.composite);
    const read = await tags(marked, ext);
    assert.equal(read["XMP-iptcExt:DigitalSourceType"], types.composite);
    assert.equal(read["XMP-iptcExt:AISystemUsed"], undefined);
  });
  test(`${ext}: marking twice leaves the bytes identical`, () => {
    const options = { models: ["model-a"] };
    const once = embedDigitalSourceType(make(), mediaType, types.generated, options);
    const twice = embedDigitalSourceType(once, mediaType, types.generated, options);
    assert.deepEqual(Buffer.from(twice), Buffer.from(once));
    const plain = embedDigitalSourceType(make(), mediaType, types.generated);
    assert.deepEqual(
      Buffer.from(embedDigitalSourceType(plain, mediaType, types.generated)),
      Buffer.from(plain),
    );
  });
  test(`${ext}: re-marking with other models replaces them`, () => {
    const a = embedDigitalSourceType(make(), mediaType, types.generated, { models: ["one"] });
    const b = embedDigitalSourceType(a, mediaType, types.generated, { models: ["two"] });
    assert.equal(readMarkedModels(b, mediaType), "two");
    const c = embedDigitalSourceType(make(), mediaType, types.generated);
    assert.equal(
      readMarkedModels(
        embedDigitalSourceType(c, mediaType, types.generated, { models: ["x"] }),
        mediaType,
      ),
      "x",
    );
  });
}

const xmpSegment = (packet: string): Buffer => {
  const body = Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0"), Buffer.from(packet)]);
  const head = Buffer.alloc(4);
  head.set([0xff, 0xe1]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};
const iptcNs = "http://iptc.org/std/Iptc4xmpExt/2008-02-29/";
const wrap = (inner: string): string =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${inner}</rdf:RDF></x:xmpmeta>`;

test("jpg: a later XMP segment's source type is still read, and one value is written", () => {
  const base = Buffer.from(fixtures[1]![2]());
  const first = xmpSegment(
    wrap(`<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"/>`),
  );
  const second = xmpSegment(
    wrap(
      `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="${iptcNs}"><Iptc4xmpExt:DigitalSourceType>${types.composite}</Iptc4xmpExt:DigitalSourceType></rdf:Description>`,
    ),
  );
  const file = Buffer.concat([base.subarray(0, 2), first, second, base.subarray(2)]);
  assert.equal(readDigitalSourceType(file, "image/jpeg"), types.composite);
  const marked = Buffer.from(embedDigitalSourceType(file, "image/jpeg", types.generated));
  assert.equal(readDigitalSourceType(marked, "image/jpeg"), types.generated);
  assert.ok(!marked.includes(Buffer.from(types.composite)));
});

test("jpg: re-marking an attribute-form packet with quoted model names is stable", () => {
  const packet =
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="${iptcNs}" Iptc4xmpExt:AISystemUsed="old"><Iptc4xmpExt:DigitalSourceType>${types.generated}</Iptc4xmpExt:DigitalSourceType></rdf:Description></rdf:RDF></x:xmpmeta>`;
  for (const [mediaType, , make] of fixtures) {
    const seeded =
      mediaType === "image/jpeg"
        ? (() => {
            const b = Buffer.from(make());
            return Buffer.concat([b.subarray(0, 2), xmpSegment(packet), b.subarray(2)]);
          })()
        : undefined;
    if (!seeded) continue;
    const options = { models: ['mo"del', "it's"] };
    const once = embedDigitalSourceType(seeded, mediaType, types.generated, options);
    assert.equal(readMarkedModels(once, mediaType), `mo"del; it's`);
    assert.deepEqual(
      Buffer.from(embedDigitalSourceType(once, mediaType, types.generated, options)),
      Buffer.from(once),
    );
  }
});
