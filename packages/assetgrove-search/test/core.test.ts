/**
 * The package through core (issue #237): listed in the developer settings and installed in a
 * temporary project, it fills core's search slot; find by words, --like and --where over the
 * library returns the same JSON on core's CLI and as core's MCP tool, card text under sharedText
 * and the numbered sheet as image content. The scripted embedder keeps it offline.
 *
 * Core refuses an entry the project's Git tracks, so the project installs a copy of the package
 * made outside every repository, holding the package's compiled dist/ as a packed copy does.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempProject } from "@clockgrove/assetgrove/testing";
import extension from "../src/extension.ts";
import { GAME, writeLibrary } from "./helpers/core-library.ts";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
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
cpSync(join(pkgRoot, "package.json"), join(stage, "package.json"));
execFileSync(
  process.execPath,
  [
    join(pkgRoot, "node_modules", "typescript", "bin", "tsc"),
    ...["-p", join(pkgRoot, "tsconfig.build.json"), "--outDir", join(stage, "dist")],
  ],
  { stdio: "inherit" },
);
const installed = project.install(stage, NAME);
symlinkSync(join(pkgRoot, "node_modules"), join(installed, "node_modules"), "junction");
project.writeSettings({ extensions: [NAME], search: { embedder: "scripted" } });

test("the listed package fills core's slot: find returns the same JSON on the CLI and as a tool", async () => {
  const indexed = await project.cli(["search", "index", "--json"]);
  assert.equal(indexed.code, 0, indexed.stderr + indexed.stdout);

  // The server resolves the settings' extension list from the working directory.
  const cwd = process.cwd();
  process.chdir(project.dir);
  const mcp = await project.mcp({ extensions: [extension] });
  sessions.push(mcp);
  after(() => process.chdir(cwd));
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
