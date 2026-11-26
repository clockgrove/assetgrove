import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  audioSettings,
  EBU_R128_REFERENCE,
  withSettingsLoudness,
  type AudioLoudness,
} from "../src/audio/profile.ts";
import { InputError } from "../src/errors.ts";
import { PROFILE_PRESETS } from "../src/init.ts";
import { validateProfile } from "../src/profile.ts";
import { loadSettings, SettingsError } from "../src/settings.ts";
import type { TargetProfile } from "../src/types.ts";

const LOUDNESS: AudioLoudness = {
  target: -16,
  tolerance: 1,
  truePeakCeiling: -1.5,
  encoderHeadroom: 1,
};

function profileWith(audio?: unknown): TargetProfile {
  return {
    ...PROFILE_PRESETS["sprite-32"]!(),
    ...(audio !== undefined && { audio }),
  } as TargetProfile;
}

const refused = (pattern: RegExp) => (error: unknown) => {
  assert.ok(error instanceof InputError, String(error));
  assert.match(error.message, pattern);
  return true;
};

test("audioSettings fills every default around the loudness block", () => {
  const audio = audioSettings(profileWith({ loudness: LOUDNESS }));
  assert.deepEqual(audio, {
    sampleRate: 44100,
    bitDepth: "16",
    channels: { sfx: "mono", ambience: "stereo", music: "stereo" },
    loudness: LOUDNESS,
    durationToleranceS: 0.5,
    silenceLimitMs: 50,
    setSpreadLu: 2,
  });
});

test("audioSettings keeps what the profile sets", () => {
  const audio = audioSettings(
    profileWith({
      sampleRate: 48000,
      bitDepth: "24",
      channels: { sfx: "stereo" },
      loudness: LOUDNESS,
      durationToleranceS: 1,
      silenceLimitMs: 10,
      setSpreadLu: 3,
    }),
  );
  assert.equal(audio.sampleRate, 48000);
  assert.equal(audio.bitDepth, "24");
  assert.deepEqual(audio.channels, { sfx: "stereo", ambience: "stereo", music: "stereo" });
  assert.equal(audio.durationToleranceS, 1);
  assert.equal(audio.silenceLimitMs, 10);
  assert.equal(audio.setSpreadLu, 3);
});

test("a profile without audio.loudness is refused naming the block", () => {
  assert.throws(() => audioSettings(profileWith()), refused(/audio\.loudness/));
  assert.throws(
    () => audioSettings(profileWith({ sampleRate: 48000 })),
    refused(/audio\.loudness/),
  );
});

test("invalid audio fields are refused by name", () => {
  const bad = (audio: unknown, pattern: RegExp) =>
    assert.throws(() => audioSettings(profileWith(audio)), refused(pattern));
  bad({ loudness: LOUDNESS, sampleRate: 12.5 }, /audio\.sampleRate/);
  bad({ loudness: LOUDNESS, bitDepth: "12" }, /audio\.bitDepth/);
  bad({ loudness: LOUDNESS, channels: { sfx: "surround" } }, /audio\.channels\.sfx/);
  bad({ loudness: { ...LOUDNESS, tolerance: -1 } }, /audio\.loudness\.tolerance/);
  bad({ loudness: { ...LOUDNESS, target: 3 } }, /audio\.loudness\.target/);
  bad({ loudness: { target: -23 } }, /audio\.loudness\.tolerance/);
  bad({ loudness: LOUDNESS, setSpreadLu: -2 }, /audio\.setSpreadLu/);
  bad({ loudness: LOUDNESS, extra: 1 }, /audio\./);
});

test("the EBU R128 reference is -23 LUFS and -1 dBTP", () => {
  assert.equal(EBU_R128_REFERENCE.target, -23);
  assert.equal(EBU_R128_REFERENCE.truePeakCeiling, -1);
});

test("a profile file with an audio block validates", () => {
  const value = { ...PROFILE_PRESETS["sprite-32"]!(), audio: { loudness: LOUDNESS } };
  const profile = validateProfile(value as unknown as Record<string, unknown>, "profile.json");
  assert.deepEqual(profile.audio, { loudness: LOUDNESS });
});

function load(settings: unknown) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-audio-settings-")));
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ format: "assetgrove-settings/2", ...(settings as object) }));
  return loadSettings({ env: { ASSETGROVE_CONFIG: path, HOME: dir }, cwd: dir });
}

test("a settings file's audio.loudness loads into Settings.audio", () => {
  assert.deepEqual(load({ audio: { loudness: LOUDNESS } }).audio, { loudness: LOUDNESS });
  assert.equal(load({}).audio, undefined);
});

test("an invalid audio block in settings is refused", () => {
  const invalid = (error: unknown) => {
    assert.ok(error instanceof SettingsError, String(error));
    assert.equal(error.code, "settings_invalid");
    return true;
  };
  assert.throws(() => load({ audio: { loudness: { target: -23 } } }), invalid);
  assert.throws(() => load({ audio: { loudness: { ...LOUDNESS, tolerance: -1 } } }), invalid);
  assert.throws(() => load({ audio: { other: 1 } }), invalid);
});

test("withSettingsLoudness fills only a profile without the block", () => {
  const bare = profileWith();
  const filled = withSettingsLoudness(bare, LOUDNESS);
  assert.deepEqual(filled.audio, { loudness: LOUDNESS });
  assert.equal(bare.audio, undefined);
  assert.deepEqual(audioSettings(filled).loudness, LOUDNESS);

  const own = profileWith({ sampleRate: 48000, loudness: { ...LOUDNESS, target: -23 } });
  assert.equal(withSettingsLoudness(own, LOUDNESS), own);
  assert.equal(withSettingsLoudness(bare, undefined), bare);

  const partial = withSettingsLoudness(profileWith({ sampleRate: 48000 }), LOUDNESS);
  assert.deepEqual(partial.audio, { sampleRate: 48000, loudness: LOUDNESS });
});
