/**
 * What the review dock can read (issue #480, acceptance 3). The Godot test checks that every path
 * in the store's `opened` list is in the runs folder, but the store fills that list itself. This
 * test needs no Godot: it reads the addon's GDScript and holds every file-system read to the
 * store's recording helpers, each of which appends its path to `opened` before it reads. A read
 * added anywhere else in the addon, or a helper that stops recording, fails here.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ADDON = join(import.meta.dirname, "..", "addons", "assetgrove_review");

/** The store's helpers that may touch the file system, and what each must record first. */
const HELPERS = ["_list_dirs", "_exists", "_read_text", "_load_image"];
const STORE = "review_store.gd";

/**
 * A GDScript call that reads the file system: a FileAccess, DirAccess or ResourceLoader call, an
 * image or resource load, a ConfigFile or other `.load(...)` or `.load_from_*(...)`, a `load(...)`,
 * or an OS read. A call into the store's own API (`store.load_candidate`) is not a read here.
 * `FileAccess` as a type (the actions' process pipes) is not a call and does not match.
 */
const READ =
  /\b(?:FileAccess|DirAccess|ResourceLoader)\s*\.\s*\w+\s*\(|\bImage\s*\.\s*load\w*\s*\(|\.\s*load(?:_from_\w+)?\s*\(|(?<![\w.])load\s*\(|\bOS\s*\.\s*read\w*\s*\(/;

/** `preload` of the addon's own scripts is how they find each other, and reads nothing else. */
const OWN_PRELOAD = /^\s*const \w+ = preload\("review_\w+\.gd"\)\s*$/;

interface Line {
  file: string;
  number: number;
  text: string;
  func: string;
}

/** The addon's lines with the function each is in ("" at the top level), comments stripped. */
function addonLines(): Line[] {
  const lines: Line[] = [];
  const files = readdirSync(ADDON).filter((name) => name.endsWith(".gd"));
  assert.ok(files.includes(STORE), files.join(", "));
  for (const file of files) {
    let func = "";
    readFileSync(join(ADDON, file), "utf8")
      .split(/\r?\n/)
      .forEach((raw, index) => {
        const text = raw.replace(/#.*$/, "");
        const declared = /^(?:static\s+)?func\s+(\w+)/.exec(text);
        if (declared) func = declared[1]!;
        else if (/^\S/.test(text)) func = "";
        lines.push({ file, number: index + 1, text, func });
      });
  }
  return lines;
}

test("the dock's addon reads the file system only through the store's recording helpers", () => {
  const lines = addonLines();
  const reads = lines.filter((l) => READ.test(l.text) && !OWN_PRELOAD.test(l.text));
  const outside = reads.filter((l) => l.file !== STORE || !HELPERS.includes(l.func));
  assert.deepEqual(
    outside.map((l) => `${l.file}:${l.number}: ${l.text.trim()}`),
    [],
    "a file-system read outside the store's recording helpers",
  );
  for (const helper of HELPERS) {
    const body = lines.filter((l) => l.file === STORE && l.func === helper);
    assert.ok(body.length > 0, `${STORE} has no ${helper}`);
    const statements = body.slice(1).filter((l) => l.text.trim() !== "");
    assert.match(
      statements[0]?.text ?? "",
      /^\s*opened\.append\(path\)\s*$/,
      `${helper} records its path before it reads`,
    );
    assert.ok(
      body.some((l) => READ.test(l.text)),
      `${helper} reads (or drop it from the helpers)`,
    );
  }
});

test("the read check catches a read the store does not record", () => {
  const sample = [
    'var text := FileAccess.get_file_as_string("res://game/notes/private.txt")',
    'var dir := DirAccess.open("res://")',
    'var res = load("res://game/notes/private.tres")',
    'var res = ResourceLoader.load("res://x.tres")',
    'var image := Image.load_from_file("res://x.png")',
    'config.load("res://project.godot")',
  ];
  for (const text of sample) assert.ok(READ.test(text), text);
  for (const text of [
    'var stdio: FileAccess = started["stdio"]',
    "func _drain(pipe: FileAccess) -> PackedByteArray:",
    "_load_image(file)",
    "var image := _load_image(file)",
    "var loaded: Dictionary = store.load_candidate(run_id, candidate_id)",
  ])
    assert.ok(!READ.test(text), text);
});
