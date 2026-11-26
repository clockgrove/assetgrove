/**
 * The waveform cell of an audio candidate on the contact sheet: one lane per channel, each pixel
 * column a vertical line from the lowest to the highest sample it covers. Samples only, no text,
 * so the sheet stays numbers-only; the measured numbers are in the stage JSON.
 */
import type { AudioContext } from "../media.ts";
import { createRaster, setPixel } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";

const BACKGROUND = [248, 248, 248, 255];
const INK = [30, 30, 36, 255];
const SEPARATOR = [200, 200, 206, 255];

/** The edge of the cell when the caller gives none: the contact sheet's cell edge. */
const DEFAULT_SIZE = 96;

/**
 * A `size` px square raster of the audio's waveform. The height is split into one lane per
 * channel with a one-pixel separator between lanes; a lane's centre line is sample 0, its top and
 * bottom are 1 and -1. An empty channel draws only its centre line.
 */
export function waveformRaster(audio: AudioContext, size = DEFAULT_SIZE): Raster {
  const raster = createRaster(size, size);
  for (let i = 0; i < raster.data.length; i += 4) raster.data.set(BACKGROUND, i);
  const lanes = Math.max(1, audio.channels.length);
  for (let lane = 0; lane < lanes; lane++) {
    const top = Math.floor((lane * size) / lanes);
    const end = Math.floor(((lane + 1) * size) / lanes);
    const last = lane === lanes - 1;
    const height = Math.max(1, end - top - (last ? 0 : 1));
    if (!last) for (let x = 0; x < size; x++) setPixel(raster, x, end - 1, SEPARATOR);
    const centre = top + Math.floor((height - 1) / 2);
    const half = (height - 1) / 2;
    const row = (v: number) =>
      Math.min(
        top + height - 1,
        Math.max(top, Math.round(centre - Math.max(-1, Math.min(1, v)) * half)),
      );
    const samples = audio.channels[lane] ?? new Float32Array(0);
    for (let x = 0; x < size; x++) {
      let low = 0;
      let high = 0;
      if (samples.length > 0) {
        const from = Math.floor((x * samples.length) / size);
        const to = Math.min(
          samples.length,
          Math.max(from + 1, Math.floor(((x + 1) * samples.length) / size)),
        );
        low = Infinity;
        high = -Infinity;
        for (let i = from; i < to; i++) {
          const v = samples[i] as number;
          if (v < low) low = v;
          if (v > high) high = v;
        }
      }
      const a = row(high);
      const b = row(low);
      for (let y = Math.min(a, b, centre); y <= Math.max(a, b, centre); y++)
        setPixel(raster, x, y, INK);
    }
  }
  return raster;
}
