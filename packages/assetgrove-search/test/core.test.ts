/**
 * The package through core (issue #237): listed in the developer settings and installed in a
 * temporary project, it fills core's search slot; find by words, --like and --where over the
 * library returns the same JSON on core's CLI and as core's MCP tool, card text under sharedText
 * and the numbered sheet as image content. The scripted embedder keeps it offline.
 *
 * Core refuses an entry the project's Git tracks, so the project installs a copy of the package
 * made outside every repository, holding the package's compiled dist/ as a packed copy does. The
 * MCP half runs `assetgrove mcp` in the project as a child process, so core loads the listed,
 * installed package itself there too.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempProject } from "@clockgrove/assetgrove/testing";
import { GAME, writeLibrary } from "./helpers/core-library.ts";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const coreRoot = fileURLToPath(new URL("../../..", import.meta.url));
const NAME = "@clockgrove/assetgrove-search";

const project = tempProject();
const stage = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-search-core-")));
const sessions: Array<{ close(): Promise<void> }> = [];
after(async () => {
  await Promise.all(sessions.map((s) => s.close()));
  project.close();
  await rm(stage, { recursive: true, force: true });
});

writeLibrary(project.dir);
// The package is built as a pack outside this repository is: against core's published types (the
// `types` export condition), so the build copy's node_modules holds core's emitted declarations
// and the package's own dependencies, and nothing else of core.
const tsc = (...args: string[]) =>
  execFileSync(
    process.execPath,
    [join(pkgRoot, "node_modules", "typescript", "bin", "tsc"), ...args],
    { stdio: "inherit" },
  );
const core = join(stage, "core");
tsc(
  "-p",
  join(coreRoot, "tsconfig.build.json"),
  "--emitDeclarationOnly",
  "--outDir",
  join(core, "dist"),
);
cpSync(join(coreRoot, "package.json"), join(core, "package.json"));
symlinkSync(join(coreRoot, "node_modules"), join(core, "node_modules"), "junction");
const build = join(stage, "build");
cpSync(join(pkgRoot, "src"), join(build, "src"), { recursive: true });
for (const file of ["package.json", "tsconfig.json", "tsconfig.build.json"])
  cpSync(join(pkgRoot, file), join(build, file));
mkdirSync(join(build, "node_modules", "@clockgrove"), { recursive: true });
for (const entry of readdirSync(join(pkgRoot, "node_modules")))
  if (entry !== "@clockgrove")
    symlinkSync(
      join(pkgRoot, "node_modules", entry),
      join(build, "node_modules", entry),
      "junction",
    );
symlinkSync(core, join(build, "node_modules", "@clockgrove", "assetgrove"), "junction");
const pack = join(stage, "pack");
tsc("-p", join(build, "tsconfig.build.json"), "--outDir", join(pack, "dist"));
cpSync(join(pkgRoot, "package.json"), join(pack, "package.json"));
const installed = project.install(pack, NAME);
symlinkSync(join(pkgRoot, "node_modules"), join(installed, "node_modules"), "junction");
project.writeSettings({ extensions: [NAME], search: { embedder: "scripted" } });

test("the search package's setup runs through extensions setup", async () => {
  const result = await project.cli(["extensions", "setup", "search", "--json"]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const fields = result.json as Record<string, unknown>;
  assert.equal(fields["extension"], "search");
  assert.equal(fields["model"], "scripted");
  assert.equal(fields["installed"], true);
});

test("extensions setup search downloads the pinned model through core, and refuses a wrong hash", async () => {
  // The installed pack's manifest points at a local fixture: one host serving the right bytes,
  // a primary that fails so the mirror is used, and a file whose bytes do not match its pin.
  const body: Record<string, string> = {
    "config.json": '{"model":"fixture"}',
    "onnx/vision_model.onnx": "vision-bytes",
  };
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const name = (req.url ?? "").replace(/^\/mirror\//, "").replaceAll("__", "/");
    if (!req.url?.startsWith("/mirror/")) return void res.writeHead(503).end();
    res.end(name === "onnx/tampered.onnx" ? "other bytes" : (body[name] ?? ""));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manifestPath = join(installed, "dist", "model-manifest.json");
  assert.ok(existsSync(manifestPath), "the built pack reads its manifest from dist");
  const shipped = readFileSync(manifestPath, "utf8");
  const manifest = (files: Array<{ path: string; sha256: string }>) =>
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...(JSON.parse(shipped) as object),
        id: "fixture-model",
        revision: "b".repeat(40),
        primaryBase: `${base}/primary`,
        mirrorBase: `${base}/mirror`,
        files,
      }),
    );
  const models = join(project.stateDir, "models", "fixture-model");
  try {
    project.writeSettings({ extensions: [NAME], search: { embedder: "local" } });
    manifest(Object.entries(body).map(([path, text]) => ({ path, sha256: hash(text) })));
    const ok = await project.cli(["extensions", "setup", "search", "--json"]);
    assert.equal(ok.code, 0, ok.stderr + ok.stdout);
    assert.equal(ok.json?.["installed"], true);
    assert.equal(ok.json?.["model"], "fixture-model");
    for (const [path, text] of Object.entries(body))
      assert.equal(readFileSync(join(models, path), "utf8"), text);
    assert.ok(
      hits.some((h) => h.startsWith("/primary/")),
      "the primary was tried first",
    );

    // A pin the served bytes do not match: exit 4, hash_mismatch, nothing left at the path.
    manifest([{ path: "onnx/tampered.onnx", sha256: hash("the pinned bytes") }]);
    const bad = await project.cli(["extensions", "setup", "search", "--json"]);
    assert.equal(bad.code, 4, bad.stderr + bad.stdout);
    assert.match(bad.stdout, /hash_mismatch/);
    assert.deepEqual(readdirSync(join(models, "onnx")).sort(), ["vision_model.onnx"]);
  } finally {
    writeFileSync(manifestPath, shipped);
    project.writeSettings({ extensions: [NAME], search: { embedder: "scripted" } });
    server.close();
  }
});

test("the listed package fills core's slot: find returns the same JSON on the CLI and as a tool", async () => {
  const indexed = await project.cli(["search", "index", "--json"]);
  assert.equal(indexed.code, 0, indexed.stderr + indexed.stdout);

  // `assetgrove mcp` runs in the project as a child process, so core loads the package the
  // settings list from the project's node_modules, as it does for the CLI.
  const mcp = await project.mcpServer();
  sessions.push(mcp);
  const listed = (await mcp.request("tools/list", {}))["result"] as { tools: { name: string }[] };
  const tools = listed.tools.map((t) => t.name);
  for (const name of ["find", "search_index", "search_status", "extensions_setup"])
    assert.ok(tools.includes(name), name);

  // extensions_setup returns the same document as the CLI's `extensions setup search --json`.
  const setupCli = await project.cli(["extensions", "setup", "search", "--json"]);
  const setupTool = await mcp.request("tools/call", {
    name: "extensions_setup",
    arguments: { name: "search" },
  });
  assert.deepEqual(
    (setupTool["result"] as { structuredContent: unknown }).structuredContent,
    setupCli.json,
  );

  const lantern = `asset://${GAME}/lantern`;
  const cases: Array<{ args: string[]; tool: Record<string, unknown>; first?: string }> = [
    { args: ["find", "lantern"], tool: { words: "lantern" }, first: lantern },
    { args: ["find", "--like", lantern], tool: { like: lantern }, first: lantern },
    {
      args: ["find", "--where", "kind=still", "--where", "tag=light"],
      tool: { where: ["kind=still", "tag=light"] },
      first: lantern,
    },
  ];
  for (const { args, tool, first } of cases) {
    const result = await project.cli([...args, "--json"]);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const document = result.json as Record<string, unknown> & {
      hits: Array<{ address: string; fields: Record<string, unknown>; sharedText: object }>;
    };
    assert.ok(document.hits.length > 0, args.join(" "));
    if (first !== undefined) assert.equal(document.hits[0]!.address, first, args.join(" "));
    for (const hit of document.hits) {
      assert.equal(hit.fields["title"], undefined);
      assert.equal(hit.fields["description"], undefined);
      assert.equal(typeof hit.sharedText, "object");
    }
    if (args.includes("--where"))
      for (const hit of document.hits) {
        assert.equal(hit.fields["kind"], "still");
        assert.ok((hit.fields["tags"] as string[]).includes("light"));
      }

    const answer = await mcp.request("tools/call", { name: "find", arguments: tool });
    assert.equal(answer["error"], undefined, JSON.stringify(answer["error"]));
    const call = answer["result"] as {
      isError?: boolean;
      structuredContent: unknown;
      content: Array<{ type: string; mimeType?: string }>;
    };
    assert.notEqual(call.isError, true, JSON.stringify(call.content));
    assert.deepEqual(call.structuredContent, document, args.join(" "));
    const image = call.content.find((c) => c.type === "image");
    assert.ok(image, "the numbered sheet comes as image content");
    assert.equal(image.mimeType, "image/png");
  }
  const words = (await project.cli(["find", "lantern", "--json"])).json as {
    hits: Array<{ sharedText: { title?: string; text?: string } }>;
  };
  assert.match(String(words.hits[0]!.sharedText.text), /lantern/i);
});

test("CLI and MCP filter measured numeric boundaries and report unavailable evidence", async () => {
  const assets = join(project.dir, "assets");
  for (const id of ["lantern", "walk", "trot"]) {
    const bytes = readFileSync(join(assets, `${id}.png`));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(assets, `${id}.md`);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "state: pending",
        `state: pending\nlock: { sha256: "${sha256}" }`,
      ),
    );
  }
  const missing = join(assets, "missing.md");
  const pointerSha = "a".repeat(64);
  for (const id of ["missing", "pointer", "unsupported"]) {
    const bytes = id === "unsupported" ? Buffer.from("unsupported media") : undefined;
    const sha256 = bytes ? createHash("sha256").update(bytes).digest("hex") : pointerSha;
    writeFileSync(
      join(assets, `${id}.md`),
      `---\ntype: Game Asset\nformat: assetgrove-card/1\ntitle: ${id}\nresource: ${id}.bin\nlock: { sha256: "${sha256}" }\n---\n`,
    );
    if (bytes) writeFileSync(join(assets, `${id}.bin`), bytes);
    if (id === "pointer")
      writeFileSync(
        join(assets, `${id}.bin`),
        `version https://git-lfs.github.com/spec/v1\noid sha256:${pointerSha}\nsize 100\n`,
      );
  }
  assert.ok(existsSync(missing));
  const indexed = await project.cli(["search", "index", "--rebuild", "--json"]);
  assert.equal(indexed.code, 0, indexed.stderr + indexed.stdout);
  const mcp = await project.mcpServer();
  sessions.push(mcp);
  const cases: Array<[string, string[]]> = [
    ["width<40", ["trot"]],
    ["width<=40", ["trot", "walk"]],
    ["width=40", ["walk"]],
    ["width>=40", ["lantern", "walk"]],
    ["width>40", ["lantern"]],
    ["width!=40", ["lantern", "trot"]],
    ["height=48", ["lantern"]],
  ];
  type Document = { hits: Array<{ address: string; fields: Record<string, unknown> }> };
  for (const [where, expected] of cases) {
    const cli = await project.cli(["find", "--where", where, "--json"]);
    assert.equal(cli.code, 0, cli.stderr + cli.stdout);
    const result = cli.json as unknown as Document;
    assert.deepEqual(result.hits.map((h) => h.address.split("/").at(-1)).sort(), expected);
    for (const h of result.hits) {
      assert.equal(typeof h.fields["width"], "number");
      assert.equal(h.fields["mediaType"], "image/png");
      assert.equal(h.fields["mediaStatus"], "available");
      assert.match(String(h.fields["mediaSha256"]), /^[0-9a-f]{64}$/);
    }
    const response = await mcp.request("tools/call", {
      name: "find",
      arguments: { where: [where] },
    });
    const tool = response["result"] as { isError?: boolean; structuredContent: unknown };
    assert.notEqual(tool.isError, true, JSON.stringify(tool));
    assert.deepEqual(tool.structuredContent, result);
  }
  const unavailable = await project.cli(["find", "--where", "mediaStatus=unavailable", "--json"]);
  assert.equal(unavailable.code, 0, unavailable.stderr + unavailable.stdout);
  const hits = (unavailable.json as unknown as Document).hits;
  for (const id of ["missing", "pointer", "unsupported"]) {
    const hit = hits.find((h) => h.address.endsWith(`/${id}`));
    assert.ok(hit, id);
    assert.equal(hit.fields["mediaStatus"], "unavailable");
    assert.equal(typeof hit.fields["mediaReason"], "string");
    assert.equal(hit.fields["width"], undefined);
  }
  const invalid = await project.cli(["find", "--where", "duration>1", "--json"]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stdout, /evidence unavailable/);
  unlinkSync(join(assets, "lantern.png"));
  const gone = await project.cli(["find", "--where", "width=48", "--json"]);
  assert.equal(gone.code, 0, gone.stderr + gone.stdout);
  assert.deepEqual((gone.json as unknown as Document).hits, []);
});
