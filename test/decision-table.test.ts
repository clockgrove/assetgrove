import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const gatewayDir = path.join(root, "src", "gateway");
const heading = "### Decisions a provider script answers";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === gatewayDir ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function read(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/** Operation id -> files where core passes it to `decide`. Gateway adapters implement decide, so they are skipped. */
function askedOperations(): Map<string, string[]> {
  const files = sourceFiles(path.join(root, "src"));
  const constants = new Map<string, string>();
  for (const file of files) {
    for (const match of read(file).matchAll(/export const (\w+) = "([^"]*)";/g)) {
      constants.set(match[1], match[2]);
    }
  }
  const asked = new Map<string, string[]>();
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    for (const match of read(file).matchAll(/\.decide\(\s*([^,\s)]+)/g)) {
      const arg = match[1];
      const literal = /^(["'`])([^"'`$]*)\1$/.exec(arg);
      const operation = literal ? literal[2] : constants.get(arg);
      assert.ok(
        operation !== undefined,
        `${relative} passes ${arg} to decide, which is neither a string literal nor an exported string constant in src`,
      );
      asked.set(operation, [...(asked.get(operation) ?? []), relative]);
    }
  }
  return asked;
}

function tableRows(): Map<string, string> {
  const lines = read(path.join(root, "docs", "generation-knobs.md")).split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.ok(start >= 0, `docs/generation-knobs.md has no "${heading}" heading`);
  const rows = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("#")) break;
    const cells = line.split("|").map((cell) => cell.trim());
    const id = /^`([^`]+)`$/.exec(cells[1] ?? "");
    if (!id) continue;
    assert.ok(!rows.has(id[1]), `decision table lists ${id[1]} twice`);
    rows.set(id[1], cells[2] ?? "");
  }
  return rows;
}

test("the scan finds the operations core asks", () => {
  const asked = askedOperations();
  assert.ok(asked.has("model3d-facing"));
  assert.ok(asked.has("reference-view"));
});

test("every operation core passes to decide has a row in the decision table", () => {
  const rows = tableRows();
  const missing = [...askedOperations()]
    .filter(([operation]) => !rows.has(operation))
    .map(([operation, files]) => `${operation} (asked in ${[...new Set(files)].join(", ")})`);
  assert.deepEqual(missing, [], "operations with no row in docs/generation-knobs.md");
});

test("every row in the decision table names an operation core still asks", () => {
  const asked = askedOperations();
  const stale = [...tableRows().keys()].filter((operation) => !asked.has(operation));
  assert.deepEqual(stale, [], "rows naming an operation core no longer passes to decide");
});

test("every row's question is score, boolean or choice", () => {
  for (const [operation, question] of tableRows()) {
    const words = [...question.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    assert.ok(words.length > 0, `${operation}: Question names none of score, boolean, choice`);
    for (const word of words) {
      assert.ok(
        ["score", "boolean", "choice"].includes(word),
        `${operation}: Question names \`${word}\`, not score, boolean or choice`,
      );
    }
  }
});
