import "./fixtures/env.ts";
import { cleared } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ProviderError } from "../src/errors.ts";
import { openAiMask } from "../src/gateway/openai.ts";
import type { Script } from "../src/gateway/scripted.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { createRaster, decodePng, encodePng, getPixel, setPixel } from "../src/image/raster.ts";
import {
  createProvider,
  gatewayAdapter,
  openaiAdapter,
  scriptedAdapter,
} from "../src/providers/adapter.ts";
import { ProviderSet } from "../src/providers/set.ts";
import { defaultRoutes } from "../src/routes.ts";
import { DEFAULT_CAPS } from "../src/settings.ts";
import { SpendLedger } from "../src/spend.ts";
import { writeSettings } from "./fixtures/env.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const KEY = "adapter-test-key-0123456789";

function script(paid: boolean): Script {
  return {
    ...(paid && { paid: true }),
    image: () => ({ images: [{ mediaType: "image/png", bytes: new Uint8Array([1]) }] }),
    vision: () => ({ text: "ok" }),
  };
}

async function ledgerIn(): Promise<SpendLedger> {
  const stateDir = await mkdtemp(join(tmpdir(), "assetgrove-adapters-"));
  return SpendLedger.fromSettings({ stateDir, caps: { ...DEFAULT_CAPS } }, { env: {} });
}

test("a scripted provider with paid true writes ledger entries; without it, none", () =>
  cleared(async () => {
    for (const paid of [true, false]) {
      const ledger = await ledgerIn();
      const { provider, id } = createProvider(
        "scripted",
        { limit: { kind: "prepaid", usd: 10 } },
        { script: script(paid), env: {} },
      );
      assert.equal(provider.billing.paid, paid);
      assert.equal(provider.billing.adapter, "scripted");
      const call = new Caller({
        provider,
        providerName: id,
        budget: new Budget(5, ledger),
        routes: defaultRoutes,
      });
      await call.image("still", "a fox", []);
      await call.vision("vision", "check", []);
      if (paid) {
        const entries = (await readFile(ledger.path, "utf8")).trim().split("\n");
        assert.equal(entries.filter((e) => e.includes('"op":"reserve"')).length, 2);
        assert.equal(entries.filter((e) => e.includes('"op":"settle"')).length, 2);
      } else {
        assert.equal(existsSync(ledger.path), false, "a free provider writes nothing");
      }
    }
  }));

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
}

/** A loopback HTTP fixture that records each request and answers with `reply`. */
async function fixture(
  reply: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization });
    req.resume();
    req.on("end", () => reply(req, res));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

test("the gateway's resolved host is its fixed host even with ANTHROPIC_BASE_URL and OPENAI_BASE_URL set; a loopback settings baseURL is used", async () => {
  const env = {
    AI_GATEWAY_API_KEY: KEY,
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9/anthropic",
    OPENAI_BASE_URL: "http://127.0.0.1:9/openai",
  };
  const saved = { a: process.env["ANTHROPIC_BASE_URL"], o: process.env["OPENAI_BASE_URL"] };
  process.env["ANTHROPIC_BASE_URL"] = env.ANTHROPIC_BASE_URL;
  process.env["OPENAI_BASE_URL"] = env.OPENAI_BASE_URL;
  try {
    const fixed = createProvider("vercel-ai-gateway", {}, { env });
    assert.deepEqual(fixed.provider.billing.hosts, ["ai-gateway.vercel.sh"]);
    assert.equal(fixed.provider.billing.paid, true);
    assert.equal(fixed.keyPresent, true);

    const server = await fixture((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fixture", type: "invalid_request_error" } }));
    });
    try {
      const local = createProvider(
        "relay",
        { adapter: "vercel-ai-gateway", baseURL: `${server.url}/v4/ai` },
        { env },
      );
      assert.deepEqual(local.provider.billing.hosts, [new URL(server.url).host]);
      await assert.rejects(
        local.provider.analyzeImages({ model: "openai/gpt-5", prompt: "hello", images: [] }),
        ProviderError,
      );
      assert.ok(server.seen.length > 0, "the loopback fixture received the call");
      for (const { path, auth } of server.seen) {
        assert.match(path, /^\/v4\/ai\//);
        assert.equal(auth, `Bearer ${KEY}`);
      }
    } finally {
      server.close();
    }
  } finally {
    for (const [name, value] of [
      ["ANTHROPIC_BASE_URL", saved.a],
      ["OPENAI_BASE_URL", saved.o],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["src/cli.ts", ...args], { cwd: root }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

test("baseURL on tripo and an unknown adapter id each exit 2 settings_invalid", async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ tripo: { baseURL: "https://relay.example/v2" } }, /tripo\.baseURL is not accepted/],
    [{ mine: { adapter: "no-such-adapter" } }, /adapter "no-such-adapter"/],
    [{ "no-such-adapter": { limit: { kind: "prepaid", usd: 1 } } }, /adapter "no-such-adapter"/],
  ];
  for (const [providers, message] of cases) {
    writeSettings({ providers });
    const r = await cli(["settings", "show", "--json"]);
    assert.equal(r.code, 2, r.stderr);
    const document = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    assert.equal(document.error.code, "settings_invalid");
    assert.match(document.error.message, message);
  }
});

test("a provider error whose response body holds text never shows that body in the error message", async () => {
  const BODY = "BODY-TEXT-must-not-appear internal trace 7f3a";
  const replies: [number, string, string][] = [
    [422, "text/plain", BODY],
    [404, "text/html", `<html><body>${BODY}</body></html>`],
    [
      400,
      "application/json",
      JSON.stringify({
        error: { message: "bad request", type: "invalid_request_error", detail: BODY },
        trace: BODY,
      }),
    ],
  ];
  for (const [status, type, body] of replies) {
    const server = await fixture((_req, res) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    });
    try {
      const { provider } = createProvider(
        "relay",
        { adapter: "vercel-ai-gateway", baseURL: `${server.url}/v4/ai` },
        { env: { AI_GATEWAY_API_KEY: KEY } },
      );
      await assert.rejects(
        provider.analyzeImages({ model: "openai/gpt-5", prompt: "hello", images: [] }),
        (error: Error) => {
          assert.ok(error instanceof ProviderError, error.message);
          assert.ok(!error.message.includes("BODY-TEXT"), error.message);
          assert.ok(!error.message.includes(KEY));
          assert.match(error.message, new RegExp(`HTTP ${status}`));
          assert.equal(error.cause, undefined, "nothing from the response rides along");
          return true;
        },
      );
    } finally {
      server.close();
    }
  }
});

test("the openai and scripted adapters declare mask; the gateway adapter does not", () => {
  assert.ok(openaiAdapter.capabilities.includes("mask"));
  assert.ok(scriptedAdapter.capabilities.includes("mask"));
  assert.ok(!gatewayAdapter.capabilities.includes("mask"));
});

test("openAiMask makes region pixels transparent and the rest opaque", () => {
  const raster = createRaster(2, 1);
  setPixel(raster, 0, 0, [255, 255, 255, 255]);
  setPixel(raster, 1, 0, [0, 0, 0, 255]);
  const out = decodePng(openAiMask(encodePng(raster)));
  assert.equal(getPixel(out, 0, 0)[3], 0);
  assert.equal(getPixel(out, 1, 0)[3], 255);
});

test("an image call with a mask sends it, records it, and keys the call by it", () =>
  cleared(async () => {
    const provider = new ScriptedProvider(script(false));
    const call = new Caller({
      provider,
      providerName: "scripted",
      budget: new Budget(5),
      routes: defaultRoutes,
    });
    const mask = {
      role: "mask",
      path: "mask.png",
      mediaType: "image/png",
      bytes: new Uint8Array([9, 8]),
      sha256: "a".repeat(64),
    };
    await call.image("edit", "a fox", [], undefined, { mask });
    const sent = provider.calls[0];
    assert.ok(sent?.kind === "image");
    assert.deepEqual([...sent.request.mask!.bytes], [9, 8]);
    assert.deepEqual(call.records[0]?.parameters.mask, { path: "mask.png", sha256: mask.sha256 });
  }));

test("ProviderSet.declares is narrowed by the script's capabilities", () => {
  const settings = {
    providers: { scripted: { limit: { kind: "prepaid", usd: 10 } } },
    roles: {},
    routes: {},
    path: "settings.json",
  };
  const route = { provider: "scripted", model: "m" } as never;
  const full = ProviderSet.fromSettings(settings as never, { script: script(false) });
  assert.equal(full.declares(route, "mask"), true);
  const narrowed = ProviderSet.fromSettings(settings as never, {
    script: { ...script(false), capabilities: ["image", "edit"] },
  });
  assert.equal(narrowed.declares(route, "mask"), false);
  assert.equal(narrowed.declares(route, "edit"), true);
  assert.equal(narrowed.declares({ provider: "nope", model: "m" } as never, "edit"), false);
});
