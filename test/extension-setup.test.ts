/**
 * A pack's setup (docs/extensions.md#setup): pinned downloads against a local HTTP server, and
 * `extensions setup <name>` through core's real path with an in-process pack.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { InputError, ProviderError } from "../src/errors.ts";
import { pinnedDownload } from "../src/extension/setup.ts";
import { tempProject } from "../src/testing/index.ts";

const BODY = Buffer.from("model bytes");
const GOOD = createHash("sha256").update(BODY).digest("hex");
const WRONG = createHash("sha256").update("other").digest("hex");

const requests: string[] = [];
const held: ServerResponse[] = [];
let server: Server;
let base = "";
before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/down") {
      res.writeHead(503).end();
      return;
    }
    if (req.url === "/stall") {
      // Headers and a first chunk, then nothing, as the CI download that hung for 30 minutes.
      res.writeHead(200, { "content-length": String(1 << 20) });
      res.write("model");
      held.push(res);
      return;
    }
    res.writeHead(200).end(BODY);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  held.forEach((res) => res.destroy());
  server.close();
});

async function scratch(): Promise<string> {
  return realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-setup-")));
}

const pin = (over: Record<string, unknown> = {}) => ({
  urls: [`${base}/good`],
  version: "v1",
  sha256: GOOD,
  path: "m/weights.bin",
  ...over,
});

test("a pinned download with the right hash lands in place", async () => {
  const dir = await scratch();
  try {
    const path = await pinnedDownload(dir, pin());
    assert.equal(path, join(dir, "m", "weights.bin"));
    assert.deepEqual(await readFile(path), BODY);
    assert.deepEqual(await readdir(join(dir, "m")), ["weights.bin"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a pinned download with a wrong hash is refused, deleted, and no other host is tried", async () => {
  const dir = await scratch();
  requests.length = 0;
  try {
    await assert.rejects(
      pinnedDownload(dir, pin({ sha256: WRONG, urls: [`${base}/first`, `${base}/second`] })),
      (error) => error instanceof ProviderError && /^hash_mismatch: /.test(error.message),
    );
    assert.deepEqual(requests, ["/first"]);
    assert.equal(existsSync(join(dir, "m", "weights.bin")), false);
    assert.deepEqual(await readdir(join(dir, "m")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing host falls back to the next; all failing is setup_failed", async () => {
  const dir = await scratch();
  try {
    const path = await pinnedDownload(dir, pin({ urls: [`${base}/down`, `${base}/good`] }));
    assert.deepEqual(await readFile(path), BODY);
    await assert.rejects(
      pinnedDownload(dir, pin({ urls: [`${base}/down`], path: "x.bin" })),
      (error) => error instanceof ProviderError && /^setup_failed: /.test(error.message),
    );
    assert.deepEqual((await readdir(dir)).sort(), ["m"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a host that stalls mid-file is given up for the next, leaving no partial file", async () => {
  const dir = await scratch();
  try {
    const path = await pinnedDownload(dir, pin({ urls: [`${base}/stall`, `${base}/good`] }), {
      stallMs: 200,
    });
    assert.deepEqual(await readFile(path), BODY);
    assert.deepEqual(await readdir(join(dir, "m")), ["weights.bin"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an invalid pin is invalid input", async () => {
  const dir = await scratch();
  try {
    for (const over of [
      { version: "" },
      { sha256: "ABC" },
      { path: "../x" },
      { path: "a//b" },
      { path: "/abs" },
      { path: "a\\b" },
      { urls: [] },
      { urls: ["ftp://example.test/x"] },
    ])
      await assert.rejects(pinnedDownload(dir, pin(over)), InputError, JSON.stringify(over));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a file already there with the pinned hash is not fetched again", async () => {
  const dir = await scratch();
  try {
    await pinnedDownload(dir, pin());
    requests.length = 0;
    await pinnedDownload(dir, pin());
    assert.deepEqual(requests, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removes partial files left by a setup killed mid-download", async () => {
  const dir = await scratch();
  try {
    await mkdir(join(dir, "m"), { recursive: true });
    await writeFile(join(dir, "m", "weights.bin.partial-0a1b2c3d4e5f"), "model");
    await writeFile(join(dir, "m", "other.bin.partial-0a1b2c3d4e5f"), "kept");
    await pinnedDownload(dir, pin());
    assert.deepEqual((await readdir(join(dir, "m"))).sort(), [
      "other.bin.partial-0a1b2c3d4e5f",
      "weights.bin",
    ]);
    // A partial left beside a file already in place goes too.
    await writeFile(join(dir, "m", "weights.bin.partial-ffffffffffff"), "model");
    await pinnedDownload(dir, pin());
    assert.equal(existsSync(join(dir, "m", "weights.bin.partial-ffffffffffff")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extensions setup runs a pack's setup with pinned downloads", async () => {
  const project = tempProject();
  try {
    const pack = (sha256: string) => ({
      api: 2 as const,
      name: "fixture",
      setup: async (ctx: { download(f: ReturnType<typeof pin>): Promise<string> }) => ({
        path: await ctx.download(pin({ sha256 })),
      }),
    });
    const ok = await project.run(
      "extensions setup",
      { name: "fixture" },
      { extensions: [pack(GOOD)] },
    );
    assert.equal(ok.exitCode, 0);
    const path = ok.fields?.["path"] as string;
    assert.ok(path.includes(join("models", "m", "weights.bin")));
    assert.deepEqual(await readFile(path), BODY);

    const bad = await project.run(
      "extensions setup",
      { name: "fixture" },
      { extensions: [pack(WRONG)] },
    );
    assert.equal(bad.exitCode, 4);
    assert.match(bad.error?.message ?? "", /hash_mismatch/);
    assert.equal((await readdir(join(project.stateDir, "models", "m"))).length, 1);

    const none = await project.run(
      "extensions setup",
      { name: "nosuch" },
      { extensions: [pack(GOOD)] },
    );
    assert.equal(none.exitCode, 2);
    const bare = await project.run(
      "extensions setup",
      { name: "bare" },
      { extensions: [{ api: 2, name: "bare" }] },
    );
    assert.equal(bare.exitCode, 2);
    assert.match(bare.error?.message ?? "", /declares no setup/);
  } finally {
    project.close();
  }
});
