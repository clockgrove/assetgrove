/**
 * The pack's setup: a binary the settings name is used as it is; otherwise Godot 4.7.2 for this
 * platform is downloaded through core's pinned download, pinned to the SHA512 Godot publishes,
 * and unpacked under the state directory. The download here is served from a local archive.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { PinnedDownload, SetupContext } from "@clockgrove/assetgrove/extension";
import { tempProject } from "@clockgrove/assetgrove/testing";
import { zipSync } from "fflate";
import { GODOT_RELEASE, PACKAGE, SETTING, archiveFor, setupGodot } from "../src/setup.ts";
import { buildPack, packNodeModules } from "./helpers/pack.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-godot-setup-")));
after(() => rm(root, { recursive: true, force: true }));

/** A setup context whose download serves `zip` and records each pin it was asked for. */
function context(dir: string, zip: Uint8Array, pins: PinnedDownload[]): SetupContext {
  return {
    stateDir: dir,
    dir: join(dir, "models"),
    search: {} as SetupContext["search"],
    log: () => {},
    download: async (pin) => {
      pins.push(pin);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "downloaded.zip");
      writeFileSync(path, zip);
      return path;
    },
  };
}

test("every pinned build is Godot 4.7.2 from Godot's release, pinned to a SHA512", () => {
  assert.equal(GODOT_RELEASE.version, "4.7.2");
  assert.equal(GODOT_RELEASE.release, "4.7.2-stable");
  for (const url of GODOT_RELEASE.urls)
    assert.match(
      url,
      /^https:\/\/github\.com\/godotengine\/godot\/releases\/download\/4\.7\.2-stable\/$/,
    );
  for (const [platform, pin] of Object.entries(GODOT_RELEASE.platforms)) {
    assert.match(pin.sha512, /^[0-9a-f]{128}$/, platform);
    assert.match(pin.archive, /^Godot_v4\.7\.2-stable_.*\.zip$/, platform);
  }
  for (const key of ["linux-x64", "darwin-arm64", "win32-x64"])
    assert.ok(GODOT_RELEASE.platforms[key], key);
  assert.throws(() => archiveFor("aix", "ppc64"), /no pinned build for aix-ppc64/);
});

test("a binary the settings name is used without a download", async () => {
  const pins: PinnedDownload[] = [];
  const binary = join(root, "godot-from-settings");
  writeFileSync(binary, "#!/bin/sh\n");
  const ctx = context(join(root, "settings"), new Uint8Array(), pins);
  assert.deepEqual(await setupGodot(ctx, { godot: binary }), {
    godot: binary,
    version: "4.7.2",
    source: "settings",
    setting: SETTING,
  });
  assert.deepEqual(pins, []);
  await assert.rejects(setupGodot(ctx, { godot: join(root, "missing") }), {
    code: "invalid_input",
  });
});

test("without one, the pinned build is downloaded by its SHA512 and unpacked", async () => {
  const pins: PinnedDownload[] = [];
  const pin = archiveFor("linux", "x64");
  const zip = zipSync({ [pin.binary]: new TextEncoder().encode("#!/bin/sh\necho godot\n") });
  const dir = join(root, "download");
  const ctx = context(dir, zip, pins);
  const result = await setupGodot(ctx, {}, "linux", "x64");
  assert.deepEqual(pins, [
    {
      urls: [`${GODOT_RELEASE.urls[0]}${pin.archive}`],
      version: "4.7.2-stable",
      sha512: pin.sha512,
      path: `godot/4.7.2-stable/${pin.archive}`,
    },
  ]);
  assert.equal(result.source, "download");
  assert.equal(result.godot, join(dir, "models", "godot", "4.7.2-stable", "linux-x64", pin.binary));
  assert.ok(statSync(result.godot).isFile());
  if (process.platform !== "win32") assert.equal(statSync(result.godot).mode & 0o111, 0o111);
  // Run again: the unpacked binary is kept.
  assert.equal((await setupGodot(ctx, {}, "linux", "x64")).godot, result.godot);

  // An archive without the binary, or with an entry that climbs out, is refused.
  const empty = context(join(root, "empty"), zipSync({ "README.txt": new Uint8Array([1]) }), []);
  await assert.rejects(setupGodot(empty, {}, "linux", "x64"), /holds no/);
  const escape = context(join(root, "escape"), zipSync({ "../outside": new Uint8Array([1]) }), []);
  await assert.rejects(setupGodot(escape, {}, "linux", "x64"), /outside its folder/);
});

test("assetgrove extensions setup godot runs the built pack's setup through core", async () => {
  const stage = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-godot-cli-")));
  const project = tempProject();
  try {
    const installed = project.install(buildPack(stage), PACKAGE);
    symlinkSync(packNodeModules, join(installed, "node_modules"), "junction");
    const binary = join(stage, "godot-binary");
    writeFileSync(binary, "not run by setup");
    project.writeSettings({
      extensions: [PACKAGE],
      extensionSettings: { [PACKAGE]: { godot: binary } },
    });
    const listed = await project.cli(["extensions", "--json"]);
    assert.equal(listed.code, 0, listed.stderr);
    const godot = (listed.json?.["extensions"] as Array<Record<string, unknown>>).find(
      (e) => e["name"] === "godot",
    );
    assert.deepEqual(godot?.["presets"], ["godot:sprite-frames"]);
    assert.deepEqual(godot?.["tools"], ["godot:engine"]);
    assert.equal(godot?.["setup"], true);
    const result = await project.cli(["extensions", "setup", "godot", "--json"]);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.json?.["godot"], binary);
    assert.equal(result.json?.["source"], "settings");
  } finally {
    project.close();
    await rm(stage, { recursive: true, force: true });
  }
});
