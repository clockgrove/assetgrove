/**
 * Ogg Vorbis renditions (docs/PRD-audio.md, the `encode` operation). Encoding is libvorbis through
 * `@audio/encode-ogg` (MIT): its WebAssembly is wasm-media-encoders' Ogg build of libvorbis and
 * libogg (both BSD-3-Clause), with no LGPL code (LAME, wasm-media-encoders' LGPL part, is a
 * separate build this package does not ship) and no native code (docs/decisions.md).
 * Core never decodes an Ogg; the Vorbis comment header, where the AI mark lives, is edited by
 * `vorbis-comments.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import encodeOggStream from "@audio/encode-ogg";
import { InputError } from "../errors.ts";
import type { AudioItem } from "./engine.ts";
import { frameCount } from "./engine.ts";
import { readVorbisComments, setOggSerial } from "./vorbis-comments.ts";

/** The media type of an Ogg Vorbis file. */
export const OGG_MEDIA_TYPE = "audio/ogg";

/** The Vorbis quality range libvorbis takes through the encoder (−1 to 10). */
export const OGG_QUALITY = { min: -1, max: 10, default: 5 } as const;

/** The encoder's licences: the wrapper's, and libvorbis' and libogg's inside its WebAssembly. */
export const OGG_ENCODER_LICENSE = "MIT AND BSD-3-Clause";

function encoderVersion(): string {
  const path = fileURLToPath(import.meta.resolve("@audio/encode-ogg/package.json"));
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

/** The encoder as recorded on each Ogg it writes: package, version and libvorbis' vendor string. */
export interface OggEncoder {
  name: string;
  version: string;
  /** libvorbis' own vendor string, as it writes it into the comment header. */
  vendor: string;
  license: string;
}

let vendorString: string | undefined;

/** The encoder's identity; its vendor string is read from a real encode, once. */
export async function oggEncoder(): Promise<OggEncoder> {
  if (vendorString === undefined) {
    const probe = await encodeRaw([new Float32Array(64)], 8000, 0);
    vendorString = readVorbisComments(probe).vendor;
  }
  return {
    name: "@audio/encode-ogg",
    version: encoderVersion(),
    vendor: vendorString,
    license: OGG_ENCODER_LICENSE,
  };
}

async function encodeRaw(
  channels: Float32Array[],
  sampleRate: number,
  quality: number,
): Promise<Uint8Array> {
  const encoder = await encodeOggStream({ sampleRate, channels: channels.length, quality });
  try {
    const body = encoder.encode(channels);
    const tail = encoder.flush();
    const out = new Uint8Array(body.length + tail.length);
    out.set(body);
    out.set(tail, body.length);
    return out;
  } finally {
    encoder.free();
  }
}

/**
 * Encodes an item as Ogg Vorbis at `quality`. libvorbis picks a random stream serial number, so
 * the serial is set to `serial` and every page's CRC recomputed: the same samples, quality and
 * serial give the same bytes.
 */
export async function encodeOgg(
  item: AudioItem,
  quality: number,
  serial: number,
): Promise<Uint8Array> {
  if (item.channels.length < 1 || item.channels.length > 2)
    throw new InputError(
      `encode: Ogg Vorbis renditions are mono or stereo; this sound has ${item.channels.length} channels (fold it with the mono step)`,
    );
  if (frameCount(item) === 0) throw new InputError("encode: the sound has no samples");
  const raw = await encodeRaw(
    item.channels.map((c) => Float32Array.from(c)),
    item.sampleRate,
    quality,
  );
  return setOggSerial(raw, serial);
}
