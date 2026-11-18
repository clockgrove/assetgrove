import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CORE_REGISTRY } from "../src/extensions/registry.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/** Patterns that branch on one kind name: a comparison, a `case`, or a list it is looked up in. */
function nameTests(name: string): RegExp[] {
  const quoted = `["'\`]${escape(name)}["'\`]`;
  return [
    new RegExp(`[!=]==?\\s*${quoted}`),
    new RegExp(`${quoted}\\s*[!=]==?`),
    new RegExp(`\\bcase\\s+${quoted}`),
    new RegExp(`\\[[^\\]\\n]*${quoted}[^\\]\\n]*\\]\\s*\\)?\\s*\\.(includes|indexOf|some)\\b`),
    new RegExp(`new Set\\(\\s*\\[[^\\]\\n]*${quoted}`),
  ];
}

/** The lines of `text` that test `name`, as `<line>: <text>`. */
function offending(text: string, name: string): string[] {
  const patterns = nameTests(name);
  return text
    .split(/\r?\n/)
    .flatMap((line, i) => (patterns.some((p) => p.test(line)) ? [`${i + 1}: ${line.trim()}`] : []));
}

/** The file that defines the kind: it declares `kind: "<name>"` beside its `frames` trait. */
function definesKind(text: string, name: string): boolean {
  return new RegExp(`kind:\\s*["']${escape(name)}["'],\\s*\\n\\s*frames:`).test(text);
}

test("the guard finds a kind-name test in each form it covers", () => {
  for (const line of [
    'if (spec.kind === "sprite-strip") return;',
    'if (kind !== "sprite-strip" || x) {',
    'spec["kind"] !== "sprite-strip" ||',
    '"sprite-strip" === kind',
    'case "sprite-strip":',
    'if (!["still", "sprite-strip"].includes(spec.kind))',
    'const strips = new Set(["sprite-strip"]);',
  ])
    assert.equal(offending(line, "sprite-strip").length, 1, line);
  assert.deepEqual(offending('kind: "sprite-strip",', "sprite-strip"), []);
  assert.deepEqual(
    offending('throw new InputError("a sprite-strip spec needs");', "sprite-strip"),
    [],
  );
});

test("no source file outside a framed kind's own definition tests that kind's name", () => {
  const framed = CORE_REGISTRY.kinds.filter((k) => k.frames !== undefined).map((k) => k.kind);
  assert.deepEqual([...framed].sort(), ["sprite-strip", "still"]);
  const found: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const name of framed) {
      if (definesKind(text, name)) continue;
      for (const hit of offending(text, name))
        found.push(`${relative(SRC, file).replaceAll("\\", "/")}:${hit} (kind ${name})`);
    }
  }
  assert.deepEqual(found, [], "frame behaviour must ask the kind's frames trait, not its name");
});
