/**
 * A test-only Aseprite writer: just enough of the file format (header, layers, zlib cels, tags,
 * and a palette for indexed files) to build fixtures the reader in `src/source/aseprite.ts`
 * decodes. The output is deterministic.
 */
import { deflateSync } from "node:zlib";

export interface AsepriteLayerInput {
  name: string;
  visible?: boolean;
  /** 0 to 255, default 255. */
  opacity?: number;
  /** Aseprite blend mode, 0 is normal. */
  blendMode?: number;
  /** 0 image (default), 1 group, 2 tilemap. */
  type?: 0 | 1 | 2;
  /** Nesting depth: 0 at the top level, 1 inside the group just above it. */
  childLevel?: number;
  background?: boolean;
  reference?: boolean;
}

export interface AsepriteCelInput {
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Raw pixel bytes in the file's colour depth: RGBA, grayscale (value, alpha) or palette indexes. */
  rgba: Uint8Array;
  /** 0 to 255, default 255. */
  opacity?: number;
}

export interface AsepriteInput {
  width: number;
  height: number;
  layers: AsepriteLayerInput[];
  frames: Array<{ durationMs: number; cels: AsepriteCelInput[] }>;
  tags?: Array<{ name: string; from: number; to: number }>;
  /** 32 (RGBA, default), 16 (grayscale) or 8 (indexed). */
  colorDepth?: 8 | 16 | 32;
  /** Indexed files: RGBA entries; the index is the position. */
  palette?: Array<readonly [number, number, number, number]>;
  /** Indexed files: the transparent palette index, default 0. */
  transparentIndex?: number;
}

class Bytes {
  readonly parts: number[] = [];
  byte(v: number): this {
    this.parts.push(v & 255);
    return this;
  }
  word(v: number): this {
    return this.byte(v).byte(v >> 8);
  }
  dword(v: number): this {
    return this.word(v).word(v >>> 16);
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.byte(0);
    return this;
  }
  string(s: string): this {
    const b = Buffer.from(s, "utf8");
    this.word(b.length);
    for (const x of b) this.byte(x);
    return this;
  }
  raw(b: Uint8Array): this {
    for (const x of b) this.byte(x);
    return this;
  }
  get length(): number {
    return this.parts.length;
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

function chunk(type: number, body: Bytes): Bytes {
  return new Bytes()
    .dword(body.length + 6)
    .word(type)
    .raw(body.bytes());
}

function layerChunk(layer: AsepriteLayerInput): Bytes {
  const flags =
    ((layer.visible ?? true) ? 1 : 0) | 2 | (layer.background ? 8 : 0) | (layer.reference ? 64 : 0);
  const body = new Bytes()
    .word(flags)
    .word(layer.type ?? 0)
    .word(layer.childLevel ?? 0)
    .zeros(4)
    .word(layer.blendMode ?? 0)
    .byte(layer.opacity ?? 255)
    .zeros(3)
    .string(layer.name);
  if (layer.type === 2) body.dword(0);
  return chunk(0x2004, body);
}

function celChunk(cel: AsepriteCelInput): Bytes {
  const body = new Bytes()
    .word(cel.layer)
    .word(cel.x)
    .word(cel.y)
    .byte(cel.opacity ?? 255)
    .word(2)
    .word(0)
    .zeros(5)
    .word(cel.width)
    .word(cel.height)
    .raw(deflateSync(cel.rgba, { level: 9 }));
  return chunk(0x2005, body);
}

function paletteChunk(palette: NonNullable<AsepriteInput["palette"]>): Bytes {
  const body = new Bytes()
    .dword(palette.length)
    .dword(0)
    .dword(palette.length - 1)
    .zeros(8);
  for (const [r, g, b, a] of palette) body.word(0).byte(r).byte(g).byte(b).byte(a);
  return chunk(0x2019, body);
}

function tagsChunk(tags: NonNullable<AsepriteInput["tags"]>): Bytes {
  const body = new Bytes().word(tags.length).zeros(8);
  for (const t of tags) {
    body.word(t.from).word(t.to).byte(0).word(0).zeros(6).zeros(3).zeros(1).string(t.name);
  }
  return chunk(0x2018, body);
}

export function asepriteFile(input: AsepriteInput): Uint8Array {
  const depth = input.colorDepth ?? 32;
  const out = new Bytes();
  const frames = input.frames.map((frame, index) => {
    const chunks: Bytes[] = [];
    if (index === 0) {
      if (input.palette) chunks.push(paletteChunk(input.palette));
      for (const layer of input.layers) chunks.push(layerChunk(layer));
      if (input.tags?.length) chunks.push(tagsChunk(input.tags));
    }
    for (const cel of frame.cels) chunks.push(celChunk(cel));
    const size = 16 + chunks.reduce((n, c) => n + c.length, 0);
    const bytes = new Bytes()
      .dword(size)
      .word(0xf1fa)
      .word(chunks.length)
      .word(frame.durationMs)
      .zeros(2)
      .dword(chunks.length);
    for (const c of chunks) bytes.raw(c.bytes());
    return bytes;
  });
  const total = 128 + frames.reduce((n, f) => n + f.length, 0);
  out
    .dword(total)
    .word(0xa5e0)
    .word(frames.length)
    .word(input.width)
    .word(input.height)
    .word(depth)
    .dword(1)
    .word(100)
    .zeros(8)
    .byte(input.transparentIndex ?? 0)
    .zeros(3)
    .word(input.palette?.length ?? 0)
    .byte(1)
    .byte(1)
    .zeros(92);
  for (const f of frames) out.raw(f.bytes());
  return out.bytes();
}

const FERN_FRAMES = 7;

function fill(
  rgba: Uint8Array,
  width: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: readonly [number, number, number, number],
): void {
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) rgba.set(color, (j * width + i) * 4);
  }
}

/**
 * The committed fixture `test/fixtures/aseprite/fern.aseprite`: a 32x40 figure over 7 frames of
 * 100 ms, tags "idle" (0-3) and "walk" (4-6), layers "body", "shade" (half opacity) and a hidden
 * "guide". `edited` recolours the torso in the idle frames, as a developer's edit would.
 */
export function fernAseprite(options: { edited?: boolean } = {}): Uint8Array {
  const width = 32;
  const height = 40;
  const frames = Array.from({ length: FERN_FRAMES }, (_, f) => {
    const bob = f % 2;
    const torso: [number, number, number, number] =
      options.edited && f < 4 ? [180, 60, 60, 255] : [60, 110, 180, 255];
    const body = new Uint8Array(width * height * 4);
    fill(body, width, 11, 4 + bob, 10, 10, [200, 120, 60, 255]);
    fill(body, width, 10, 14 + bob, 12, 14, torso);
    fill(body, width, 10 + f, 28 + bob, 4, 8, [90, 60, 40, 255]);
    fill(body, width, 18 - f, 28 + bob, 4, 8, [90, 60, 40, 255]);
    const shade = new Uint8Array(width * height * 4);
    fill(shade, width, 8, 24 + bob, 16, 8, [20, 20, 40, 255]);
    const guide = new Uint8Array(width * height * 4);
    fill(guide, width, 0, 0, width, height, [255, 0, 255, 255]);
    const cel = (layer: number, rgba: Uint8Array, opacity?: number) => ({
      layer,
      x: 0,
      y: 0,
      width,
      height,
      rgba,
      ...(opacity === undefined ? {} : { opacity }),
    });
    return { durationMs: 100, cels: [cel(0, body), cel(1, shade), cel(2, guide)] };
  });
  return asepriteFile({
    width,
    height,
    layers: [{ name: "body" }, { name: "shade", opacity: 128 }, { name: "guide", visible: false }],
    frames,
    tags: [
      { name: "idle", from: 0, to: 3 },
      { name: "walk", from: 4, to: 6 },
    ],
  });
}
