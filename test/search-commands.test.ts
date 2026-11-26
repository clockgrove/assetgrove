/**
 * The search-only commands (issue #237, design section 7.1): core declares find, search index,
 * and search status with `requires: "search"`. With no loaded extension filling the
 * search slot, help and the tool list omit them and a call exits 2 extension_unavailable naming
 * the settings line; with one listed, find returns the same JSON on the CLI and as a tool, card
 * text only under sharedText and the numbered sheet as image content. The slot here is a stub
 * package written by the test; the real search package has its own tests.
 */
import "./fixtures/env.ts";
import { SCRIPTED_LIMIT, settingsPath, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { GAME, fixtureLibrary } from "./fixtures/library.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(root, "src", "cli.ts");
const STUB = "assetgrove-search-stub";
const SEARCH_ONLY = ["find", "search index", "search status"];
const SEARCH_TOOLS = ["find", "search_index", "search_status"];

const lib = fixtureLibrary();
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await rm(lib.dir, { recursive: true, force: true });
});

// A stub search slot: it ranks the reader's picks by the words in their card text.
const pkg = join(lib.dir, "node_modules", STUB);
mkdirSync(pkg, { recursive: true });
writeFileSync(
  join(pkg, "package.json"),
  JSON.stringify({
    name: STUB,
    version: "1.0.0",
    type: "module",
    peerDependencies: { "@clockgrove/assetgrove": ">=0.2.0" },
    assetgrove: { api: 3, entry: "./index.js" },
  }),
);
writeFileSync(
  join(pkg, "index.js"),
  `export default function extension() {
  return {
    api: 3,
    name: "search-stub",
    search: {
      async find(query, ctx) {
        let rows = (await ctx.library.list(query.sources)).filter((i) => i.source === "pick");
        const words = (query.words ?? "").toLowerCase().split(/\\s+/).filter(Boolean);
        rows = rows.filter((i) => words.every((w) => (i.text ?? "").toLowerCase().includes(w)));
        if (query.like && "address" in query.like) rows = rows.filter((i) => i.address === query.like.address);
        for (const term of query.where ?? []) {
          const [field, value] = term.split("=");
          if (!["kind", "subject", "state"].includes(field)) {
            const error = new Error("unknown filter field " + field);
            error.code = "invalid_input";
            throw error;
          }
          rows = rows.filter((i) => i[field] === value);
        }
        rows.sort((a, b) => (a.address < b.address ? -1 : 1));
        return {
          hits: rows.slice(0, query.limit).map((i, n) => ({
            address: i.address, rank: n + 1, score: 1 / (n + 1), source: i.source, path: i.path,
            view: "", fields: { kind: i.kind, subject: i.subject, tags: i.tags },
            sharedText: { title: i.title, description: i.description, text: i.text },
          })),
          fresh: true,
          builtFrom: { head: await ctx.library.head(), at: "2026-01-01T00:00:00.000Z" },
        };
      },
      async outliers(addresses) {
        return {
          members: addresses.length,
          ranking: addresses.map((address, i) => ({ address, distance: 0.9 - i / 100 })),
        };
      },
      async index() { return { indexed: true }; },
      async status(ctx) { return { game: ctx.game, store: ctx.stateDir + "/search" }; },
      async setup() { return { installed: true }; },
    },
  };
}
`,
);

function useSettings(listed: boolean): void {
  writeSettings({
    providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } },
    ...(listed && { extensions: [STUB] }),
  });
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["AI_GATEWAY_API_KEY"];
  for (const name of REFUSED_VARIABLES) {
    delete env[name];
    delete env[name.toLowerCase()];
  }
  return env;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], env: Record<string, string> = childEnv()): Promise<Result> {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd: lib.dir, env },
      (error, stdout, stderr) =>
        done({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = (r: Result): Record<string, any> => JSON.parse(r.stdout);

async function connect(): Promise<Client> {
  const client = new Client({ name: "assetgrove-search-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, "mcp"],
      cwd: lib.dir,
      env: childEnv(),
      stderr: "pipe",
    }),
  );
  clients.push(client);
  return client;
}

test("with the search package not listed, help and the tool list omit the search commands and a call exits 2 extension_unavailable naming the settings line", async () => {
  useSettings(false);
  const help = doc(await cli(["--help", "--json"]));
  for (const name of SEARCH_ONLY) assert.ok(!help.commands.includes(name), name);
  for (const name of SEARCH_ONLY) assert.ok(!help.usage.includes(`  ${name} `), name);
  assert.ok(help.commands.includes("ls"));

  for (const args of [
    ["find", "lantern"],
    ["search", "index"],
    ["search", "status"],
  ]) {
    const result = await cli([...args, "--json"]);
    assert.equal(result.code, 2, args.join(" "));
    const error = doc(result).error;
    assert.equal(error.code, "extension_unavailable");
    assert.ok(error.message.includes(settingsPath), error.message);
    assert.ok(error.message.includes("@clockgrove/assetgrove-search"), error.message);
    assert.ok(error.message.includes("extensions"), error.message);
  }

  const client = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const name of SEARCH_TOOLS) assert.ok(!tools.includes(name), name);
  assert.ok(tools.includes("ls"));
});

test("with it listed, help and the tool list carry the search commands", async () => {
  useSettings(true);
  const help = doc(await cli(["--help", "--json"]));
  for (const name of SEARCH_ONLY) assert.ok(help.commands.includes(name), name);
  const client = await connect();
  const tools = (await client.listTools()).tools;
  for (const name of SEARCH_TOOLS)
    assert.ok(
      tools.some((t) => t.name === name),
      name,
    );
  assert.equal(tools.find((t) => t.name === "find")!.annotations?.readOnlyHint, true);
});

test("find by words, --like and --where returns the same JSON on the CLI and as a tool, card text under sharedText and a numbered sheet as image content", async () => {
  useSettings(true);
  const client = await connect();
  const cases: Array<{ args: string[]; tool: Record<string, unknown> }> = [
    { args: ["find", "lantern"], tool: { words: "lantern" } },
    {
      args: ["find", "--like", `asset://${GAME}/lantern`],
      tool: { like: `asset://${GAME}/lantern` },
    },
    {
      args: ["find", "--where", "kind=still", "--limit", "3"],
      tool: { where: ["kind=still"], limit: 3 },
    },
  ];
  for (const { args, tool } of cases) {
    const result = await cli([...args, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const document = doc(result);
    assert.ok(document.hits.length > 0, args.join(" "));
    for (const hit of document.hits) {
      assert.ok(hit.address.startsWith(`asset://${GAME}/`));
      assert.equal(hit.fields.title, undefined, "card text never outside sharedText");
      assert.equal(typeof hit.sharedText, "object");
    }
    assert.equal(typeof document.sheet, "string");

    const call = await client.callTool({ name: "find", arguments: tool });
    assert.notEqual(call.isError, true, JSON.stringify(call.content));
    assert.deepEqual(call.structuredContent, document, args.join(" "));
    const content = call.content as Array<{ type: string; mimeType?: string; data?: string }>;
    assert.deepEqual(JSON.parse((content[0] as unknown as { text: string }).text), document);
    const image = content.find((c) => c.type === "image");
    assert.ok(image, "the numbered sheet comes as image content");
    assert.equal(image.mimeType, "image/png");
    assert.equal(Buffer.from(image.data!, "base64").subarray(1, 4).toString(), "PNG");
  }
  const words = doc(await cli(["find", "lantern", "--json"]));
  assert.equal(words.hits[0].address, `asset://${GAME}/lantern`);
  assert.ok(String(words.hits[0].sharedText.title ?? words.hits[0].sharedText.text).length > 0);

  const unknown = await cli(["find", "--where", "colour=red", "--json"]);
  assert.equal(unknown.code, 2);
  assert.equal(doc(unknown).error.code, "invalid_input");
});

test("an AWS variable that could redirect index data exits 2 settings_invalid before a search command when the store is s3://, unless environment.allow lists it", async () => {
  const env = { ...childEnv(), AWS_ENDPOINT_URL: "https://elsewhere.example" };
  // With no s3:// store configured, nothing reads the AWS variables, so they are not refused.
  useSettings(true);
  const unused = await cli(["search", "status", "--json"], env);
  assert.equal(unused.code, 0, unused.stderr);

  const store = {
    uri: "s3://bucket/index",
    credentialsEnv: { accessKeyId: "STORE_KEY_ID", secretAccessKey: "STORE_SECRET" },
  };
  writeSettings({
    providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } },
    extensions: [STUB],
    search: { store },
  });
  const refused = await cli(["search", "status", "--json"], env);
  assert.equal(refused.code, 2);
  assert.equal(doc(refused).error.code, "settings_invalid");
  assert.ok(doc(refused).error.message.includes("AWS_ENDPOINT_URL"));

  writeSettings({
    providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } },
    extensions: [STUB],
    search: { store },
    environment: { allow: ["AWS_ENDPOINT_URL"] },
  });
  const allowed = await cli(["search", "status", "--json"], env);
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(doc(allowed).game, GAME);
});

test("the tree's find, like and where paths return the same hits as find, and are listed only with the package", async () => {
  useSettings(false);
  const absent = await connect();
  const none = (await absent.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
  for (const path of ["find/", "like/", "where/"])
    assert.ok(!none.some((t) => t.includes(`/${path}`)), path);

  useSettings(true);
  const client = await connect();
  const templates = (await client.listResourceTemplates()).resourceTemplates.map(
    (t) => t.uriTemplate,
  );
  for (const path of ["find/{words}", "like/{asset}", "where/{filter}"])
    assert.ok(
      templates.some((t) => t.endsWith(`/${path}`)),
      path,
    );

  const cases = [
    { uri: `asset://${GAME}/find/lantern`, tool: { words: "lantern" } },
    { uri: `asset://${GAME}/like/lantern`, tool: { like: `asset://${GAME}/lantern` } },
    {
      uri: `asset://${GAME}/where/${encodeURIComponent("kind=still")}`,
      tool: { where: ["kind=still"] },
    },
  ];
  for (const { uri, tool } of cases) {
    const read = await client.readResource({ uri });
    const text = (read.contents[0] as { text: string }).text;
    const path = JSON.parse(text);
    const call = await client.callTool({ name: "find", arguments: tool });
    const found = call.structuredContent as { hits: unknown[]; fresh: boolean; builtFrom: unknown };
    assert.ok(found.hits.length > 0, uri);
    assert.deepEqual(path.hits, found.hits, uri);
    assert.equal(path.fresh, found.fresh);
    assert.deepEqual(path.builtFrom, found.builtFrom);
    assert.equal(path.sheet, undefined, "a read writes no sheet");
  }
});

test("find --outliers hands the slot a folder's assets and returns its whole ranking", async () => {
  useSettings(true);
  const result = await cli(["find", "--outliers", `asset://${GAME}/`, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const document = doc(result);
  assert.ok(document.members > 1);
  assert.equal(document.ranking.length, document.members, "every member, uncut");
  assert.ok(document.ranking[0].address.startsWith(`asset://${GAME}/`));
  assert.ok(!document.ranking[0].address.endsWith("/"));
  // The scripted provider with no style-outlier answer judges every member the same style.
  assert.deepEqual(document.outliers, []);
  assert.equal(document.hits, undefined);
  const bad = await cli(["find", "--outliers", `asset://${GAME}/lantern/card`, "--json"]);
  assert.equal(bad.code, 2);
});
