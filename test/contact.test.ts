import "./fixtures/env.ts";
import { approve } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { splitStrip } from "../src/animation/strip.ts";
import { renderContact, writeContact } from "../src/contact.ts";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { imageGenerators } from "../src/generators/image.ts";
import { createRaster, decodePng, encodePng, setPixel } from "../src/image/raster.ts";
import { stage } from "../src/loop.ts";
import type { StageOptions } from "../src/loop.ts";
import { applyPlan, createPlan } from "../src/planning.ts";
import { defaultRoutes } from "../src/routes.ts";
import { generateSheet } from "../src/sheet/generate.ts";
import type { AssetSpec, StyleBible } from "../src/types.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import {
  drawSubject,
  scriptedProvider,
  shelterSpec,
  syntheticProfile,
  syntheticWorld,
} from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(script);

const temporary: string[] = [];
const clients: Client[] = [];
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-contact-"));
  temporary.push(dir);
  return dir;
}

const stillSpec: AssetSpec = { kind: "still", assetId: "den", animationFamily: "idle" };

function options(world: World, spec: AssetSpec, extra: Partial<StageOptions> = {}): StageOptions {
  return {
    spec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: world.profile,
    routes: defaultRoutes,
    provider: scriptedProvider(),
    providerName: "scripted",
    generators: imageGenerators,
    runsDir: world.runsDir,
    candidates: 3,
    ...extra,
  };
}

async function world(): Promise<World> {
  const w = await syntheticWorld();
  temporary.push(w.dir);
  return w;
}

test("a stage of 3 stills writes contact.png with 3 numbered cells beside the references, and run.json names it", async () => {
  const w = await world();
  const { run, runDir } = await stage(options(w, stillSpec));
  assert.equal(run.candidates.length, 3);
  assert.equal(run.contactSheet, "contact.png");
  const saved = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  assert.equal(saved.contactSheet, "contact.png");
  // Each candidate carries its QA reasons and cost in the JSON.
  assert.ok(
    saved.candidates.every(
      (c: { reasons: unknown[]; provenance: { costUsd: number } }) =>
        c.reasons.length > 0 && c.provenance.costUsd >= 0,
    ),
  );

  const sheet = decodePng(new Uint8Array(await readFile(join(runDir, "contact.png"))));
  const refs = await Promise.all(
    w.bible.references
      .filter((r) => r.subject === "den")
      .map(async (r) => decodePng(new Uint8Array(await readFile(join(w.bibleDir, r.path))))),
  );
  assert.equal(refs.length, 1);
  const rows = await Promise.all(
    run.candidates.map(async (c) => ({
      number: Number(c.id.slice(1)),
      images: [decodePng(new Uint8Array(await readFile(join(runDir, c.file))))],
    })),
  );
  const layout = renderContact(rows, refs);
  assert.deepEqual(Array.from(sheet.data), Array.from(layout.raster.data));
  const numbers = layout.cells.filter((c) => c.kind === "number").map((c) => c.number);
  assert.deepEqual(numbers, [1, 2, 3]);
  assert.equal(layout.cells.filter((c) => c.kind === "image").length, 3);
  // The references sit to the right of their candidate, in the same row.
  for (const n of [1, 2, 3]) {
    const image = layout.cells.find((c) => c.kind === "image" && c.number === n)!;
    const reference = layout.cells.find((c) => c.kind === "reference" && c.number === n)!;
    assert.equal(reference.y, image.y);
    assert.ok(reference.x > image.x + image.width);
  }
});

test("a sprite-strip sheet has one key-frame row per candidate; a character-3d sheet has turntable frames per candidate", async () => {
  const w = await world();
  const { run, runDir } = await stage(options(w, shelterSpec, { candidates: 2 }));
  assert.equal(run.candidates.length, 2);
  const sheet = decodePng(new Uint8Array(await readFile(join(runDir, "contact.png"))));
  const refs = (
    await Promise.all(
      w.bible.references
        .filter((r) => r.subject === "fern")
        .map((r) => readFile(join(w.bibleDir, r.path))),
    )
  ).map((b) => decodePng(new Uint8Array(b)));
  const frame = drawSubject(96, 0);
  const rows = await Promise.all(
    run.candidates.map(async (c) => {
      const strip = decodePng(new Uint8Array(await readFile(join(runDir, c.file))));
      const { width, height } = c.fields["frames"] as { width: number; height: number };
      assert.equal(strip.width, width * 6);
      return { number: Number(c.id.slice(1)), images: splitStrip(strip, { width, height }) };
    }),
  );
  const layout = renderContact(rows, refs);
  assert.deepEqual(Array.from(sheet.data), Array.from(layout.raster.data));
  for (const n of [1, 2])
    assert.equal(layout.cells.filter((c) => c.kind === "image" && c.number === n).length, 6);
  assert.equal(sheet.height, 8 + 2 * 104, "two rows");

  // Turntable: each 3D candidate shows its view renders, not its clip frames.
  const dir = await tempDir();
  const candidates = [];
  for (const id of ["c1", "c2"]) {
    await mkdir(join(dir, `${id}-character-3d`));
    const names = ["front", "three-quarter", "side", "back"].map((n) => `${n}.png`);
    names.push("clip-idle-0.png");
    for (const n of names)
      await writeFile(join(dir, `${id}-character-3d`, n), encodePng(drawSubject(64, 1)));
    candidates.push({
      id,
      file: `${id}.glb`,
      mediaType: "model/gltf-binary",
      fields: {},
      artifacts: names.map((n) => `${id}-character-3d/${n}`),
    });
  }
  const file = await writeContact(dir, { kind: "character-3d", assetId: "fern" }, candidates, []);
  assert.equal(file, "contact.png");
  const three = decodePng(new Uint8Array(await readFile(join(dir, "contact.png"))));
  const expected = renderContact(
    [1, 2].map((number) => ({ number, images: Array.from({ length: 4 }, () => frame) })),
    [],
  );
  assert.deepEqual([three.width, three.height], [expected.raster.width, expected.raster.height]);
});

test("the sheet is pixel-identical when only bible text changes", async () => {
  const w = await world();
  const first = await stage(options(w, stillSpec, { runId: "same", runsDir: join(w.dir, "a") }));
  const changed: StyleBible = {
    ...w.bible,
    mood: ["loud", "neon"],
    notes: ["A different note entirely"],
    subjects: { den: { description: "a glass den" }, fern: { description: "a red fox" } },
  };
  const second = await stage(
    options(w, stillSpec, { bible: changed, runId: "same", runsDir: join(w.dir, "b") }),
  );
  assert.notEqual(
    first.run.candidates[0]!.provenance.prompt,
    second.run.candidates[0]!.provenance.prompt,
  );
  const a = await readFile(join(first.runDir, "contact.png"));
  const b = await readFile(join(second.runDir, "contact.png"));
  assert.ok(a.equals(b));
});

test("the MCP stage result includes an image content block equal to contact.png, and bible text appears only under sharedText", async () => {
  const w = await world();
  const NOTE = "Moonlit-note-7731 keeps every edge soft";
  const bible: StyleBible = { ...w.bible, notes: [NOTE] };
  await writeFile(join(w.dir, "spec.json"), JSON.stringify(stillSpec));
  await writeFile(join(w.bibleDir, "bible.json"), JSON.stringify(bible));
  await writeFile(join(w.dir, "profile.json"), JSON.stringify(syntheticProfile()));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["AI_GATEWAY_API_KEY"];
  for (const name of REFUSED_VARIABLES) {
    delete env[name];
    delete env[name.toLowerCase()];
  }
  const client = new Client({ name: "contact-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--provider-script", script],
      cwd: root,
      env,
      stderr: "pipe",
    }),
  );
  clients.push(client);
  const result = await client.callTool({
    name: "stage",
    arguments: {
      spec: join(w.dir, "spec.json"),
      bible: join(w.bibleDir, "bible.json"),
      profile: join(w.dir, "profile.json"),
      runs: w.runsDir,
      candidates: 2,
    },
  });
  const content = result.content as Array<{ type: string; data?: string; mimeType?: string }>;
  const doc = result.structuredContent as Record<string, unknown>;
  assert.equal(doc["ok"], true, JSON.stringify(doc));
  const image = content.find((c) => c.type === "image")!;
  assert.equal(image.mimeType, "image/png");
  const disk = await readFile(join(String(doc["runDir"]), String(doc["contactSheet"])));
  assert.ok(Buffer.from(image.data!, "base64").equals(disk));

  const { sharedText: shared, ...rest } = doc;
  const sharedText = shared as Array<{ source: string; text: string }>;
  assert.ok(sharedText.some((s: { text: string }) => s.text === NOTE));
  assert.ok(sharedText.every((s: { source: string }) => typeof s.source === "string"));
  assert.ok(!JSON.stringify(rest).includes(NOTE));
  const text = content.find((c) => c.type === "text") as unknown as { text: string };
  assert.equal(text.text.split(NOTE).length - 1, 1, "the text block holds it once, in sharedText");
});

test("apply and generate-sheet also write contact.png", async () => {
  // apply
  const dir = await tempDir();
  await mkdir(join(dir, ".assetgrove/art-direction"), { recursive: true });
  await mkdir(join(dir, ".assetgrove/prompts"), { recursive: true });
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.referenceLicense = "NOASSERTION";
  data.world = "Woodland";
  const biblePath = join(dir, ".assetgrove/art-direction/BIBLE.md");
  await writeFile(biblePath, serializeBible(data, "## Do's and Don'ts\nDo preserve identity.\n"));
  await writeFile(
    join(dir, ".assetgrove/prompts/default.md"),
    "# Prompt template v1\nCreate original art.\n{{constitution}}\n{{spec}}\n{{brief}}\n{{settings}}\n{{family}}\n",
  );
  const plan = await createPlan({
    biblePath,
    spec: { kind: "still", assetId: "den" },
    settings: { candidates: 2, capUsd: 5 },
    profile: syntheticProfile(),
  });
  const image = createRaster(4, 4);
  setPixel(image, 1, 1, [120, 90, 80, 255]);
  const provider = new ScriptedProvider({
    image: () => ({ images: [{ mediaType: "image/png", bytes: encodePng(image) }] }),
    vision: () => ({ text: JSON.stringify({ styleScore: 1, passed: true, reason: "ok" }) }),
    decide: () => ({ answer: { type: "score", score: 3.5 }, confidence: 0.8 }),
  });
  const applied = await applyPlan(plan, {
    provider,
    autoApprove: true,
    outDir: join(dir, "runs"),
  });
  assert.equal(applied.run.candidates.length, 2);
  assert.equal(applied.run.contactSheet, "contact.png");
  decodePng(new Uint8Array(await readFile(join(applied.runDir, "contact.png"))));
  const record = JSON.parse(await readFile(join(applied.runDir, "run.json"), "utf8"));
  assert.equal(record.contactSheet, "contact.png");

  // generate-sheet
  const w = await world();
  const sheet = syntheticSheet({
    families: [{ name: "walk-right", count: 6, facing: 1, walk: true }],
    columns: 3,
  });
  const sheetProvider = new ScriptedProvider({
    image: () => ({ images: [{ mediaType: "image/png", bytes: sheet.png }], costUsd: 0.21 }),
    vision: () => ({
      text: JSON.stringify({
        families: [{ name: "walk", frames: [1, 2, 3, 4, 5, 6], reason: "one walk cycle" }],
        unassigned: [],
      }),
      costUsd: 0.01,
    }),
  });
  const runDir = join(w.dir, "run");
  await mkdir(runDir);
  const base = syntheticProfile();
  const generated = await generateSheet({
    spec: {
      kind: "sprite-sheet",
      assetId: "fern",
      animationFamily: "walk",
      frames: { count: 6 },
    },
    specDir: w.dir,
    bible: w.bible,
    bibleDir: w.bibleDir,
    profile: {
      ...base,
      style: { alpha: { mode: "soft" }, color: { rule: "full" } },
      manifest: { ...(base.manifest as Record<string, unknown>), style: "{{profile.style?}}" },
    },
    routes: defaultRoutes,
    provider: sheetProvider,
    providerName: "scripted",
    importsDir: join(w.dir, "imports"),
    runDir,
  });
  assert.equal(generated.contactSheet, "contact.png");
  decodePng(new Uint8Array(await readFile(join(runDir, "contact.png"))));
});
