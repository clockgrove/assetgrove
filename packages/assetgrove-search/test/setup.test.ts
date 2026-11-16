import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { MODEL_MANIFEST, isPinned } from "../src/model-manifest.ts";
import type { ModelManifest } from "../src/model-manifest.ts";
import { SearchError } from "../src/errors.ts";
import { loadSiglip2 } from "../src/siglip2.ts";
import { modelFolder, modelIsInstalled, setupModel } from "../src/setup.ts";

const REV = "a".repeat(40);
const contents: Record<string, string> = {
  "config.json": '{"a":1}',
  "onnx/vision_model.onnx": "vision-bytes",
  "onnx/text_model_int8.onnx": "text-bytes",
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function serve(
  handler: (path: string) => string | undefined,
): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const body = handler(req.url ?? "");
    if (body === undefined) {
      res.statusCode = 503;
      res.end();
    } else res.end(body);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits }),
    ),
  );
}

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function fixture(
  primary: (p: string) => string | undefined,
  mirror: (p: string) => string | undefined,
) {
  const p = await serve(primary);
  const m = await serve(mirror);
  servers.push(p.server, m.server);
  const manifest: ModelManifest = {
    id: "fixture",
    repo: "org/model",
    revision: REV,
    dimension: 768,
    primaryBase: p.base,
    mirrorBase: m.base,
    files: Object.entries(contents).map(([path, c]) => ({ path, sha256: sha(c) })),
  };
  const dir = await mkdtemp(join(tmpdir(), "ag-search-"));
  return { manifest, dir, p, m };
}

const fromPrimary = (url: string) => contents[url.split(`/resolve/${REV}/`)[1] ?? ""];
const fromMirror = (url: string) => contents[url.slice(1).replaceAll("__", "/")];

describe("search setup", () => {
  it("downloads from the primary and verifies every hash", async () => {
    const { manifest, dir, m } = await fixture(fromPrimary, fromMirror);
    await setupModel({ modelsDir: dir, manifest });
    assert.equal(await modelIsInstalled(dir, manifest), true);
    assert.equal(m.hits.length, 0);
    await rm(dir, { recursive: true });
  });

  it("falls back to the mirror when the primary fails", async () => {
    const { manifest, dir, m } = await fixture(() => undefined, fromMirror);
    await setupModel({ modelsDir: dir, manifest });
    assert.equal(await modelIsInstalled(dir, manifest), true);
    assert.equal(m.hits.length, 3);
    await rm(dir, { recursive: true });
  });

  it("refuses a wrong hash and leaves nothing written", async () => {
    const bad = (u: string) => (u.includes("vision") ? "tampered" : fromPrimary(u));
    const { manifest, dir } = await fixture(bad, (u) =>
      u.includes("vision") ? "tampered" : fromMirror(u),
    );
    await assert.rejects(setupModel({ modelsDir: dir, manifest }), (e: unknown) => {
      assert.ok(e instanceof SearchError);
      assert.equal(e.code, "hash_mismatch");
      return true;
    });
    assert.deepEqual(await readdir(dir), []);
    await rm(dir, { recursive: true });
  });

  it("reports a download error that says 'does not match' as setup_failed", async () => {
    const { manifest, dir } = await fixture(fromPrimary, fromMirror);
    await assert.rejects(
      setupModel({
        modelsDir: dir,
        manifest,
        fetch: (() => Promise.reject(new Error("host does not match certificate"))) as typeof fetch,
      }),
      (e: unknown) => {
        assert.ok(e instanceof SearchError);
        assert.equal(e.code, "setup_failed");
        return true;
      },
    );
    await rm(dir, { recursive: true });
  });

  it("leaves nothing when both hosts fail", async () => {
    const { manifest, dir } = await fixture(
      () => undefined,
      () => undefined,
    );
    await assert.rejects(setupModel({ modelsDir: dir, manifest }), /Could not fetch/);
    assert.deepEqual(await readdir(dir), []);
    await rm(dir, { recursive: true });
  });
});

describe("the shipped manifest", () => {
  it("declares dimension 768 and a file list", () => {
    assert.equal(MODEL_MANIFEST.dimension, 768);
    assert.ok(MODEL_MANIFEST.files.some((f) => f.path === "onnx/text_model_int8.onnx"));
    assert.ok(MODEL_MANIFEST.files.some((f) => f.path === "onnx/vision_model.onnx"));
  });

  it("pins a commit and ships a sha256 for every file", () => {
    assert.equal(isPinned(MODEL_MANIFEST), true);
  });

  it("refuses to set up an unpinned manifest", async () => {
    await assert.rejects(
      setupModel({ modelsDir: tmpdir(), manifest: { ...MODEL_MANIFEST, revision: "" } }),
      (e: unknown) => e instanceof SearchError && e.code === "model_unpinned",
    );
  });
});

describe("stale staging folders", () => {
  it("removes partial folders left by an interrupted setup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ag-search-"));
    const stale = join(dir, `.${MODEL_MANIFEST.id}.partial-deadbeef`);
    await mkdir(stale, { recursive: true });
    await assert.rejects(
      setupModel({
        modelsDir: dir,
        manifest: {
          ...MODEL_MANIFEST,
          files: [{ path: "config.json", sha256: "0".repeat(64) }],
          primaryBase: "http://127.0.0.1:1",
          mirrorBase: "http://127.0.0.1:1",
        },
        fetch: (() => Promise.reject(new Error("down"))) as typeof fetch,
      }),
    );
    assert.deepEqual(await readdir(dir), []);
    await rm(dir, { recursive: true });
  });
});

describe("offline loading", () => {
  it("fails with an error naming search setup and makes no network call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ag-search-"));
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("network");
    }) as typeof fetch;
    try {
      const folder = modelFolder(dir);
      for (const f of MODEL_MANIFEST.files.slice(1)) {
        await mkdir(dirname(join(folder, f.path)), { recursive: true });
        await writeFile(join(folder, f.path), "x");
      }
      await assert.rejects(loadSiglip2(dir), (e: unknown) => {
        assert.ok(e instanceof SearchError);
        assert.equal(e.code, "model_missing");
        assert.match(e.message, /search setup/);
        return true;
      });
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(calls, 0);
    await rm(dir, { recursive: true });
  });
});
