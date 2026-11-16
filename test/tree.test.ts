/**
 * The asset tree's resolver over a fixture library (issue #234, design section 2): every folder
 * address returns JSON children (at most 200 per read, with a next address) plus the root's
 * index.md; files return their documents; images read as thumbnails of at most 512 px; no read's
 * encoded content exceeds 64 KB; card text appears only under sharedText; a card naming a path
 * outside the library root is refused; and `ls` / `cat` on the CLI return the same documents.
 */
import "./fixtures/env.ts";
import { stateDir } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodePng } from "../src/image/raster.ts";
import { libraryDrift, readLibrary } from "../src/library/maintain.ts";
import { StalenessCache } from "../src/library/stale.ts";
import { appendAnnotation, parseReview, writeReview } from "../src/library/review.ts";
import { changed, fingerprint, listTree } from "../src/tree/list.ts";
import { openProject } from "../src/tree/project.ts";
import { TreeServer } from "../src/tree/serve.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import { PAGE_SIZE, readTree } from "../src/tree/read.ts";
import type { Content, ReadResult } from "../src/tree/read.ts";
import { READ_LIMIT, THUMB_PX } from "../src/tree/thumbs.ts";
import { GAME, RUN_ID, fixtureLibrary } from "./fixtures/library.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const lib = fixtureLibrary({ bulk: 205 });
after(() => rm(lib.dir, { recursive: true, force: true }));
const staleness = new StalenessCache(stateDir);
/** Caches a staleness answer as `library judge-stale` would; a read never makes one. */
const judged = (sha256: string, from: string, to: string, redo: boolean) =>
  staleness.set({
    sha256,
    from,
    to,
    redo,
    history: true,
    thumbnail: true,
    model: "test",
    at: "2026-11-16T00:00:00.000Z",
  });
// fern was made under bible 2 and judged to need redoing under 3.
judged(lib.versions["fern"]!.at(-1)!, "2", "3", true);

const A = (path: string) => `asset://${GAME}/${path}`;
const project = () => openProject(lib.dir, stateDir);
const read = async (address: string) => readTree(await project(), address);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: ReadResult): any => JSON.parse((r.contents[0] as { text: string }).text);
const encoded = (r: ReadResult) =>
  r.contents.reduce((n, c) => n + ("text" in c ? Buffer.byteLength(c.text) : c.blob.length), 0);
const images = (r: ReadResult) =>
  r.contents.filter((c): c is Extract<Content, { blob: string }> => "blob" in c);
const png = (c: { blob: string }) => decodePng(Buffer.from(c.blob, "base64"));

const FOLDERS = [
  A(""),
  A("by-kind/"),
  A("by-kind/still/"),
  A("by-subject/"),
  A("by-subject/lantern/"),
  A("by-tag/"),
  A("by-tag/prop/"),
  A("stale/"),
  A("runs/"),
  A(`runs/${RUN_ID}/`),
  A("lantern/"),
  A("lantern/versions/"),
];

test("every folder address returns a JSON folder document, the root its index.md too", async () => {
  for (const address of FOLDERS) {
    const r = await read(address);
    const doc = json(r);
    assert.equal(doc.address, address);
    assert.equal(doc.kind, "folder");
    assert.ok(Array.isArray(doc.children) && doc.children.length > 0, address);
    for (const child of doc.children) {
      assert.equal(typeof child.address, "string");
      assert.equal(typeof child.name, "string");
      assert.equal(typeof child.kind, "string");
    }
    assert.ok(encoded(r) <= READ_LIMIT, address);
  }
  const rootRead = await read(A(""));
  assert.equal(rootRead.contents.length, 2);
  assert.equal(rootRead.contents[1]!.mimeType, "text/markdown");
  assert.match((rootRead.contents[1] as { text: string }).text, /okf_version: 0.2/);
  const rootDoc = json(rootRead);
  assert.deepEqual(
    rootDoc.children.slice(0, 5).map((c: { name: string }) => c.name),
    ["by-kind", "by-subject", "by-tag", "stale", "runs"],
  );
  assert.equal(rootDoc.counts.assets, 212);
  assert.equal(rootDoc.counts.stale, 1);
  assert.deepEqual(
    json(await read(A("stale/"))).children.map((c: { name: string }) => c.name),
    ["fern"],
  );
  assert.deepEqual(
    json(await read(A("by-tag/prop/"))).children.map((c: { name: string }) => c.name),
    ["boat", "lantern"],
  );
  // A view lists the asset folder by its own address; nothing is copied.
  assert.equal(json(await read(A("by-tag/prop/"))).children[1].address, A("lantern/"));
  assert.equal(json(await read(A("lantern"))).address, A("lantern/"));
});

test("stale/ lists what library drift does: the cached yes answers among assets made under another version", async () => {
  const bumped = fixtureLibrary();
  try {
    writeFileSync(
      join(bumped.dir, ".assetgrove", "art-direction", "BIBLE.md"),
      "---\nversion: 4\n---\n# Bible\n",
    );
    // A bump marks nothing stale by itself: every asset is made under another version, unjudged.
    const opened = await openProject(bumped.dir, stateDir);
    const names = async () =>
      json(await readTree(opened, A("stale/"))).children.map((c: { name: string }) => c.name);
    assert.deepEqual(await names(), []);
    const rootDoc = json(await readTree(opened, A("")));
    assert.equal(rootDoc.counts.stale, 0);
    assert.equal(rootDoc.counts.otherVersion, rootDoc.counts.assets);
    assert.equal(json(await readTree(opened, A("stale/"))).unjudged, rootDoc.counts.assets);

    judged(bumped.versions["lantern"]!.at(-1)!, "3", "4", true);
    judged(bumped.versions["rock"]!.at(-1)!, "3", "4", false);
    const drift = await libraryDrift(
      await readLibrary(opened.profile, bumped.dir),
      "4",
      new StalenessCache(stateDir),
    );
    assert.deepEqual(await names(), ["lantern"]);
    assert.deepEqual(
      drift.stale.map((s) => s.asset),
      ["lantern"],
    );
    // drift reads only cards that pass the library check; escape's resource leaves the root.
    assert.equal(drift.otherVersion.length, rootDoc.counts.assets - 1);
    assert.equal(drift.otherVersion.find((o) => o.asset === "rock")?.judgement, "keep");
    const after = json(await readTree(opened, A("")));
    assert.equal(after.counts.stale, 1);
    const lantern = json(await readTree(opened, A("lantern/"))).asset;
    assert.equal(lantern.stale, true);
    assert.equal(lantern.otherVersion, true);

    // A rollback to the version an asset was made under makes it current again, not stale.
    writeFileSync(
      join(bumped.dir, ".assetgrove", "art-direction", "BIBLE.md"),
      "---\nversion: 2\n---\n# Bible\n",
    );
    const rolled = json(await readTree(opened, A("")));
    assert.equal(rolled.counts.otherVersion, rolled.counts.assets - 1, "fern is current under 2");
    assert.equal(json(await readTree(opened, A("fern/"))).asset.otherVersion, false);
  } finally {
    await rm(bumped.dir, { recursive: true, force: true });
  }
});

test("a carded id that is a view's name is left out of the tree and reported at the root", async () => {
  const clash = fixtureLibrary();
  try {
    const card = readFileSync(join(clash.dir, "assets", "lantern.md"), "utf8");
    writeFileSync(join(clash.dir, "assets", "runs.md"), card);
    const opened = await openProject(clash.dir, stateDir);
    const rootDoc = json(await readTree(opened, A("")));
    assert.deepEqual(rootDoc.reserved, ["runs"]);
    assert.equal(rootDoc.children.filter((c: { name: string }) => c.name === "runs").length, 1);
    assert.deepEqual(
      json(await readTree(opened, A("runs/"))).children.map((c: { name: string }) => c.name),
      [RUN_ID],
    );
    assert.equal(listTree(opened).filter((l) => l.uri.startsWith(A("runs"))).length, 2);
  } finally {
    await rm(clash.dir, { recursive: true, force: true });
  }
});

test("a folder read returns at most 200 children and a next address that reads the rest", async () => {
  const seen: string[] = [];
  let address: string | undefined = A("by-tag/bulk/");
  let reads = 0;
  while (address !== undefined) {
    const doc = json(await read(address));
    assert.ok(doc.children.length <= PAGE_SIZE);
    seen.push(...doc.children.map((c: { name: string }) => c.name));
    address = doc.next;
    reads++;
  }
  assert.equal(reads, 2);
  assert.equal(seen.length, 205);
  assert.equal(new Set(seen).size, 205);
  const first = json(await read(A("")));
  assert.equal(first.children.length, PAGE_SIZE);
  assert.match(first.next, /^asset:\/\/test-grove\/\?after=/);
  await assert.rejects(read(A("by-tag/bulk/?after=nobody")), /no child "nobody"/);
});

test("card text appears only under sharedText in JSON documents", async () => {
  const texts = [
    "Porch lantern",
    "A brass lantern for the porch, lit.",
    "Used beside the front door.",
  ];
  const doc = json(await read(A("lantern/")));
  assert.deepEqual(
    doc.sharedText.map((s: { source: string }) => s.source),
    ["card.title", "card.description", "card.body"],
  );
  const { sharedText, ...rest } = doc;
  assert.ok(sharedText.length === 3);
  for (const address of [...FOLDERS, A("lantern/versions/1"), A(`runs/${RUN_ID}/c1`)]) {
    const r = await read(address);
    const body =
      address === A("lantern/") ? JSON.stringify(rest) : (r.contents[0] as { text: string }).text;
    for (const text of texts) assert.ok(!body.includes(text), `${address} carries "${text}"`);
  }
  assert.equal(doc.asset.kind, "still");
  assert.deepEqual(doc.asset.tags, ["prop", "light"]);
});

test("file addresses return the card and log as Markdown, provenance and review as JSON", async () => {
  const card = await read(A("lantern/card"));
  assert.equal(card.contents[0]!.mimeType, "text/markdown");
  assert.equal(
    (card.contents[0] as { text: string }).text,
    readFileSync(join(lib.root, "lantern.md"), "utf8"),
  );
  const log = await read(A("lantern/log"));
  assert.equal(log.contents[0]!.mimeType, "text/markdown");
  assert.match(
    (log.contents[0] as { text: string }).text,
    /replace \[Porch lantern\]\(lantern\.md\): version 2/,
  );
  for (const file of ["provenance", "review"]) {
    const r = await read(A(`lantern/${file}`));
    assert.equal(r.contents[0]!.mimeType, "application/json");
    JSON.parse((r.contents[0] as { text: string }).text);
  }
});

test("an image reads as a thumbnail of at most 512 px, image/full as the file or its pointer", async () => {
  for (const id of ["lantern", "big", "walk"]) {
    const r = await read(A(`${id}/image`));
    const [image] = images(r);
    assert.ok(image, id);
    assert.equal(image.mimeType, "image/png");
    const thumb = png(image);
    assert.ok(Math.max(thumb.width, thumb.height) <= THUMB_PX, id);
    assert.ok(encoded(r) <= READ_LIMIT, id);
  }
  // A strip reads as its key-frame row: four 32 px frames side by side with gaps.
  const walk = png(images(await read(A("walk/image")))[0]!);
  assert.ok(walk.width > 4 * 32 && walk.height === 32);
  const full = await read(A("lantern/image/full"));
  assert.equal(
    images(full)[0]!.blob,
    readFileSync(join(lib.root, "lantern.png")).toString("base64"),
  );
  // Over the limit: a pointer naming the file, never more than 64 KB.
  const big = await read(A("big/image/full"));
  const pointer = json(big);
  assert.equal(pointer.tooLarge, true);
  assert.equal(pointer.path, "assets/big.png");
  assert.ok(encoded(big) <= READ_LIMIT);
  assert.ok(big.bytes && big.bytes.length > READ_LIMIT);
  assert.ok(
    existsSync(join(stateDir, "thumbs")) && readdirSync(join(stateDir, "thumbs")).length > 0,
  );
});

test("a 3D asset reads as its path and turntable frames", async () => {
  const r = await read(A("boat/image"));
  const doc = json(r);
  assert.equal(doc.kind, "model");
  assert.equal(doc.path, "assets/boat.glb");
  assert.deepEqual(doc.frames, [
    "assets/boat-views/view-1.png",
    "assets/boat-views/view-2.png",
    "assets/boat-views/view-3.png",
  ]);
  const [row] = images(r);
  assert.ok(row && png(row).width > png(row).height);
  assert.ok(encoded(r) <= READ_LIMIT);
});

test("versions/<n> returns the version record, with its image only while its bytes are local", async () => {
  const versions = json(await read(A("rock/versions/")));
  assert.deepEqual(
    versions.children.map((c: { name: string }) => c.name),
    ["1", "2", "3"],
  );
  const cases: Array<[string, string | null]> = [
    ["lantern/versions/1", "run"],
    ["lantern/versions/2", "working"],
    ["rock/versions/1", null],
    ["rock/versions/2", "lfs"],
    ["rock/versions/3", "working"],
  ];
  for (const [path, from] of cases) {
    const r = await read(A(path));
    const doc = json(r);
    assert.equal(doc.kind, "version", path);
    assert.equal(doc.image, from, path);
    assert.equal(images(r).length, from === null ? 0 : 1, path);
  }
  const v1 = json(await read(A("lantern/versions/1")));
  assert.equal(v1.sha256, lib.versions["lantern"]![0]);
  assert.equal(v1.n, 1);
  assert.equal(v1.current, false);
  assert.equal(json(await read(A("lantern/versions/2"))).current, true);
  await assert.rejects(read(A("lantern/versions/3")), /no version 3/);
});

test("a run folder lists its candidates with QA reasons and cost", async () => {
  const run = json(await read(A(`runs/${RUN_ID}/`)));
  assert.deepEqual(
    run.children.map((c: { name: string; state: string }) => [c.name, c.state]),
    [
      ["c1", "picked"],
      ["c2", "rejected"],
    ],
  );
  const c1 = await read(A(`runs/${RUN_ID}/c1`));
  assert.equal(json(c1).reasons[0].check, "alpha");
  assert.equal(json(c1).costUsd, 0.04);
  assert.equal(images(c1).length, 1);
  const c2 = json(await read(A(`runs/${RUN_ID}/c2`)));
  assert.equal(c2.state, "rejected");
  assert.equal(c2.reasons[0].passed, false);
});

test("a card whose resource leaves the library root is refused; assets resolve by id", async () => {
  for (const path of ["escape/", "escape/image", "escape/card"]) {
    await assert.rejects(read(A(path)), (e: Error & { code?: string }) => {
      assert.match(e.message, /leaves the library root/);
      return true;
    });
  }
  // fern's card is in assets/props/, yet its address is its id.
  assert.equal(json(await read(A("fern/"))).asset.id, "fern");
  await assert.rejects(read(A("nobody/")), /no asset "nobody"/);
  await assert.rejects(read("asset://another-game/"), /not "another-game"/);
  await assert.rejects(read("https://example.com/"), /not an asset:\/\/ address/);
});

test("the listing holds the root, folder and card addresses; the fingerprint sees an annotation", async () => {
  const p = await project();
  const listed = listTree(p).map((l) => l.uri);
  for (const uri of [
    A(""),
    A("stale/"),
    A("by-tag/prop/"),
    A(`runs/${RUN_ID}/`),
    A("lantern/"),
    A("lantern/card"),
  ]) {
    assert.ok(listed.includes(uri), uri);
  }
  const before = fingerprint(p);
  const path = join(lib.root, "rock.review.json");
  const record = parseReview(readFileSync(path, "utf8"), path);
  writeFileSync(
    path,
    writeReview(
      appendAnnotation(record, {
        type: "Annotation",
        created: "2026-11-20T10:00:00Z",
        motivation: "commenting",
        body: [{ type: "TextualBody", value: "darker" }],
        target: "rock.png",
      }),
    ),
  );
  assert.deepEqual(changed(before.addresses, fingerprint(p).addresses), [A("rock/")]);
});

test("a tool call during a running one keeps the running call's changes announced", async () => {
  const own = fixtureLibrary();
  try {
    const updates: string[] = [];
    const tree = new TreeServer(own.dir, stateDir);
    const fake = {
      server: {
        setRequestHandler() {},
        sendResourceUpdated: async ({ uri }: { uri: string }) => void updates.push(uri),
        sendResourceListChanged: async () => {},
      },
    };
    tree.attach(fake as unknown as McpServer, "modern");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let wrote!: () => void;
    const written = new Promise<void>((r) => (wrote = r));
    // A long call (a stage) writes, then waits; an ls runs meanwhile on the same connection.
    const long = tree.around(
      "stage",
      async () => {
        const path = join(own.root, "rock.review.json");
        const record = parseReview(readFileSync(path, "utf8"), path);
        writeFileSync(
          path,
          writeReview(
            appendAnnotation(record, {
              type: "Annotation",
              created: "2026-11-20T10:00:00Z",
              motivation: "commenting",
              body: [{ type: "TextualBody", value: "darker" }],
              target: "rock.png",
            }),
          ),
        );
        wrote();
        await gate;
        return {};
      },
      () => true,
    );
    await written;
    await tree.around(
      "ls",
      async () => ({}),
      () => true,
    );
    release();
    await long;
    assert.ok(updates.includes(A("rock/")), updates.join(", "));
  } finally {
    await rm(own.dir, { recursive: true, force: true });
  }
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  return new Promise((done) => {
    execFile(process.execPath, ["src/cli.ts", ...args], { cwd: root }, (error, stdout, stderr) =>
      done({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

test("ls and cat on the CLI return the documents the resolver returns", async () => {
  const ls = await cli(["ls", A("by-kind/"), "--target", lib.dir, "--json"]);
  assert.equal(ls.code, 0, ls.stderr);
  const listed = JSON.parse(ls.stdout);
  const doc = json(await read(A("by-kind/")));
  for (const key of Object.keys(doc)) assert.deepEqual(listed[key], doc[key], key);

  const cat = await cli(["cat", A("lantern/versions/1"), "--target", lib.dir, "--json"]);
  assert.equal(cat.code, 0, cat.stderr);
  assert.deepEqual(JSON.parse(cat.stdout).contents, (await read(A("lantern/versions/1"))).contents);

  const out = join(lib.dir, "big-out.png");
  const full = await cli(["cat", A("big/image/full"), "--target", lib.dir, "--out", out, "--json"]);
  assert.equal(full.code, 0, full.stderr);
  assert.deepEqual(readFileSync(out), readFileSync(join(lib.root, "big.png")));

  const escape = await cli(["cat", A("escape/"), "--target", lib.dir, "--json"]);
  assert.equal(escape.code, 2);
  assert.equal(JSON.parse(escape.stdout).error.code, "invalid_input");

  const notFolder = await cli(["ls", A("lantern/card"), "--target", lib.dir, "--json"]);
  assert.equal(notFolder.code, 2);
});
