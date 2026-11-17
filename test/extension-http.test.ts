/**
 * The pack's `http` (#414): a `fetch` that refuses any host outside the adapter's declared hosts
 * and its settings endpoint, re-checking every redirect hop, so a provider-steered URL cannot send
 * a request anywhere else. The test serves two loopback hosts that differ by port.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createExtensionContext } from "../src/extension/context.ts";
import { allowedHosts, guardedFetch, HostRefusedError } from "../src/extension/http.ts";
import { createProvider } from "../src/providers/adapter.ts";
import type { ProviderAdapter } from "../src/providers/adapter.ts";

const hits: string[] = [];
let declared = "";
let undeclared = "";

const listen = (handler: Parameters<typeof createServer>[1]) =>
  new Promise<ReturnType<typeof createServer>>((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

let servers: ReturnType<typeof createServer>[] = [];
before(async () => {
  const other = await listen((req, res) => {
    hits.push(`other ${req.url}`);
    res.end("other");
  });
  undeclared = `127.0.0.1:${(other.address() as AddressInfo).port}`;
  const main = await listen((req, res) => {
    hits.push(`main ${req.method} ${req.url}`);
    if (req.url === "/away") {
      res.writeHead(302, { location: `http://${undeclared}/stolen` }).end();
    } else if (req.url === "/hop") {
      res.writeHead(307, { location: "/done" }).end();
    } else if (req.url === "/see-other") {
      res.writeHead(303, { location: "/done" }).end();
    } else {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => res.end(`ok ${req.method} ${body}`));
    }
  });
  declared = `127.0.0.1:${(main.address() as AddressInfo).port}`;
  servers = [other, main];
});
after(() => {
  for (const s of servers) s.close();
});

const adapter = (hosts: string[]) => ({
  id: "pack:demo",
  fixedHosts: hosts,
  endpointFromSettings: false,
});

test("http reaches a declared host and follows a redirect within the declared hosts", async () => {
  const http = createExtensionContext("pack-demo").http(adapter([declared]));
  hits.length = 0;
  const r = await http(`http://${declared}/hop`, { method: "POST", body: "payload" });
  assert.equal(await r.text(), "ok POST payload");
  const seeOther = await http(`http://${declared}/see-other`, { method: "POST", body: "x" });
  assert.equal(await seeOther.text(), "ok GET ");
  assert.deepEqual(hits, [
    "main POST /hop",
    "main POST /done",
    "main POST /see-other",
    "main GET /done",
  ]);
});

test("http refuses an undeclared host before sending anything", async () => {
  const http = createExtensionContext("pack-demo").http(adapter([declared]));
  hits.length = 0;
  await assert.rejects(http(`http://${undeclared}/direct`), (error: unknown) => {
    assert.ok(error instanceof HostRefusedError);
    assert.equal(error.providerCode, "host_refused");
    assert.match(error.message, new RegExp(`pack:demo may not reach ${undeclared}`));
    return true;
  });
  await assert.rejects(http("file:///etc/passwd"), HostRefusedError);
  assert.deepEqual(hits, []);
});

test("http refuses a redirect to an undeclared host, and the hop is never requested", async () => {
  const http = createExtensionContext("pack-demo").http(adapter([declared]));
  hits.length = 0;
  await assert.rejects(http(`http://${declared}/away`), (error: unknown) => {
    assert.ok(error instanceof HostRefusedError);
    assert.match(error.message, /\(redirect 1\)/);
    return true;
  });
  assert.deepEqual(hits, ["main GET /away"]);
});

test("the settings endpoint is allowed only for an adapter that takes one", () => {
  assert.deepEqual(
    allowedHosts(
      { fixedHosts: ["api.example.test"], endpointFromSettings: true },
      "http://127.0.0.1:9/v1",
    ),
    ["api.example.test", "127.0.0.1:9"],
  );
  assert.deepEqual(
    allowedHosts(
      { fixedHosts: ["api.example.test"], endpointFromSettings: false },
      "http://127.0.0.1:9/v1",
    ),
    ["api.example.test"],
  );
});

test("core hands an adapter's create the guarded fetch for its hosts and its settings endpoint", async () => {
  let given: typeof fetch | undefined;
  const pack: ProviderAdapter = {
    id: "pack:demo",
    capabilities: ["image"],
    fixedHosts: [],
    endpointFromSettings: true,
    create(c) {
      given = c.fetch;
      return {
        billing: {
          adapter: "pack:demo",
          providerId: c.providerId,
          paid: false,
          settle: "declared",
          reconcile: "unavailable",
        },
        generateImage: () => Promise.reject(new Error("unused")),
        analyzeImages: () => Promise.reject(new Error("unused")),
      } as never;
    },
  };
  createProvider(
    "demo",
    { adapter: "pack:demo", baseURL: `http://${declared}/` },
    { adapters: [pack] },
  );
  assert.ok(given);
  hits.length = 0;
  assert.equal(await (await given(`http://${declared}/x`)).text(), "ok GET ");
  await assert.rejects(given(`http://${declared}/away`), HostRefusedError);
  await assert.rejects(given(`http://${undeclared}/x`), HostRefusedError);
  assert.deepEqual(hits, ["main GET /x", "main GET /away"]);
});

test("guardedFetch sends through the fetch it is given", async () => {
  const seen: string[] = [];
  const f = guardedFetch({
    adapter: "pack:demo",
    hosts: ["api.example.test"],
    base: () =>
      (async (url: URL) => {
        seen.push(String(url));
        return new Response("fine");
      }) as unknown as typeof fetch,
  });
  assert.equal(await (await f("https://api.example.test/a")).text(), "fine");
  assert.deepEqual(seen, ["https://api.example.test/a"]);
});

test("a redirect drops the body's headers with the body, and credentials when the origin changes", async () => {
  const sent: Array<{ url: string; method: string; headers: Headers }> = [];
  const redirects: Record<string, [number, string]> = {
    "https://api.example.test/see-other": [303, "/done"],
    "https://api.example.test/move": [307, "https://files.example.test/blob"],
    "https://api.example.test/same": [307, "/done"],
  };
  const f = guardedFetch({
    adapter: "pack:demo",
    hosts: ["api.example.test", "files.example.test"],
    base: () =>
      (async (url: URL, init: RequestInit) => {
        sent.push({
          url: String(url),
          method: init.method ?? "GET",
          headers: new Headers(init.headers),
        });
        const to = redirects[String(url)];
        return to === undefined
          ? new Response("fine")
          : new Response(null, { status: to[0], headers: { location: to[1] } });
      }) as unknown as typeof fetch,
  });
  const credentials = {
    authorization: "Bearer k",
    "proxy-authorization": "Basic p",
    cookie: "c=1",
  };
  await f("https://api.example.test/see-other", {
    method: "POST",
    body: "x",
    headers: { "content-type": "text/plain", "content-language": "en", ...credentials },
  });
  const after303 = sent[1]!;
  assert.equal(after303.method, "GET");
  assert.equal(after303.headers.get("content-type"), null);
  assert.equal(after303.headers.get("content-language"), null);
  assert.equal(after303.headers.get("authorization"), "Bearer k", "same origin keeps credentials");

  for (const [path, kept] of [
    ["move", false],
    ["same", true],
  ] as const) {
    sent.length = 0;
    await f(`https://api.example.test/${path}`, { headers: credentials });
    for (const name of Object.keys(credentials))
      assert.equal(sent[1]!.headers.has(name), kept, `${path}: ${name}`);
  }
});
