import "./fixtures/env.ts";
import { approveCommand } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import localStyle, { doctor } from "../packages/assetgrove-local-style/src/index.ts";
import { createExtensionContext } from "../src/extension/context.ts";
import { ExtensionRegistry } from "../src/extensions/registry.ts";
import { createProvider } from "../src/providers/adapter.ts";
import { loadSettings } from "../src/settings.ts";
import { ConfirmationError } from "../src/approvals.ts";

test("local style runs an approved settings graph, binds identity and lapses on changed graph", async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "local-style-")));
  try {
    const graph = join(dir, "graph.cjs");
    const code =
      'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync("input/request.json")); fs.mkdirSync("output"); fs.writeFileSync("output/image.png", JSON.stringify(r));';
    await writeFile(graph, code);
    const configuration = {
      executable: process.execPath,
      graph,
      model: "synthetic-style-v1",
      endpoint: "http://127.0.0.1:8188",
    };
    const entry = localStyle(createExtensionContext("local-style", () => {}, configuration));
    const registry = new ExtensionRegistry([
      {
        extension: entry,
        info: { package: "local-style", version: "0.1.0", entry: "src/index.ts" },
        settings: configuration,
      },
    ]);
    const provider = () =>
      createProvider(
        "local",
        { adapter: "local-style:image", baseURL: configuration.endpoint, free: true },
        {
          adapters: entry.adapters,
          toolScope: { tools: registry.tools, gate: { settings: loadSettings() }, projectDir: dir },
        },
      ).provider;
    const request = {
      model: configuration.model,
      prompt: "synthetic",
      references: [],
      providerOptions: { malicious: { graph: "/unapproved", endpoint: "https://remote.invalid" } },
    };
    const error = await provider()
      .generateImage(request)
      .catch((e: unknown) => e);
    assert.ok(error instanceof ConfirmationError);
    approveCommand({
      hash: error.confirmation!.id,
      kind: "tool",
      argv: [process.execPath, graph, configuration.endpoint, configuration.model],
    });
    assert.equal(provider().billing.paid, false);
    const result = await provider().generateImage(request);
    const identity = JSON.parse(result.requestId);
    assert.equal(identity.model, configuration.model);
    assert.equal(identity.graphSha256, createHash("sha256").update(code).digest("hex"));
    const seen = JSON.parse(Buffer.from(result.images[0]!.bytes).toString());
    assert.equal(seen.identity.endpoint, configuration.endpoint);
    assert.equal(seen.providerOptions, undefined);
    assert.equal(seen.identity.graphSha256, identity.graphSha256);
    await writeFile(graph, code + "\n");
    const changed = await provider()
      .generateImage(request)
      .catch((e: unknown) => e);
    assert.ok(changed instanceof ConfirmationError);
    assert.notEqual(changed.confirmation!.id, error.confirmation!.id);
    assert.deepEqual(doctor(configuration), {
      mediaEndpoint: configuration.endpoint,
      model: configuration.model,
      graph,
      source: "unknown",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
