/**
 * The Vorbis comment header of an Ogg Vorbis file, where the AI mark of an Ogg rendition lives
 * (docs/PRD-audio.md, "Marks"). Core never decodes an Ogg: this reads and rewrites only the three
 * Vorbis header packets and renumbers the audio pages after them, leaving the audio untouched.
 * `@audio/encode-ogg/meta` writes a fixed set of tags and drops every other field, and
 * music-metadata only reads, so this rewrite is a recorded exception (docs/decisions.md).
 */
import { InputError } from "../errors.ts";

// Ogg pages (RFC 3533).

interface Page {
  start: number;
  end: number;
  flags: number;
  segments: number[];
  payloadStart: number;
}

function pages(bytes: Uint8Array): Page[] {
  const out: Page[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (
      at + 27 > bytes.length ||
      bytes[at] !== 0x4f ||
      bytes[at + 1] !== 0x67 ||
      bytes[at + 2] !== 0x67 ||
      bytes[at + 3] !== 0x53
    )
      throw new InputError(`not an Ogg file: no page at byte ${at}`);
    const count = bytes[at + 26]!;
    const segments = [...bytes.subarray(at + 27, at + 27 + count)];
    const payloadStart = at + 27 + count;
    const end = payloadStart + segments.reduce((a, b) => a + b, 0);
    if (end > bytes.length) throw new InputError("not an Ogg file: a page is cut short");
    out.push({ start: at, end, flags: bytes[at + 5]!, segments, payloadStart });
    at = end;
  }
  return out;
}

let crcTable: Uint32Array | undefined;
/** Ogg's CRC-32: polynomial 0x04C11DB7, initial value 0, no reflection, no final XOR. */
function oggCrc(data: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      crcTable[i] = r >>> 0;
    }
  }
  let crc = 0;
  for (const byte of data) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

/** Sets a page's serial and sequence number and recomputes its CRC, in place. */
function stamp(page: Uint8Array, serial: number, sequence: number): Uint8Array {
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  view.setUint32(22, 0, true);
  view.setUint32(22, oggCrc(page), true);
  return page;
}

/** Laces whole packets into header pages (granule 0); the first page gets `firstFlags`. */
function lace(packets: Uint8Array[], firstFlags: number): Uint8Array[] {
  const lengths: number[] = [];
  for (const p of packets) {
    for (let n = Math.floor(p.length / 255); n > 0; n--) lengths.push(255);
    lengths.push(p.length % 255);
  }
  const data = Buffer.concat(packets);
  const out: Uint8Array[] = [];
  let segment = 0;
  let offset = 0;
  let continued = false;
  while (segment < lengths.length) {
    const table = lengths.slice(segment, segment + 255);
    const size = table.reduce((a, b) => a + b, 0);
    const page = new Uint8Array(27 + table.length + size);
    page.set([0x4f, 0x67, 0x67, 0x53], 0);
    page[5] = (out.length === 0 ? firstFlags : 0) | (continued ? 0x01 : 0);
    page[26] = table.length;
    page.set(table, 27);
    page.set(data.subarray(offset, offset + size), 27 + table.length);
    out.push(page);
    continued = table.at(-1) === 255;
    segment += table.length;
    offset += size;
  }
  return out;
}

interface Headers {
  /** The identification, comment and setup packets. */
  packets: [Uint8Array, Uint8Array, Uint8Array];
  /** The index of the first page after the header pages. */
  audioPage: number;
  pages: Page[];
}

function headers(bytes: Uint8Array): Headers {
  const all = pages(bytes);
  const packets: Uint8Array[] = [];
  let current: Uint8Array[] = [];
  for (const [index, page] of all.entries()) {
    let at = page.payloadStart;
    for (const [s, length] of page.segments.entries()) {
      current.push(bytes.subarray(at, at + length));
      at += length;
      if (length < 255) {
        packets.push(Buffer.concat(current));
        current = [];
        if (packets.length === 3) {
          if (s !== page.segments.length - 1)
            throw new InputError("unsupported Ogg: audio shares a page with the Vorbis headers");
          const [id, comment, setup] = packets as [Uint8Array, Uint8Array, Uint8Array];
          if (!isVorbisHeader(id, 1) || !isVorbisHeader(comment, 3) || !isVorbisHeader(setup, 5))
            throw new InputError(
              "not an Ogg Vorbis file: its first packets are not Vorbis headers",
            );
          return { packets: [id, comment, setup], audioPage: index + 1, pages: all };
        }
      }
    }
  }
  throw new InputError("not an Ogg Vorbis file: its three Vorbis headers are incomplete");
}

function isVorbisHeader(packet: Uint8Array, type: number): boolean {
  return packet[0] === type && Buffer.from(packet.subarray(1, 7)).toString("latin1") === "vorbis";
}

/** A Vorbis comment header: the encoder's vendor string and its `NAME=value` fields, in order. */
export interface VorbisComments {
  vendor: string;
  comments: string[];
}

function parseComment(packet: Uint8Array): VorbisComments {
  const b = Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength);
  let at = 7;
  const take = (): string => {
    if (at + 4 > b.length) throw new InputError("Vorbis comment header is cut short");
    const length = b.readUInt32LE(at);
    at += 4;
    if (at + length > b.length) throw new InputError("Vorbis comment header is cut short");
    const text = b.toString("utf8", at, at + length);
    at += length;
    return text;
  };
  const vendor = take();
  if (at + 4 > b.length) throw new InputError("Vorbis comment header is cut short");
  const count = b.readUInt32LE(at);
  at += 4;
  const comments: string[] = [];
  for (let i = 0; i < count; i++) comments.push(take());
  return { vendor, comments };
}

function buildComment({ vendor, comments }: VorbisComments): Uint8Array {
  const parts: Buffer[] = [Buffer.from([3]), Buffer.from("vorbis", "latin1")];
  const field = (text: string) => {
    const bytes = Buffer.from(text, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    parts.push(length, bytes);
  };
  field(vendor);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(comments.length);
  parts.push(count);
  for (const c of comments) field(c);
  parts.push(Buffer.from([1])); // the framing bit
  return Buffer.concat(parts);
}

/** The Vorbis comment header of an Ogg Vorbis file. */
export function readVorbisComments(bytes: Uint8Array): VorbisComments {
  return parseComment(headers(bytes).packets[1]);
}

/** The value of the first comment named `name` (case-insensitive, as Vorbis field names are). */
export function vorbisComment(comments: VorbisComments, name: string): string | undefined {
  const key = `${name.toUpperCase()}=`;
  const found = comments.comments.find((c) => c.slice(0, key.length).toUpperCase() === key);
  return found?.slice(key.length);
}

/**
 * Rewrites the header pages: the identification packet alone on the first page, the comment and
 * setup packets after it, then the audio pages renumbered and re-CRC'd. `edit` changes the
 * comments; `serial` replaces the stream serial number.
 */
function rewriteHeaders(
  bytes: Uint8Array,
  edit: ((comments: VorbisComments) => VorbisComments) | undefined,
  serial?: number,
): Uint8Array {
  const parsed = headers(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stream = serial ?? view.getUint32(parsed.pages[0]!.start + 14, true);
  const [id, comment, setup] = parsed.packets;
  const newComment = edit ? buildComment(edit(parseComment(comment))) : comment;
  const out = [...lace([id], 0x02), ...lace([newComment, setup], 0)];
  for (const page of parsed.pages.slice(parsed.audioPage))
    out.push(bytes.slice(page.start, page.end));
  return Buffer.concat(out.map((page, sequence) => stamp(page, stream, sequence)));
}

/**
 * Sets Vorbis comments: every existing field with one of `fields`' names is removed, and each
 * defined value is added. The vendor string and the other fields stay; the audio is untouched.
 */
export function setVorbisComments(
  bytes: Uint8Array,
  fields: Record<string, string | undefined>,
): Uint8Array {
  const names = new Set(Object.keys(fields).map((n) => n.toUpperCase()));
  return rewriteHeaders(bytes, ({ vendor, comments }) => ({
    vendor,
    comments: [
      ...comments.filter((c) => !names.has(c.split("=", 1)[0]!.toUpperCase())),
      ...Object.entries(fields)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([name, value]) => `${name.toUpperCase()}=${value}`),
    ],
  }));
}

/** Sets the stream serial number of every page and recomputes the CRCs. */
export function setOggSerial(bytes: Uint8Array, serial: number): Uint8Array {
  return rewriteHeaders(bytes, undefined, serial);
}
