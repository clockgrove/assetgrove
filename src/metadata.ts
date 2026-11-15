import { userInfo } from "node:os";
import { InputError } from "./errors.ts";
import { inflateSync } from "node:zlib";
import { read as readKtx2, write as writeKtx2 } from "ktx-parse";
import type { TransformStep } from "./transform/types.ts";
import { parseGlb, writeGlb } from "./model3d/glb.ts";
import type { GltfDocument } from "./model3d/glb.ts";

const vocabulary = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const namespace = "http://iptc.org/std/Iptc4xmpExt/2008-02-29/";
export const DIGITAL_SOURCE_TYPES = {
  generated: `${vocabulary}trainedAlgorithmicMedia`,
  composite: `${vocabulary}compositeWithTrainedAlgorithmicMedia`,
  human: `${vocabulary}digitalCreation`,
  undeclared: "undeclared",
} as const;
// IPTC Digital Source Type vocabulary, including retained deprecated concepts.
const sourceCodes = [
  "digitalCapture",
  "computationalCapture",
  "negativeFilm",
  "positiveFilm",
  "print",
  "minorHumanEdits",
  "humanEdits",
  "compositeWithTrainedAlgorithmicMedia",
  "algorithmicallyEnhanced",
  "softwareImage",
  "digitalArt",
  "digitalCreation",
  "dataDrivenMedia",
  "trainedAlgorithmicMedia",
  "algorithmicMedia",
  "screenCapture",
  "virtualRecording",
  "composite",
  "compositeCapture",
  "compositeSynthetic",
] as const;
export type IptcDigitalSourceType = `${typeof vocabulary}${(typeof sourceCodes)[number]}`;
export type DigitalSourceType = IptcDigitalSourceType | "undeclared";
export interface SourceDeclaration {
  value: IptcDigitalSourceType;
  declaredBy: string;
}

export function parseDigitalSourceType(value: string): IptcDigitalSourceType | undefined {
  const code = sourceCodes.find((code) => value === code || value === `${vocabulary}${code}`);
  return code === undefined ? undefined : `${vocabulary}${code}`;
}
function sourceType(value: unknown): IptcDigitalSourceType | undefined {
  return typeof value === "string" ? parseDigitalSourceType(value) : undefined;
}
export function sourceDeclaration(value: DigitalSourceType): SourceDeclaration {
  const parsed = parseDigitalSourceType(value);
  if (!parsed) throw new InputError(`invalid --digital-source-type: ${value}`);
  return { value: parsed, declaredBy: userInfo().username };
}
export function requireDeclared(value: DigitalSourceType | undefined): void {
  if (!value || value === "undeclared")
    throw new InputError(
      "refused: asset source type is undeclared; declare it with --digital-source-type <IPTC code> before publishing or exporting",
    );
}
export function combineDigitalSourceTypes(values: readonly DigitalSourceType[]): DigitalSourceType {
  if (values.includes(DIGITAL_SOURCE_TYPES.composite)) return DIGITAL_SOURCE_TYPES.composite;
  if (values.includes(DIGITAL_SOURCE_TYPES.generated))
    return values.some((value) => value !== DIGITAL_SOURCE_TYPES.generated)
      ? DIGITAL_SOURCE_TYPES.composite
      : DIGITAL_SOURCE_TYPES.generated;
  if (!values.length || values.includes("undeclared")) return "undeclared";
  return values[0]!;
}

export function metadataStep(value: DigitalSourceType, pixelHashes: string[]): TransformStep {
  return {
    op: "embed-digital-source-type",
    params: { digitalSourceType: value },
    engine: { name: "assetgrove-xmp", version: "1" },
    inputs: [...pixelHashes],
    outputs: [...pixelHashes],
  };
}

const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const unescapeXml = (text: string): string =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const iptcPrefixes = (xml: string): string[] =>
  [
    ...xml.matchAll(
      /xmlns:([\w.-]+)\s*=\s*["']http:\/\/iptc.org\/std\/Iptc4xmpExt\/2008-02-29\/["']/g,
    ),
  ].map((m) => m[1]!);
/** The IPTC AI-system property carries the model names; the prompt never goes in the mark. */
const modelProperty = "AISystemUsed";
export interface MarkOptions {
  /** Model names for IPTC's AISystemUsed. Never a prompt. */
  models?: readonly string[];
}
export function modelText(models: readonly string[] | undefined): string | undefined {
  const names = [...new Set((models ?? []).map((m) => m.trim()).filter(Boolean))];
  return names.length ? names.join("; ") : undefined;
}

/** Replaces an existing IPTC property in place; undefined when the packet has none. */
function replaceProperty(xml: string, name: string, text: string): string | undefined {
  for (const prefix of iptcPrefixes(xml)) {
    const escaped = escapeRegExp(prefix);
    const element = new RegExp(
      `<${escaped}:${name}\\b[^>]*(?:/>|>[\\s\\S]*?<\\/${escaped}:${name}\\s*>)`,
    );
    if (element.test(xml))
      return xml.replace(
        element,
        () => `<${prefix}:${name}>${escapeXml(text)}</${prefix}:${name}>`,
      );
    const attribute = new RegExp(`(${escaped}:${name}\\s*=\\s*)(["'])[\\s\\S]*?\\2`);
    if (attribute.test(xml))
      return xml.replace(attribute, (_m, head) => `${head}"${escapeXml(text)}"`);
  }
  return undefined;
}

function xmp(value: DigitalSourceType, previous?: string, models?: readonly string[]): string {
  const modelsText = modelText(models);
  const properties: [string, string][] = [["DigitalSourceType", value]];
  if (modelsText !== undefined) properties.push([modelProperty, modelsText]);
  const body = (prefix: string): string =>
    `<${prefix}:Description ${prefix}:about="" xmlns:Iptc4xmpExt="${namespace}">` +
    properties.map(([n, t]) => `<Iptc4xmpExt:${n}>${escapeXml(t)}</Iptc4xmpExt:${n}>`).join("") +
    `</${prefix}:Description>`;
  if (previous) {
    if (
      readXmp(previous) === value &&
      (modelsText === undefined || readXmpModels(previous) === modelsText)
    )
      return previous;
    // Keep other XMP properties, including those in the same RDF description.
    let clean = previous;
    const missing: [string, string][] = [];
    for (const [n, t] of properties) {
      const replaced = replaceProperty(clean, n, t);
      if (replaced === undefined) missing.push([n, t]);
      else clean = replaced;
    }
    if (!missing.length) return clean;
    properties.splice(0, properties.length, ...missing);
    const emptyRdf = /<([\w.-]+):RDF\b([^>]*?)\/>/.exec(clean);
    if (emptyRdf)
      return clean.replace(
        emptyRdf[0],
        () => `<${emptyRdf[1]}:RDF${emptyRdf[2]}>${body(emptyRdf[1]!)}</${emptyRdf[1]}:RDF>`,
      );
    const rdf = /<\/([\w.-]+):RDF\s*>/.exec(clean);
    if (rdf) return clean.replace(rdf[0], () => body(rdf[1]!) + rdf[0]);
    throw new Error("cannot preserve XMP without an RDF container");
  }
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${body("rdf")}</rdf:RDF></x:xmpmeta>`;
}

function readXmpModels(xml: string): string | undefined {
  for (const prefix of iptcPrefixes(xml)) {
    const escaped = escapeRegExp(prefix);
    const element = new RegExp(
      `<${escaped}:${modelProperty}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}:${modelProperty}\\s*>`,
    ).exec(xml);
    const attribute = new RegExp(`${escaped}:${modelProperty}\\s*=\\s*["']([^"']+)["']`).exec(xml);
    const text = element?.[1]?.trim() ?? attribute?.[1];
    if (text) return unescapeXml(text);
  }
  return undefined;
}

function readXmp(xml: string): DigitalSourceType | undefined {
  for (const prefix of iptcPrefixes(xml)) {
    const escaped = escapeRegExp(prefix);
    const element = new RegExp(
      `<${escaped}:DigitalSourceType\\b[^>]*>([\\s\\S]*?)<\\/${escaped}:DigitalSourceType\\s*>`,
    ).exec(xml);
    const resource = new RegExp(
      `<${escaped}:DigitalSourceType\\b[^>]*\\brdf:resource=["']([^"']+)["']`,
    ).exec(xml);
    const attribute = new RegExp(`${escaped}:DigitalSourceType\\s*=\\s*["']([^"']+)["']`).exec(xml);
    const value = sourceType(resource?.[1] ?? element?.[1]?.trim() ?? attribute?.[1]);
    if (value) return value;
  }
  return undefined;
}

interface Chunk {
  type: string;
  data: Buffer;
}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function pngChunks(bytes: Uint8Array): Chunk[] {
  const b = Buffer.from(bytes);
  if (!b.subarray(0, 8).equals(pngSignature)) throw new Error("invalid PNG signature");
  const chunks: Chunk[] = [];
  for (let offset = 8; offset < b.length;) {
    if (offset + 12 > b.length) throw new Error("truncated PNG chunk");
    const length = b.readUInt32BE(offset);
    if (offset + length + 12 > b.length) throw new Error("truncated PNG chunk");
    chunks.push({
      type: b.toString("ascii", offset + 4, offset + 8),
      data: b.subarray(offset + 8, offset + 8 + length),
    });
    offset += length + 12;
  }
  return chunks;
}
function pngXmp(chunk: Chunk): string | undefined {
  if (chunk.type !== "iTXt") return undefined;
  const keywordEnd = chunk.data.indexOf(0);
  if (chunk.data.toString("ascii", 0, keywordEnd) !== "XML:com.adobe.xmp") return undefined;
  const compressed = chunk.data[keywordEnd + 1];
  const languageEnd = chunk.data.indexOf(0, keywordEnd + 3);
  const translatedEnd = chunk.data.indexOf(0, languageEnd + 1);
  if (languageEnd < 0 || translatedEnd < 0) throw new Error("invalid PNG XMP iTXt");
  const data = chunk.data.subarray(translatedEnd + 1);
  return (compressed === 1 ? inflateSync(data) : data).toString("utf8");
}
const jpegXmpId = Buffer.from("http://ns.adobe.com/xap/1.0/\0");
interface JpegScan {
  /** Where a new APP1 goes: after SOI and any leading JFIF/APP0 segments. */
  insertAt: number;
  xmp?: { start: number; end: number; xml: string };
}
function scanJpeg(b: Buffer): JpegScan {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error("invalid JPEG signature");
  let offset = 2;
  let insertAt = 2;
  let leading = true;
  let xmp: JpegScan["xmp"];
  while (offset < b.length) {
    const start = offset;
    if (b[offset++] !== 0xff) throw new Error("invalid JPEG marker");
    while (b[offset] === 0xff) offset++;
    const marker = b[offset++];
    if (marker === undefined) throw new Error("truncated JPEG marker");
    // XMP belongs to the header; entropy-coded scan data is not a segment stream.
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > b.length) throw new Error("truncated JPEG segment");
    const length = b.readUInt16BE(offset);
    if (length < 2 || offset + length > b.length) throw new Error("invalid JPEG segment length");
    const data = b.subarray(offset + 2, offset + length);
    if (marker === 0xe1 && data.subarray(0, jpegXmpId.length).equals(jpegXmpId)) {
      const found = {
        start,
        end: offset + length,
        xml: data.subarray(jpegXmpId.length).toString("utf8"),
      };
      // Prefer the first segment that carries a source type, else the first XMP segment.
      if (!xmp || (readXmp(xmp.xml) === undefined && readXmp(found.xml) !== undefined)) xmp = found;
    }
    if (leading && marker === 0xe0) insertAt = offset + length;
    else leading = false;
    offset += length;
  }
  return { insertAt, ...(xmp ? { xmp } : {}) };
}
function readJpegXmp(bytes: Uint8Array): string | undefined {
  return scanJpeg(Buffer.from(bytes)).xmp?.xml;
}
function embedJpeg(
  bytes: Uint8Array,
  value: DigitalSourceType,
  models?: readonly string[],
): Buffer {
  const b = Buffer.from(bytes);
  const scan = scanJpeg(b);
  const xml = Buffer.concat([jpegXmpId, Buffer.from(xmp(value, scan.xmp?.xml, models))]);
  if (xml.length + 2 > 0xffff) throw new Error("XMP packet too large for one JPEG segment");
  const segment = Buffer.alloc(4 + xml.length);
  segment.set([0xff, 0xe1]);
  segment.writeUInt16BE(xml.length + 2, 2);
  xml.copy(segment, 4);
  if (scan.xmp)
    return Buffer.concat([b.subarray(0, scan.xmp.start), segment, b.subarray(scan.xmp.end)]);
  return Buffer.concat([b.subarray(0, scan.insertAt), segment, b.subarray(scan.insertAt)]);
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function encodePngChunk(chunk: Chunk): Buffer {
  const b = Buffer.alloc(chunk.data.length + 12);
  b.writeUInt32BE(chunk.data.length);
  b.write(chunk.type, 4, 4, "ascii");
  chunk.data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, b.length - 4)), b.length - 4);
  return b;
}
function webpChunks(bytes: Uint8Array): Chunk[] {
  const b = Buffer.from(bytes);
  if (
    b.toString("ascii", 0, 4) !== "RIFF" ||
    b.toString("ascii", 8, 12) !== "WEBP" ||
    b.readUInt32LE(4) + 8 !== b.length
  )
    throw new Error("invalid WebP container");
  const chunks: Chunk[] = [];
  for (let offset = 12; offset < b.length;) {
    if (offset + 8 > b.length) throw new Error("truncated WebP chunk");
    const length = b.readUInt32LE(offset + 4);
    if (offset + 8 + length + (length & 1) > b.length) throw new Error("truncated WebP chunk");
    chunks.push({
      type: b.toString("ascii", offset, offset + 4),
      data: b.subarray(offset + 8, offset + 8 + length),
    });
    offset += 8 + length + (length & 1);
  }
  return chunks;
}
function encodeWebpChunk(chunk: Chunk): Buffer {
  const b = Buffer.alloc(8 + chunk.data.length + (chunk.data.length & 1));
  b.write(chunk.type, 0, 4, "ascii");
  b.writeUInt32LE(chunk.data.length, 4);
  chunk.data.copy(b, 8);
  return b;
}
function webpHeader(chunks: Chunk[]): Chunk {
  const existing = chunks.find((c) => c.type === "VP8X");
  if (existing) {
    const data = Buffer.from(existing.data);
    data[0] = data[0]! | 4;
    return { type: "VP8X", data };
  }
  const lossless = chunks.find((c) => c.type === "VP8L");
  const lossy = chunks.find((c) => c.type === "VP8 ");
  let width: number, height: number, alpha: boolean;
  if (lossless) {
    const bits = lossless.data.readUInt32LE(1);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
    alpha = (bits & 0x10000000) !== 0;
  } else if (lossy) {
    width = lossy.data.readUInt16LE(6) & 0x3fff;
    height = lossy.data.readUInt16LE(8) & 0x3fff;
    alpha = chunks.some((c) => c.type === "ALPH");
  } else throw new Error("WebP has no image dimensions");
  const data = Buffer.alloc(10);
  data[0] = 4 | (alpha ? 16 : 0);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return { type: "VP8X", data };
}

type Gltf = {
  asset?: { extensions?: Record<string, unknown>; [key: string]: unknown };
  extensions?: Record<string, unknown>;
  extensionsUsed?: string[];
  [key: string]: unknown;
};
/** Adds a document-level packet while preserving other extensions and packet references. */
export function embedGltfDigitalSourceType(
  document: Gltf,
  value: DigitalSourceType,
  models?: readonly string[],
): Gltf {
  const result = structuredClone(document);
  if (value === "undeclared") return result;
  const extensions = (result.extensions ??= {});
  const old = extensions["KHR_xmp_json_ld"] as
    { packets?: Record<string, unknown>[]; packet?: number } | undefined;
  const packets = structuredClone(old?.packets ?? []);
  const asset = (result.asset ??= { version: "2.0" });
  const assetExtensions = (asset.extensions ??= {});
  const reference = assetExtensions["KHR_xmp_json_ld"] as { packet?: number } | undefined;
  let index = reference?.packet ?? packets.length;
  const shared = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(shared);
    const object = value as Record<string, unknown>;
    const binding = (object["extensions"] as Record<string, unknown> | undefined)?.[
      "KHR_xmp_json_ld"
    ] as { packet?: number } | undefined;
    return binding?.packet === index || Object.values(object).some(shared);
  };
  if (
    reference &&
    Object.entries(result).some(
      ([key, value]) => key !== "asset" && key !== "extensions" && shared(value),
    )
  ) {
    packets.push(structuredClone(packets[index] ?? {}));
    index = packets.length - 1;
  }
  const packet = packets[index] ?? {};
  packet["@id"] ??= "";
  packet["@context"] = { ...((packet["@context"] as object) ?? {}), Iptc4xmpExt: namespace };
  packet["Iptc4xmpExt:DigitalSourceType"] = value;
  const modelsText = modelText(models);
  if (modelsText !== undefined) packet["Iptc4xmpExt:AISystemUsed"] = modelsText;
  packets[index] = packet;
  extensions["KHR_xmp_json_ld"] = { ...old, packets };
  assetExtensions["KHR_xmp_json_ld"] = { ...reference, packet: index };
  result.extensionsUsed = [...new Set([...(result.extensionsUsed ?? []), "KHR_xmp_json_ld"])];
  return result;
}

export function embedDigitalSourceType(
  bytes: Uint8Array,
  mediaType: string,
  value: DigitalSourceType,
  options: MarkOptions = {},
): Uint8Array {
  if (value === "undeclared") return bytes;
  const models = options.models;
  if (mediaType === "image/png") {
    const chunks = pngChunks(bytes);
    const previous = chunks.map(pngXmp).find((s) => s !== undefined);
    const metadata: Chunk = {
      type: "iTXt",
      data: Buffer.concat([
        Buffer.from("XML:com.adobe.xmp\0\0\0\0\0"),
        Buffer.from(xmp(value, previous, models)),
      ]),
    };
    const filtered = chunks.filter((c) => pngXmp(c) === undefined);
    const end = filtered.findIndex((c) => c.type === "IEND");
    if (end < 0) throw new Error("PNG has no IEND");
    const imageData = filtered.findIndex((c) => c.type === "IDAT");
    filtered.splice(imageData < 0 ? end : imageData, 0, metadata);
    return Buffer.concat([pngSignature, ...filtered.map(encodePngChunk)]);
  }
  if (mediaType === "image/jpeg") return embedJpeg(bytes, value, models);
  if (mediaType === "image/webp") {
    const chunks = webpChunks(bytes);
    const previous = chunks.find((c) => c.type === "XMP ")?.data.toString("utf8");
    const payload = Buffer.concat([
      Buffer.from("WEBP"),
      ...[
        webpHeader(chunks),
        ...chunks.filter((c) => !["XMP ", "VP8X"].includes(c.type)),
        { type: "XMP ", data: Buffer.from(xmp(value, previous, models)) },
      ].map(encodeWebpChunk),
    ]);
    const header = Buffer.alloc(8);
    header.write("RIFF");
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }
  if (mediaType === "model/gltf-binary") {
    const glb = parseGlb(bytes);
    return writeGlb({
      ...glb,
      json: embedGltfDigitalSourceType(glb.json, value, models) as GltfDocument,
    });
  }
  if (mediaType === "model/gltf+json")
    return Buffer.from(
      `${JSON.stringify(embedGltfDigitalSourceType(JSON.parse(Buffer.from(bytes).toString("utf8")) as Gltf, value, models))}\n`,
    );
  if (mediaType === "image/ktx2") {
    // The container's key-value data holds the XMP packet under `XMP`; ktx-parse is the only
    // maintained reader and writer (docs/decisions.md).
    const container = readKtx2(bytes);
    const previous = ktx2Xmp(container.keyValue[ktx2Key]);
    const packet = xmp(value, previous, models);
    if (previous === packet) return bytes;
    container.keyValue[ktx2Key] = packet;
    container.keyValue["KTXwriter"] ??= "assetgrove";
    return writeKtx2Container(container);
  }
  return bytes;
}

const ktx2Key = "XMP";
/**
 * ktx-parse 1.1.0 writes each key-value entry's length through `new Uint8Array(Uint32Array)`, which
 * keeps only its low byte, so an entry of 256 bytes or more reads back corrupt. This writes with
 * ktx-parse and then sets the true length of each entry (docs/decisions.md); the reader is correct.
 */
function writeKtx2Container(container: ReturnType<typeof readKtx2>): Uint8Array {
  const bytes = writeKtx2(container, { keepWriter: true });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = view.getUint32(56, true);
  const entries = Object.entries(container.keyValue).sort((a, b) => (a[0] > b[0] ? 1 : -1));
  for (const [key, value] of entries) {
    const data = typeof value === "string" ? Buffer.byteLength(value) + 1 : value.byteLength;
    const length = Buffer.byteLength(key) + 1 + data;
    view.setUint32(offset, length, true);
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  return bytes;
}
function ktx2Xmp(value: string | Uint8Array | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  return text.replace(/\0+$/, "");
}
function gltfPacket(doc: Gltf): Record<string, unknown> | undefined {
  const ext = doc.extensions?.["KHR_xmp_json_ld"] as
    { packets?: Record<string, unknown>[] } | undefined;
  const reference = doc.asset?.extensions?.["KHR_xmp_json_ld"] as { packet?: number } | undefined;
  return reference?.packet === undefined ? undefined : ext?.packets?.[reference.packet];
}
function gltfDocument(bytes: Uint8Array, mediaType: string): Gltf {
  return mediaType === "model/gltf-binary"
    ? (parseGlb(bytes).json as Gltf)
    : (JSON.parse(Buffer.from(bytes).toString("utf8")) as Gltf);
}

export function readDigitalSourceType(
  bytes: Uint8Array,
  mediaType: string,
): DigitalSourceType | undefined {
  if (mediaType === "image/png") {
    for (const chunk of pngChunks(bytes)) {
      const xml = pngXmp(chunk);
      const value = xml === undefined ? undefined : readXmp(xml);
      if (value) return value;
    }
  } else if (mediaType === "image/jpeg") {
    const xml = readJpegXmp(bytes);
    return xml === undefined ? undefined : readXmp(xml);
  } else if (mediaType === "image/webp") {
    const xml = webpChunks(bytes)
      .find((c) => c.type === "XMP ")
      ?.data.toString("utf8");
    if (xml !== undefined) return readXmp(xml);
  } else if (mediaType === "model/gltf+json" || mediaType === "model/gltf-binary") {
    return sourceType(
      gltfPacket(gltfDocument(bytes, mediaType))?.["Iptc4xmpExt:DigitalSourceType"],
    );
  } else if (mediaType === "image/ktx2") {
    const xml = ktx2Xmp(readKtx2(bytes).keyValue[ktx2Key]);
    return xml === undefined ? undefined : readXmp(xml);
  }
  return undefined;
}

/** The model names a mark carries in IPTC's AI-system property, or undefined. */
export function readMarkedModels(bytes: Uint8Array, mediaType: string): string | undefined {
  let xml: string | undefined;
  if (mediaType === "image/png")
    xml = pngChunks(bytes)
      .map(pngXmp)
      .find((x) => x !== undefined);
  else if (mediaType === "image/jpeg") xml = readJpegXmp(bytes);
  else if (mediaType === "model/gltf+json" || mediaType === "model/gltf-binary") {
    const text = gltfPacket(gltfDocument(bytes, mediaType))?.["Iptc4xmpExt:AISystemUsed"];
    return typeof text === "string" && text !== "" ? text : undefined;
  } else if (mediaType === "image/ktx2") xml = ktx2Xmp(readKtx2(bytes).keyValue[ktx2Key]);
  else if (mediaType === "image/webp")
    xml = webpChunks(bytes)
      .find((c) => c.type === "XMP ")
      ?.data.toString("utf8");
  return xml === undefined ? undefined : readXmpModels(xml);
}
