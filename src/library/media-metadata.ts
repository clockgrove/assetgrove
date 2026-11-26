import { decodeAudio, frameCount } from "../audio/engine.ts";
import { decodeImage } from "../image/raster.ts";
import { GLB_MEDIA_TYPE, parseGlb } from "../model3d/glb.ts";
import { sniffMediaType } from "../request.ts";
import { sha256Hex } from "./canonical.ts";
import { MediaMissingError, readMedia } from "./lfs.ts";

export type MediaEvidence =
  | {
      format: "assetgrove-media/1";
      sha256: string;
      status: "available";
      mediaType: string;
      width?: number;
      height?: number;
      durationS?: number;
      sampleRate?: number;
      channels?: number;
    }
  | { format: "assetgrove-media/1"; sha256: string; status: "unavailable"; reason: string };

/** Only these measured facts cross the boundary from embedded metadata to library projections. */
export function measureMediaBytes(bytes: Uint8Array, sha256: string): MediaEvidence {
  if (sha256Hex(bytes) !== sha256)
    return { format: "assetgrove-media/1", sha256, status: "unavailable", reason: "hash_mismatch" };
  const mediaType = sniffMediaType(bytes);
  if (mediaType === "image/png" || mediaType === "image/jpeg") {
    try {
      const { width, height } = decodeImage(bytes);
      return {
        format: "assetgrove-media/1",
        sha256,
        status: "available",
        mediaType,
        width,
        height,
      };
    } catch {
      return {
        format: "assetgrove-media/1",
        sha256,
        status: "unavailable",
        reason: "invalid_media",
      };
    }
  }
  if (mediaType === "audio/wav") {
    try {
      const audio = decodeAudio(bytes);
      return {
        format: "assetgrove-media/1",
        sha256,
        status: "available",
        mediaType,
        durationS: frameCount(audio) / audio.sampleRate,
        sampleRate: audio.sampleRate,
        channels: audio.channels.length,
      };
    } catch {
      return {
        format: "assetgrove-media/1",
        sha256,
        status: "unavailable",
        reason: "invalid_media",
      };
    }
  }
  try {
    parseGlb(bytes);
    return { format: "assetgrove-media/1", sha256, status: "available", mediaType: GLB_MEDIA_TYPE };
  } catch {
    return {
      format: "assetgrove-media/1",
      sha256,
      status: "unavailable",
      reason: "unsupported_media",
    };
  }
}

export async function measureMedia(path: string, sha256: string): Promise<MediaEvidence> {
  try {
    const read = await readMedia(path, { sha256 });
    if (!read.matches)
      return {
        format: "assetgrove-media/1",
        sha256,
        status: "unavailable",
        reason: "hash_mismatch",
      };
    if (read.kind === "lfs-pointer")
      return { format: "assetgrove-media/1", sha256, status: "unavailable", reason: "lfs_pointer" };
    return measureMediaBytes(read.bytes, sha256);
  } catch (error) {
    if (error instanceof MediaMissingError)
      return {
        format: "assetgrove-media/1",
        sha256,
        status: "unavailable",
        reason: "missing_file",
      };
    throw error;
  }
}
