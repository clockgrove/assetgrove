import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { disclose, disclosureMarkdown } from "../src/disclosure.ts";
import { writeToTarget } from "../src/handoff.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { developmentSigner } from "../src/credentials.ts";
import { loadSettings } from "../src/settings.ts";
import type { Provenance } from "../src/types.ts";
import { shelterSpec, syntheticProfile } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const prompt = "a secret prompt about dragons";
const clients: Client[] = [];
after(async () => {
  for (const client of clients) await client.close();
});

const provenance = (over: Partial<Provenance>): Provenance => ({
  digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  generator: "sprite-strip",
  route: "gateway",
  models: ["openai/gpt-image-2"],
  prompt,
  parameters: {},
  requestIds: [],
  referenceHashes: [],
  bibleVersion: "synthetic-1",
  license: "MIT",
  providerTerms: ["OpenAI Services Agreement (as of 2026-11-07)"],
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  costUsd: 0,
  calls: [
    {
      operation: "generate",
      model: "openai/gpt-image-2",
      route: "still",
      prompt,
      parameters: {},
      referenceHashes: [],
      requestId: "req-1",
      requestIdSource: "provider",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      costUsd: 0,
      costSource: "estimate",
      outputGrant: { license: "MIT", plan: "api", commercial: true, relabel: true },
    },
  ],
  ...over,
});

async function library(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), "assetgrove-disclosure-"));
  for (const [family, over] of [
    ["shelter", {}],
    ["walk", { models: ["openai/gpt-image-2", "bfl/flux-kontext-pro"] }],
    ["idle", { digitalSourceType: DIGITAL_SOURCE_TYPES.human, models: [], calls: [] }],
  ] as Array<[string, Partial<Provenance>]>) {
    const profile = syntheticProfile({ handoff: [{ preset: "atlas-json" }] });
    delete profile.validator;
    profile.layout.provenance =
      "assets/source/{{spec.assetId}}/{{spec.animationFamily}}.provenance.json";
    await writeToTarget({
      profile,
      spec: { ...shelterSpec, animationFamily: family },
      bibleVersion: "v1",
      output: {
        bytes: encodePng(createRaster(96, 8)),
        mediaType: "image/png",
        extension: "png",
        fields: { frames: { width: 16, height: 8, count: 6, durationMs: 120 } },
      },
      provenance: provenance(over),
      run: { runId: `r-${family}`, candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
      targetDir: target,
    });
  }
  return target;
}

function cli(args: string[]): Promise<string> {
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  return new Promise((resolve, reject) =>
    execFile(process.execPath, ["src/cli.ts", ...args], { cwd: root, env }, (e, out) =>
      e ? reject(e) : resolve(out),
    ),
  );
}

test("disclose reports kinds, source types, models, providers and terms with dates", async () => {
  const d = await disclose(await library());
  assert.equal(d.assets, 3);
  assert.deepEqual(d.byKind["sprite-strip"], {
    trainedAlgorithmicMedia: 2,
    digitalCreation: 1,
  });
  assert.deepEqual(d.models, [
    { name: "openai/gpt-image-2", assets: 2 },
    { name: "bfl/flux-kontext-pro", assets: 1 },
  ]);
  assert.deepEqual(
    d.providers.map((p) => p.name),
    ["openai"],
  );
  assert.deepEqual(d.terms, [
    { terms: "OpenAI Services Agreement (as of 2026-11-07)", asOf: "2026-11-07", assets: 3 },
  ]);
  assert.match(d.steam, /2 of 3 assets/);
  assert.deepEqual(d.itch.tags, ["ai-generated-assets"]);
  assert.ok(!JSON.stringify(d).includes(prompt));
});

test("the CLI and the tool return the same JSON, and no output holds prompt text", async () => {
  const target = await library();
  const printed = await cli(["disclosure", target, "--json"]);
  const doc = JSON.parse(printed) as Record<string, unknown>;
  assert.equal(doc["command"], "disclosure");
  const client = new Client({ name: "assetgrove-disclosure-test", version: "0.0.0" });
  const env = { ...process.env } as Record<string, string>;
  delete env["AI_GATEWAY_API_KEY"];
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp"],
      cwd: root,
      env,
      stderr: "pipe",
    }),
  );
  clients.push(client);
  const tool = await client.callTool({ name: "disclosure", arguments: { root: target } });
  assert.deepEqual(tool.structuredContent, doc);
  assert.ok(!printed.includes(prompt));
  assert.ok(!JSON.stringify(tool).includes(prompt));
});

test("--out writes the Markdown summary without prompt text", async () => {
  const target = await library();
  const cwd = await mkdtemp(join(tmpdir(), "assetgrove-disclosure-out-"));
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  await new Promise<void>((resolve, reject) =>
    execFile(
      process.execPath,
      [join(root, "src/cli.ts"), "disclosure", target, "--out", "summary.md"],
      { cwd, env },
      (e) => (e ? reject(e) : resolve()),
    ),
  );
  const text = await readFile(join(cwd, "summary.md"), "utf8");
  assert.match(text, /Steam AI content survey/);
  assert.ok(!text.includes(prompt));
});

test("content credentials count development and settings signers, and the note names the development one", async () => {
  const target = await mkdtemp(join(tmpdir(), "assetgrove-disclosure-cc-"));
  // A certificate of the developer's own, named by the developer settings.
  const keys = await mkdtemp(join(tmpdir(), "assetgrove-disclosure-keys-"));
  const own = await developmentSigner(keys);
  const settings = {
    ...loadSettings(),
    contentCredentials: {
      certificate: join(keys, "content-credentials", "chain.pem"),
      privateKey: join(keys, "content-credentials", "signer.key"),
    },
  };
  for (const [family, gate] of [
    ["shelter", undefined],
    ["walk", { settings }],
  ] as const) {
    const profile = syntheticProfile({ handoff: [{ preset: "atlas-json" }] });
    delete profile.validator;
    profile.layout.provenance =
      "assets/source/{{spec.assetId}}/{{spec.animationFamily}}.provenance.json";
    await writeToTarget({
      profile,
      spec: { ...shelterSpec, animationFamily: family },
      bibleVersion: "v1",
      output: {
        bytes: encodePng(createRaster(96, 8)),
        mediaType: "image/png",
        extension: "png",
        fields: { frames: { width: 16, height: 8, count: 6, durationMs: 120 } },
      },
      provenance: provenance({}),
      run: { runId: `r-${family}`, candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
      targetDir: target,
      ...(gate && { gate }),
    });
  }
  const d = await disclose(target);
  assert.equal(d.contentCredentials.signed, 2);
  assert.equal(d.contentCredentials.development, 1);
  assert.deepEqual(d.contentCredentials.signers.map((s) => [s.development, s.assets]).sort(), [
    [false, 1],
    [true, 1],
  ]);
  assert.ok(
    d.contentCredentials.signers.some(
      (s) => !s.development && s.certificateSha256 === own.record.certificateSha256,
    ),
  );
  assert.match(
    d.contentCredentials.note ?? "",
    /1 asset was signed with Assetgrove's local development certificate/,
  );
  assert.match(d.contentCredentials.note ?? "", /no C2PA trust list/);
  const md = disclosureMarkdown(d);
  assert.match(md, /## Content credentials\nSigned assets: 2/);
  assert.ok(md.includes(`(sha256 ${own.record.certificateSha256}): 1`));
});
