/**
 * The asset tree over the official MCP client on stdio (issue #234, design section 2): every folder
 * address of a fixture library reads as JSON children (at most 200 per read, with a next address)
 * plus the root's index.md; resources/list paginates folder and card addresses; ls and cat as
 * tools return the documents resources/read returns; a subscribed run folder gets
 * resources/updated after a candidate is staged, a subscribed asset after a pick adds a version,
 * and the server sends list_changed after a pick it served.
 */
import "./fixtures/env.ts";
import { approve } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { READ_LIMIT } from "../src/tree/thumbs.ts";
import { GAME, RUN_ID, fixtureLibrary, libraryProfile } from "./fixtures/library.ts";
import { gitTarget } from "./fixtures/git.ts";
import { syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(script);

const lib = fixtureLibrary({ bulk: 205 });
gitTarget(lib.dir);
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await rm(lib.dir, { recursive: true, force: true });
});

const A = (path: string) => `asset://${GAME}/${path}`;

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

async function connect(): Promise<Client> {
  const client = new Client({ name: "assetgrove-tree-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--target", lib.dir, "--provider-script", script],
      cwd: root,
      env: childEnv(),
      stderr: "pipe",
    }),
  );
  clients.push(client);
  return client;
}

type Contents = Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const first = (contents: Contents): any => JSON.parse(contents[0]!.text!);
const size = (contents: Contents) =>
  contents.reduce(
    (n, c) => n + (c.text !== undefined ? Buffer.byteLength(c.text) : c.blob!.length),
    0,
  );

test("over stdio, every folder address returns JSON children, 200 at most per read, and index.md for the root", async () => {
  const client = await connect();
  const folders = [
    A(""),
    A("by-kind/still/"),
    A("by-subject/lantern/"),
    A("by-tag/bulk/"),
    A("stale/"),
    A("runs/"),
    A(`runs/${RUN_ID}/`),
    A("lantern/"),
  ];
  for (const address of folders) {
    const { contents } = await client.readResource({ uri: address });
    const doc = first(contents as Contents);
    assert.equal(doc.kind, "folder", address);
    assert.ok(doc.children.length > 0 && doc.children.length <= 200, address);
    assert.ok(size(contents as Contents) <= 64 * 1024, address);
    if (address === A("")) {
      assert.equal(contents[1]?.mimeType, "text/markdown");
      assert.ok(doc.next);
    }
  }
  const page1 = first((await client.readResource({ uri: A("by-tag/bulk/") })).contents as Contents);
  assert.equal(page1.children.length, 200);
  const page2 = first((await client.readResource({ uri: page1.next })).contents as Contents);
  assert.equal(page2.children.length, 5);
  assert.equal(page2.next, undefined);

  const image = await client.readResource({ uri: A("big/image") });
  assert.equal(image.contents[0]!.mimeType, "image/png");
  assert.ok(size(image.contents as Contents) <= 64 * 1024);

  await assert.rejects(
    client.readResource({ uri: A("escape/") }),
    (e: { data?: { code?: string } }) => {
      assert.equal(e.data?.code, "invalid_input");
      return true;
    },
  );
});

test("resources/list paginates the root, folder and card addresses; templates name the asset files", async () => {
  const client = await connect();
  const uris: string[] = [];
  // An explicit cursor reads one page; "0" is the first.
  let cursor: string | undefined = "0";
  let pages = 0;
  do {
    const page = await client.listResources({ cursor });
    assert.ok(page.resources.length <= 200);
    uris.push(...page.resources.map((r) => r.uri));
    cursor = page.nextCursor;
    pages++;
  } while (cursor !== undefined);
  assert.ok(pages >= 3, `pages: ${pages}`);
  for (const uri of [
    A(""),
    A("by-kind/"),
    A("stale/"),
    A("lantern/"),
    A("lantern/card"),
    A("bulk-204/card"),
  ]) {
    assert.ok(uris.includes(uri), uri);
  }
  const { resourceTemplates } = await client.listResourceTemplates();
  assert.ok(resourceTemplates.some((t) => t.uriTemplate === A("{asset}/versions/{n}")));
});

test("ls and cat as tools return what resources/read returns", async () => {
  const client = await connect();
  for (const address of [
    A("by-tag/prop/"),
    A("lantern/"),
    A("lantern/versions/1"),
    A("walk/image"),
    A("big/image"),
  ]) {
    const read = (await client.readResource({ uri: address })).contents;
    const cat = await client.callTool({ name: "cat", arguments: { address } });
    // The document lists each content's uri and mimeType; the content follows once, in order.
    const listed = (cat.structuredContent as { contents: { uri: string; mimeType: string }[] })
      .contents;
    const items = cat.content as Array<
      | { type: "image"; data: string; mimeType: string }
      | { type: "resource"; resource: Record<string, unknown> }
      | { type: "text"; text: string }
    >;
    assert.equal(items[0]!.type, "text");
    const carried = items.slice(1).map((item, i) => {
      if (item.type === "image") return { ...listed[i], blob: item.data };
      assert.equal(item.type, "resource", address);
      return (item as { resource: Record<string, unknown> }).resource;
    });
    assert.deepEqual(carried, read, address);
    // The read travels once, so the tool result stays near the read's own encoded size.
    const encoded = read.reduce(
      (n, c) => n + ("text" in c ? Buffer.byteLength(c.text) : (c as { blob: string }).blob.length),
      0,
    );
    const size = Buffer.byteLength(JSON.stringify(cat));
    assert.ok(size <= encoded + 4096, `${address}: ${size} for a ${encoded}-byte read`);
    assert.ok(size <= READ_LIMIT + 4096, address);
  }
  // cat --out is the CLI's: the read-only tool takes no out and writes nothing.
  const { tools } = await client.listTools();
  const catTool = tools.find((t) => t.name === "cat")!;
  assert.equal(catTool.annotations?.readOnlyHint, true);
  assert.equal("out" in (catTool.inputSchema.properties ?? {}), false);
  const out = join(lib.dir, "written.png");
  const refused = await client.callTool({
    name: "cat",
    arguments: { address: A("walk/image"), out },
  });
  assert.equal(refused.isError, true);
  assert.equal(existsSync(out), false);
  const ls = await client.callTool({ name: "ls", arguments: { address: A("stale/") } });
  const read = first((await client.readResource({ uri: A("stale/") })).contents as Contents);
  assert.deepEqual((ls.structuredContent as { children: unknown }).children, read.children);
});

test("a subscribed run folder is updated after staging; a subscribed asset after a pick, and the list changes", async () => {
  const client = await connect();
  const updated: string[] = [];
  let listChanged = 0;
  client.setNotificationHandler("notifications/resources/updated", (n) => {
    updated.push(n.params.uri);
  });
  client.setNotificationHandler("notifications/resources/list_changed", () => {
    listChanged++;
  });

  const world = await syntheticWorld();
  const spec = join(world.dir, "still.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify({ kind: "still", assetId: "lantern", subject: "fern" }));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(libraryProfile()));
  const runs = join(lib.dir, ".assetgrove", "runs");
  await mkdir(runs, { recursive: true });
  const stageArgs = { spec, bible, profile, runs, candidates: 1 };

  // The run's address is known before it runs: its directory is named by the request digest.
  const estimate = await client.callTool({
    name: "estimate",
    arguments: { command: "stage", args: stageArgs },
  });
  const runDir = (estimate.structuredContent as { runDir: string }).runDir;
  const runAddress = A(`runs/${basename(runDir)}/`);
  await client.subscribeResource({ uri: runAddress });
  await client.subscribeResource({ uri: A("lantern/") });

  const staged = await client.callTool({ name: "stage", arguments: stageArgs });
  assert.equal((staged.structuredContent as { ok: boolean }).ok, true, JSON.stringify(staged));
  await until(() => updated.includes(runAddress));
  assert.ok(!updated.includes(A("lantern/")), "nothing changed the lantern yet");
  const run = first((await client.readResource({ uri: runAddress })).contents as Contents);
  assert.equal(run.children[0].state, "staged");

  const before = listChanged;
  const picked = await client.callTool({
    name: "pick",
    arguments: { run: runDir, candidate: "c1", target: lib.dir },
  });
  assert.equal((picked.structuredContent as { ok: boolean }).ok, true, JSON.stringify(picked));
  await until(() => updated.includes(A("lantern/")) && listChanged > before);
  const versions = first(
    (await client.readResource({ uri: A("lantern/versions/") })).contents as Contents,
  );
  assert.equal(versions.children.length, 3);
  // Only subscribed addresses are sent on a 2025-era connection.
  assert.ok(
    updated.every((uri) => uri === runAddress || uri === A("lantern/")),
    updated.join(),
  );
  await rm(world.dir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail("timed out waiting for a notification");
    await new Promise((r) => setTimeout(r, 25));
  }
}
