/**
 * The package through core (issue #237): listed in the developer settings and installed in a
 * fixture project, it fills core's search slot; find by words, --like and --where over the
 * fixture library returns the same JSON on core's CLI and as core's MCP tool, card text under
 * sharedText and the numbered sheet as image content. The scripted embedder keeps it offline.
 *
 * Core refuses an entry the project's Git tracks and Node strips types only outside
 * node_modules, so the project links a copy of the package made outside every repository.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { REFUSED_VARIABLES } from "../../../src/env.ts";
import { GAME, fixtureLibrary } from "../../../test/fixtures/library.ts";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));

const lib = fixtureLibrary();
const home = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-search-core-")));
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await rm(lib.dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

// The package's copy, outside every repository, with its dependencies linked.
const copy = join(home, "package");
mkdirSync(copy);
cpSync(join(pkgRoot, "package.json"), join(copy, "package.json"));
cpSync(join(pkgRoot, "src"), join(copy, "src"), { recursive: true });
symlinkSync(join(pkgRoot, "node_modules"), join(copy, "node_modules"), "junction");
mkdirSync(join(lib.dir, "node_modules", "@clockgrove"), { recursive: true });
symlinkSync(copy, join(lib.dir, "node_modules", "@clockgrove", "assetgrove-search"), "junction");

const settingsFile = join(home, "config", "settings.json");
mkdirSync(join(home, "config"));
writeFileSync(
  settingsFile,
  JSON.stringify({
    format: "assetgrove-settings/2",
    stateDir: join(home, "state"),
    extensions: ["@clockgrove/assetgrove-search"],
    search: { embedder: "scripted" },
  }),
);

/** The environment without keys or variables core refuses, its settings file named. */
function env(): Record<string, string> {
  const out: Record<string, string> = {};
  const refused = new Set<string>(REFUSED_VARIABLES);
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !refused.has(k.toUpperCase()) && !k.endsWith("_API_KEY")) out[k] = v;
  out["ASSETGROVE_CONFIG"] = settingsFile;
  return out;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd: lib.dir, env: env() },
      (error, stdout, stderr) =>
        done({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

async function connect(): Promise<Client> {
  const client = new Client({ name: "assetgrove-search-core-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, "mcp"],
      cwd: lib.dir,
      env: env(),
      stderr: "pipe",
    }),
  );
  clients.push(client);
  return client;
}

test("the listed package fills core's slot: find returns the same JSON on the CLI and as a tool", async () => {
  const indexed = await cli(["search", "index", "--json"]);
  assert.equal(indexed.code, 0, indexed.stderr + indexed.stdout);

  const client = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name);
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
    const result = await cli([...args, "--json"]);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const document = JSON.parse(result.stdout) as Record<string, unknown> & {
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

    const call = await client.callTool({ name: "find", arguments: tool });
    assert.notEqual(call.isError, true, JSON.stringify(call.content));
    assert.deepEqual(call.structuredContent, document, args.join(" "));
    const content = call.content as Array<{ type: string; mimeType?: string; data?: string }>;
    const image = content.find((c) => c.type === "image");
    assert.ok(image, "the numbered sheet comes as image content");
    assert.equal(image.mimeType, "image/png");
  }
  const words = JSON.parse((await cli(["find", "lantern", "--json"])).stdout) as {
    hits: Array<{ sharedText: { title?: string; text?: string } }>;
  };
  assert.match(String(words.hits[0]!.sharedText.text), /lantern/i);
});
