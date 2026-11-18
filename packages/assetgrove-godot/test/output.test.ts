/**
 * Reading Godot's output and text files as data: error lines fail a run whatever the exit code,
 * and the UIDs of `.import` files and resources are read, never written, by the pack.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { externalReferences, importUid, resourceHeader } from "../src/godot-text.ts";
import { errorLines } from "../src/output.ts";

test("every ERROR line counts, with or without colour, and nothing else does", () => {
  const output = [
    "Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org",
    "\u001b[91mERROR: Error importing 'res://assets/fern-walk.png'.\u001b[0m",
    "   at: _reimport_file (editor/file_system/editor_file_system.cpp:3201)",
    "SCRIPT ERROR: Parse Error: Unexpected identifier.",
    "USER ERROR: assetgrove-godot: res://fern.tres did not load",
    'WARNING: 36 RIDs of type "CanvasItem" were leaked.',
    "an ERROR inside a line is not an error line",
  ].join("\r\n");
  assert.deepEqual(errorLines(output), [
    "ERROR: Error importing 'res://assets/fern-walk.png'.",
    "SCRIPT ERROR: Parse Error: Unexpected identifier.",
    "USER ERROR: assetgrove-godot: res://fern.tres did not load",
  ]);
  assert.deepEqual(errorLines("[ DONE ] reimport\n"), []);
});

test("an .import's UID is its [remap] uid", () => {
  const text = [
    "[remap]",
    "",
    'importer="texture"',
    'uid="uid://cq2425ngttrok"',
    'path="res://.godot/imported/fern-idle.png-9c56.ctex"',
    "",
    "[params]",
    'uid="uid://notthisone"',
  ].join("\n");
  assert.equal(importUid(text), "uid://cq2425ngttrok");
  assert.equal(importUid("[params]\ncompress/mode=0\n"), undefined);
});

test("a resource's header and references are read as text", () => {
  const text = [
    '[gd_resource type="SpriteFrames" format=3 uid="uid://j8ywmkggyqim"]',
    "",
    '[ext_resource type="Texture2D" uid="uid://cry7yfo2r3ek0" path="res://media/idle.png" id="1_e40do"]',
    '[ext_resource type="Texture2D" path="res://media/walk.png" id="2_x"]',
  ].join("\n");
  assert.deepEqual(resourceHeader(text), { type: "SpriteFrames", uid: "uid://j8ywmkggyqim" });
  assert.deepEqual(externalReferences(text), [
    { type: "Texture2D", uid: "uid://cry7yfo2r3ek0", path: "res://media/idle.png" },
    { type: "Texture2D", uid: undefined, path: "res://media/walk.png" },
  ]);
  assert.equal(resourceHeader("[gd_scene format=3]"), undefined);
  assert.equal(resourceHeader('[gd_resource type="X" uid="not a uid"]')?.uid, undefined);
});
