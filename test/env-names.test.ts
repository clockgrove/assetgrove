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

/** `process` or `globalThis.process` (also `global.process`). */
const isProcess = (node: ts.Node): boolean =>
  (ts.isIdentifier(node) && node.text === "process") ||
  (ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ["globalThis", "global"].includes(node.expression.text) &&
    node.name.text === "process");

/** The property a member access names, when the name is static. */
const memberName = (node: ts.Node): string | undefined =>
  ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;

const isProcessEnv = (node: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
  isProcess(node.expression) &&
  memberName(node) === "env";

/**
 * Why a node reads the environment outside src/env.ts, else undefined: a `process.env` access
 * (through `process` or `globalThis.process`), `process` used other than as `process.<static name>`
 * (an alias, a destructuring, a pass), or an import from the `process` module.
 */
function envRead(node: ts.Node): string | undefined {
  if (isProcessEnv(node)) return "reads process.env";
  if (
    isProcess(node) &&
    !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
    !(ts.isPropertyAccessExpression(node) && isProcess(node.parent))
  ) {
    const parent = node.parent;
    const member =
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === node
        ? memberName(parent)
        : undefined;
    if (member === undefined) return "uses process other than by a static member";
  }
  if (
    ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    ["process", "node:process"].includes(node.moduleSpecifier.text)
  ) {
    return "imports the process module";
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.some((a) => ts.isStringLiteralLike(a) && ["process", "node:process"].includes(a.text))
  ) {
    return "requires the process module";
  }
  return undefined;
}

test("no module under src/ but env.ts reads process.env", () => {
  const offenders: string[] = [];
  for (const path of files(join(root, "src"), /\.ts$/)) {
    if (path === join(root, "src", "env.ts")) continue;
    const file = parse(path);
    walk(file, (node) => {
      const why = envRead(node);
      if (why !== undefined) offenders.push(`${where(file, node)} ${why}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `the environment is read outside src/env.ts at ${offenders.join(", ")}`,
  );
});

test("the environment check catches every way to reach process.env", () => {
  const reads = (source: string) => {
    const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    walk(file, (node) => {
      const why = envRead(node);
      if (why !== undefined) found.push(why);
    });
    return found.length > 0;
  };
  for (const source of [
    "process.env.X;",
    'process["env"];',
    "globalThis.process.env;",
    "const p = process; p.env;",
    "const { env } = process;",
    'import { env } from "node:process";',
    'import process2 from "process";',
    'require("node:process");',
  ]) {
    assert.equal(reads(source), true, source);
  }
  for (const source of ["process.platform;", "process.exitCode = 1;", "globalThis.process.cwd();"]) {
    assert.equal(reads(source), false, source);
  }
});

test("every keyValue call under src/ with a literal name names an allowed name", () => {
  const bad: string[] = [];
  for (const path of files(join(root, "src"), /\.ts$/)) {
    const file = parse(path);
    walk(file, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name !== "keyValue") return;
      const arg = node.arguments[0];
      if (arg === undefined) return;
      const literal = ts.isStringLiteralLike(arg)
        ? arg.text
        : ts.isTemplateExpression(arg)
          ? "a template"
          : undefined;
      if (literal !== undefined && !ALLOWED.includes(literal)) {
        bad.push(`${where(file, node)} reads ${literal}`);
      }
    });
  }
  assert.deepEqual(bad, [], `keyValue reads a name outside the allowed list: ${bad.join("; ")}`);
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
