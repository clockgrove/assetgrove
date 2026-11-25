/**
 * The default texture filter warning: how `project.godot` is read as data, and when a pixel-art
 * profile's hand-off warns. No Godot runs here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TargetRead } from "@clockgrove/assetgrove/extension";
import { sampleProfile } from "@clockgrove/assetgrove/testing";
import { defaultTextureFilter, textureFilterWarning } from "../src/texture-filter.ts";

const KEY = "textures/canvas_textures/default_texture_filter";
const pixel = sampleProfile({ style: { edges: "crisp", color: { rule: "palette" } } });
const reader =
  (files: Record<string, string>): TargetRead =>
  async (path) =>
    files[path] === undefined ? undefined : new TextEncoder().encode(files[path]);

test("the parser reads the filter under [rendering] and nothing else", () => {
  assert.equal(defaultTextureFilter(""), undefined);
  assert.equal(defaultTextureFilter(`[application]\n${KEY}=1\n`), undefined);
  assert.equal(
    defaultTextureFilter('[rendering]\nrenderer/rendering_method="mobile"\n'),
    undefined,
  );
  assert.equal(defaultTextureFilter(`[rendering]\n\n${KEY}=0\n`), 0);
  assert.equal(defaultTextureFilter(`[rendering]\n${KEY} = 1\n`), 1);
  assert.equal(defaultTextureFilter(`[rendering]\n${KEY}=3\n[display]\nx=1\n`), 3);
  assert.equal(defaultTextureFilter(`[other]\n[rendering]\n${KEY}=2`), 2);
  // A line with no key, and a long run of spaces, read as nothing in linear time.
  assert.equal(defaultTextureFilter(`[rendering]\n=0\n<${" ".repeat(10_000)}\n`), undefined);
  assert.equal(defaultTextureFilter(`[rendering]\n${KEY}${" ".repeat(10_000)}=1\n`), 1);
});

test("the parser skips ; comments and reads CRLF files", () => {
  assert.equal(defaultTextureFilter(`[rendering]\r\n; ${KEY}=1\r\n${KEY}=0\r\n`), 0);
  assert.equal(defaultTextureFilter(`; [rendering]\r\n${KEY}=1\r\n`), undefined);
});

test("a pixel-art profile with a Linear filter in project.godot gets one warning naming the setting and value", async () => {
  const read = reader({ "project.godot": `[rendering]\n${KEY}=1\n` });
  const [warning, ...rest] = await textureFilterWarning(pixel, "", read);
  assert.deepEqual(rest, []);
  assert.match(
    warning!,
    /^project\.godot sets rendering\/textures\/canvas_textures\/default_texture_filter to Linear \(1\)/,
  );
  assert.match(warning!, /wants Nearest \(0\)/);
  assert.doesNotMatch(warning!, /\n/);
  const mipmap = await textureFilterWarning(
    pixel,
    "",
    reader({ "project.godot": `[rendering]\n${KEY}=3\n` }),
  );
  assert.match(mipmap[0]!, /to Nearest Mipmap \(3\)/);
});

test("an absent setting warns that Godot's default is Linear", async () => {
  const [warning] = await textureFilterWarning(
    pixel,
    "",
    reader({ "project.godot": "[application]\n" }),
  );
  assert.match(
    warning!,
    /leaves rendering\/textures\/canvas_textures\/default_texture_filter at Godot's default, Linear \(1\)/,
  );
});

test("Nearest, no project.godot, or a profile that is not pixel art warn of nothing", async () => {
  const nearest = reader({ "project.godot": `[rendering]\n${KEY}=0\n` });
  const linear = reader({ "project.godot": `[rendering]\n${KEY}=1\n` });
  assert.deepEqual(await textureFilterWarning(pixel, "", nearest), []);
  assert.deepEqual(await textureFilterWarning(pixel, "", reader({})), []);
  const crispOnly = sampleProfile({ style: { edges: "crisp" } });
  const fullColour = sampleProfile({ style: { edges: "crisp", color: { rule: "full" } } });
  const soft = sampleProfile({ style: { edges: "antialiased", color: { rule: "palette" } } });
  for (const profile of [crispOnly, fullColour, soft, sampleProfile()])
    assert.deepEqual(await textureFilterWarning(profile, "", linear), []);
});

test("the project.godot is read from the project's folder", async () => {
  const read = reader({
    "project.godot": `[rendering]\n${KEY}=0\n`,
    "game/project.godot": `[rendering]\n${KEY}=2\n`,
  });
  assert.deepEqual(await textureFilterWarning(pixel, "", read), []);
  const [warning] = await textureFilterWarning(pixel, "game", read);
  assert.match(warning!, /^game\/project\.godot sets .* to Linear Mipmap \(2\)/);
});
