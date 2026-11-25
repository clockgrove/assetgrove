/**
 * Synthetic WAV fixtures, written with wavefile: a short sine tone at a given rate and channel
 * count. No recorded or vendor audio.
 */
import wavefile from "wavefile";

const { WaveFile } = wavefile;

export interface ToneOptions {
  sampleRate?: number;
  channels?: number;
  /** Samples per channel. */
  length?: number;
  /** The wavefile bit depth: "16", "24" or "32f". */
  bitDepth?: "16" | "24" | "32f";
}

/** A sine tone; each channel at its own phase, so stereo channels differ. */
export function toneWav(options: ToneOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 44100;
  const channels = options.channels ?? 1;
  const length = options.length ?? 4410;
  const bitDepth = options.bitDepth ?? "16";
  const full = bitDepth === "32f" ? 1 : bitDepth === "24" ? 8388607 : 32767;
  const samples = Array.from({ length: channels }, (_, c) =>
    Array.from({ length }, (_, i) => {
      const v = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate + c);
      return bitDepth === "32f" ? v : Math.round(v * full);
    }),
  );
  const wav = new WaveFile();
  wav.fromScratch(channels, sampleRate, bitDepth, channels === 1 ? samples[0]! : samples);
  return new Uint8Array(wav.toBuffer());
}

/** The four-character ids of a RIFF file's top-level chunks, in order. */
export function riffChunkIds(bytes: Uint8Array): string[] {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ids: string[] = [];
  for (let at = 12; at + 8 <= b.length; ) {
    const size = b.readUInt32LE(at + 4);
    ids.push(b.toString("latin1", at, at + 4));
    at += 8 + size + (size & 1);
  }
  return ids;
}

/** The bytes with every top-level chunk of `id` removed and the RIFF size set to match. */
export function withoutChunk(bytes: Uint8Array, id: string): Uint8Array {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Buffer[] = [Buffer.from(b.subarray(0, 12))];
  for (let at = 12; at + 8 <= b.length; ) {
    const size = b.readUInt32LE(at + 4);
    const end = Math.min(b.length, at + 8 + size + (size & 1));
    if (b.toString("latin1", at, at + 4) !== id) kept.push(b.subarray(at, end));
    at = end;
  }
  const out = Buffer.concat(kept);
  out.writeUInt32LE(out.length - 8, 4);
  return new Uint8Array(out);
}
