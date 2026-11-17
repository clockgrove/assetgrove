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
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
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

test("the listed package fills core's slot: find returns the same JSON on the CLI and as a tool", async () => {
  const indexed = await project.cli(["search", "index", "--json"]);
  assert.equal(indexed.code, 0, indexed.stderr + indexed.stdout);

  // `assetgrove mcp` runs in the project as a child process, so core loads the package the
  // settings list from the project's node_modules, as it does for the CLI.
  const mcp = await project.mcpServer();
  sessions.push(mcp);
  const listed = (await mcp.request("tools/list", {}))["result"] as { tools: { name: string }[] };
  const tools = listed.tools.map((t) => t.name);
  for (const name of ["find", "search_index", "search_status", "search_setup"])
    assert.ok(tools.includes(name), name);

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
