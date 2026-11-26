/**
 * A scripted audio provider for tests and offline runs: every `audio` call answers with a
 * synthetic stereo sine tone (test/fixtures/wav.ts) as long as the request's `durationS`, so every
 * core audio kind's default recipe makes a master its exact checks pass. No recorded or vendor audio.
 */
import type { Script } from "../../src/gateway/scripted.ts";
import { toneWav } from "./wav.ts";

const script: Script = {
  image() {
    throw new Error("no image call expected");
  },
  vision() {
    throw new Error("no vision call expected");
  },
  audio(request) {
    const length = Math.round((request.durationS ?? 1) * 44100);
    return {
      audio: { mediaType: "audio/wav", bytes: toneWav({ channels: 2, length }) },
      costUsd: 0.08,
    };
  },
};

export default script;
