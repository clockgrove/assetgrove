import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { MODEL_MANIFEST, isPinned } from "../src/model-manifest.ts";
import type { ModelManifest } from "../src/model-manifest.ts";
import { SearchError } from "../src/errors.ts";
import type { PinnedDownload } from "@clockgrove/assetgrove/extension";
import { loadSiglip2 } from "../src/siglip2.ts";
import { modelFolder, setupModel } from "../src/setup.ts";

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
  // The bytes, the hash check and the fallback are core's pinned download (test/extension-setup.test.ts),
  // and the package's setup runs through it in test/core.test.ts.
  it("hands each missing file to the download port, pinned, and skips an installed one", async () => {
    const { manifest, dir, p, m } = await fixture(fromPrimary, fromMirror);
    const installed = manifest.files[0]!;
    await mkdir(dirname(join(dir, "fixture", installed.path)), { recursive: true });
    await writeFile(join(dir, "fixture", installed.path), contents[installed.path]!);
    const calls: PinnedDownload[] = [];
    const result = await setupModel({
      modelsDir: dir,
      manifest,
      download: async (file) => {
        calls.push(file);
        return join(dir, file.path);
      },
    });
    assert.equal(result.dir, modelFolder(dir, manifest));
    assert.deepEqual(
      calls.map((c) => c.path),
      manifest.files.slice(1).map((f) => `fixture/${f.path}`),
    );
    for (const [i, call] of calls.entries()) {
      const file = manifest.files[i + 1]!;
      assert.equal(call.version, REV);
      assert.equal(call.sha256, file.sha256);
      assert.equal(call.urls.length, 2);
      assert.ok(call.urls[0]!.startsWith(p.base));
      assert.ok(call.urls[1]!.startsWith(m.base));
    }
    assert.deepEqual([p.hits, m.hits], [[], []], "the package fetched nothing itself");
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
      setupModel({
        modelsDir: tmpdir(),
        manifest: { ...MODEL_MANIFEST, revision: "" },
        download: () => Promise.reject(new Error("nothing is downloaded")),
      }),
      (e: unknown) => e instanceof SearchError && e.code === "model_unpinned",
    );
  });
});

describe("offline loading", () => {
  it("fails with an error naming extensions setup search and makes no network call", async () => {
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
        assert.match(e.message, /extensions setup search/);
        return true;
      });
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(calls, 0);
    await rm(dir, { recursive: true });
  });
});
