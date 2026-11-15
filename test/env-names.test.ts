import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Every environment name the program may read. */
const ALLOWED = [
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "TRIPO_API_KEY",
  "ASSETGROVE_CONFIG",
  "ASSETGROVE_WORK_ITEM",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "HOME",
  "USERPROFILE",
  "GIT_DIR",
  "PATH",
  "PATHEXT",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
];

/** The functions in src/env.ts that index the environment by a name they are given. */
const DYNAMIC_READERS = new Set(["refusedVariables", "keyValue", "windowsSearchPath"]);

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "dist", ".cache"].includes(entry.name) ? [] : files(path, pattern);
    }
    return pattern.test(entry.name) ? [path] : [];
  });
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const where = (file: ts.SourceFile, node: ts.Node) =>
  `${relative(root, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

const isProcessEnv = (node: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === "env") ||
  (ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === "env");

test("no module under src/ but env.ts reads process.env", () => {
  const offenders: string[] = [];
  for (const path of files(join(root, "src"), /\.ts$/)) {
    if (path === join(root, "src", "env.ts")) continue;
    const file = parse(path);
    walk(file, (node) => {
      const destructured =
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        ts.isIdentifier(node.initializer) &&
        node.initializer.text === "process" &&
        ts.isObjectBindingPattern(node.name) &&
        node.name.elements.some((e) => (e.propertyName ?? e.name).getText() === "env");
      if (isProcessEnv(node) || destructured) offenders.push(where(file, node));
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `process.env is read outside src/env.ts at ${offenders.join(", ")}`,
  );
});

test("the names src/env.ts reads equal the allowed list", () => {
  const file = parse(join(root, "src", "env.ts"));
  const names = new Set<string>();
  const strays: string[] = [];
  walk(file, (node) => {
    if (ts.isStringLiteralLike(node) && /^[A-Z][A-Z0-9_]*$/.test(node.text)) names.add(node.text);
    if (!ts.isElementAccessExpression(node) || ts.isStringLiteralLike(node.argumentExpression)) {
      return;
    }
    const target = node.expression;
    if (!(isProcessEnv(target) || (ts.isIdentifier(target) && target.text === "env"))) return;
    let fn: ts.Node | undefined = node;
    while (fn && !ts.isFunctionDeclaration(fn)) fn = fn.parent;
    if (!fn || !DYNAMIC_READERS.has((fn as ts.FunctionDeclaration).name?.text ?? "")) {
      strays.push(where(file, node));
    }
  });
  assert.deepEqual([...names].sort(), [...ALLOWED].sort());
  assert.deepEqual(
    strays,
    [],
    `src/env.ts indexes the environment by a computed name outside ${[...DYNAMIC_READERS].join(", ")} at ${strays.join(", ")}`,
  );
});

test("bench/ and packages/ read only allowed names", () => {
  const bad: string[] = [];
  for (const dir of ["bench", "packages"]) {
    for (const path of files(join(root, dir), /\.(ts|js|mjs|cjs)$/)) {
      const file = parse(path);
      walk(file, (node) => {
        if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
          if (!ALLOWED.includes(node.name.text)) {
            bad.push(`${where(file, node)} reads ${node.name.text}`);
          }
        } else if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression)) {
          const key = node.argumentExpression;
          if (!ts.isStringLiteralLike(key))
            bad.push(`${where(file, node)} indexes by a computed name`);
          else if (!ALLOWED.includes(key.text)) bad.push(`${where(file, node)} reads ${key.text}`);
        }
      });
    }
  }
  assert.deepEqual(bad, [], `names outside the allowed list: ${bad.join("; ")}`);
});
