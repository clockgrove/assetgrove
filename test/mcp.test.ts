import "./fixtures/env.ts";
import { approve, approveProfile, settingsPath } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { commands } from "../src/commands/registry.ts";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { flagName } from "../src/commands/runner.ts";
import type { CommandSpec } from "../src/commands/types.ts";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { createRaster, decodeImage, encodePng, setPixel } from "../src/image/raster.ts";
import type { TargetProfile } from "../src/types.ts";
import { GAME, fixtureLibrary } from "./fixtures/library.ts";
import { gitTarget } from "./fixtures/git.ts";
import { lodModel } from "./fixtures/lod.ts";
import { quadrupedTemplate, syntheticQuadruped, walkGait } from "./fixtures/quadruped.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";
import { syntheticStrip } from "./fixtures/strip.ts";
import {
  PALETTE,
  drawSubject,
  shelterSpec,
  syntheticProfile,
  syntheticWorld,
} from "./fixtures/synthetic.ts";

type Args = Record<string, unknown>;
type Doc = Record<string, unknown>;

const root = fileURLToPath(new URL("..", import.meta.url));
const synthetic = fileURLToPath(new URL("./fixtures/synthetic.ts", import.meta.url));
const raster = fileURLToPath(new URL("../src/image/raster.ts", import.meta.url));
const LOOKDEV_SCRIPT = fileURLToPath(new URL("./fixtures/lookdev-script.ts", import.meta.url));
const ANIMATION_SCRIPT = fileURLToPath(new URL("./fixtures/animation-script.ts", import.meta.url));
approve(LOOKDEV_SCRIPT, ANIMATION_SCRIPT);
const temporary: string[] = [];
const clients: Client[] = [];

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  temporary.push(dir);
  return dir;
}

/** The environment of every child: the test settings and ledger, and no model key. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["AI_GATEWAY_API_KEY"];
  // The mark test's own settings allow no proxy or TLS variable; the server needs no network.
  for (const name of REFUSED_VARIABLES) {
    delete env[name];
    delete env[name.toLowerCase()];
  }
  return { ...env, ...extra };
}

/** Starts `assetgrove mcp` with the given flags over stdio and connects a client to it. */
async function connect(flags: string[], env: Record<string, string> = childEnv()) {
  const client = new Client({ name: "assetgrove-mcp-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", ...flags],
    cwd: root,
    env,
    stderr: "pipe",
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function cli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...argv],
      { cwd: root, env: childEnv(), timeout: 60_000 },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

const spec = (tool: string): CommandSpec => commands.find((c) => c.tool === tool)!;

/** A tool call's arguments as the command line of its command, with the server's script and --json. */
function commandLine(command: CommandSpec, args: Args, script: string): string[] {
  const positionals = new Set((command.positionals ?? []).map((p) => p.name));
  const argv = [command.name];
  for (const p of command.positionals ?? []) {
    const value = args[p.name];
    if (Array.isArray(value)) argv.push(...value.map(String));
    else if (value !== undefined) argv.push(String(value));
  }
  for (const [name, value] of Object.entries(args)) {
    if (positionals.has(name)) continue;
    if (value === true) argv.push(`--${flagName(name)}`);
    else if (Array.isArray(value)) for (const v of value) argv.push(`--${flagName(name)}`, v);
    else if (typeof value === "object" && value !== null)
      argv.push(`--${flagName(name)}`, JSON.stringify(value));
    else argv.push(`--${flagName(name)}`, String(value));
  }
  if ("providerScript" in command.input.properties) argv.push("--provider-script", script);
  return [...argv, "--json"];
}

/**
 * What legitimately differs between two runs of one command: run IDs, times, random seeds, signed
 * C2PA manifests and what hashes them.
 */
function normalise(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]+/g, "<run>")
      .replace(/"(durationMs|elapsedMs|latencyMs|seed)":\d+(\.\d+)?/g, '"$1":0')
      // A plan's digest covers its creation time.
      .replace(/"digest":"[0-9a-f]{64}"/g, '"digest":"<digest>"')
      // A signed image's bytes: its C2PA manifest holds random identifiers and a fresh signature.
      .replace(/("version":\d+,"sha256":)"[0-9a-f]{64}"/g, '$1"<signed>"')
      // An annotation's id hashes its creation time.
      .replace(/#[0-9a-f]{16}/g, "#<annotation>"),
  );
}

/** The scripted provider every tool and command call shares: images pass QA, plans compile. */
async function writeScript(dir: string): Promise<string> {
  const path = join(dir, "provider.mjs");
  const checks = ["transparency", "frame-count", "identity", "perspective", "style"];
  await writeFile(
    path,
    `import { pathToFileURL } from "node:url";
const { drawSubject } = await import(pathToFileURL(${JSON.stringify(synthetic)}));
const { encodePng } = await import(pathToFileURL(${JSON.stringify(raster)}));
export default {
  image(request) {
    const m = /frame (\\d+) of/.exec(request.prompt);
    return { images: [{ mediaType: "image/png", bytes: encodePng(drawSubject(96, m?.[1] ? Number(m[1]) : 0)) }] };
  },
  vision() {
    return { text: JSON.stringify({
      prompt: "A friendly round icon, flat cel shading, bold outlines.",
      negativePrompt: "No text or photographic textures.",
      violations: [], clamps: [], styleScore: 1, passed: true, reason: "scripted match",
      checks: ${JSON.stringify(checks)}.map((check) => ({ check, passed: true, reason: "ok" })),
    }) };
  },
};`,
  );
  approve(path);
  return path;
}

let work: string;
let script: string;
let server: Client;

const settingsText = () => readFileSync(settingsPath, "utf8");

before(async () => {
  work = await tempDir("assetgrove-mcp-");
  script = await writeScript(work);
  server = await connect(["--provider-script", script]);
});

test("tools/list names equal the registry's tool names and no tool takes a CLI-only argument", async () => {
  const { tools } = await server.listTools();
  // With no extension filling the search slot, the search-only commands have no tool.
  const expected = commands.flatMap((c) =>
    c.tool === null || c.requires === "search" ? [] : [c.tool],
  );
  assert.deepEqual(tools.map((t) => t.name).sort(), [...expected].sort());
  assert.ok(!expected.includes("mcp"));
  for (const tool of tools) {
    const properties = Object.keys(tool.inputSchema.properties ?? {});
    for (const forbidden of ["providerScript", "json", "help", "dryRun", "routes", "autoApprove"])
      assert.ok(!properties.includes(forbidden), `${tool.name} takes ${forbidden}`);
    assert.ok(tool.outputSchema, `${tool.name} has an output schema`);
    const command = spec(tool.name);
    assert.equal(tool.annotations?.readOnlyHint, command.effect.readOnly, tool.name);
    assert.equal(tool.annotations?.openWorldHint, command.effect.spends !== "never", tool.name);
    assert.equal(
      tool.annotations?.destructiveHint,
      tool.name === "pick" || tool.name === "write_families",
      tool.name,
    );
  }
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Doc;
  assert.deepEqual(server.getServerVersion(), {
    name: version["name"],
    version: version["version"],
  });
});

/** The card the pick row wrote into the work directory's target. */
async function pickedCard(): Promise<string> {
  const target = join(work, "target");
  for (const entry of await readdir(target, { recursive: true })) {
    const path = join(target, entry.toString());
    if (!path.endsWith(".md") || /(^|[\\/])(index|log)\.md$/.test(path)) continue;
    if ((await readFile(path, "utf8")).includes("type: Game Asset")) return path;
  }
  throw new Error("the pick row wrote no card");
}

/**
 * One row per tool: `prepare` builds what the call needs in the work directory and returns its
 * arguments, reaching the command's own result fields. `script` names the scripted provider when
 * the shared one cannot answer the command; the CLI run and the tool call use the same one.
 * `prepare` sees the previous row's tool result, for a row that takes what that call made.
 */
interface Row {
  tool: string;
  prepare: (previous: Doc) => Promise<Args>;
  script?: () => Promise<string>;
  exitCode?: number;
}

const paths = {
  repo: () => join(work, "repo"),
  bible: () => join(work, "repo", ".assetgrove", "art-direction", "BIBLE.md"),
  world: () => join(work, "world"),
};

async function world() {
  const w = await syntheticWorld();
  await cp(w.dir, paths.world(), { recursive: true });
  await rm(w.dir, { recursive: true, force: true });
  const dir = paths.world();
  await writeFile(join(dir, "spec.json"), JSON.stringify(shelterSpec));
  await writeFile(join(dir, "bible", "bible.json"), JSON.stringify(w.bible));
  await writeFile(join(dir, "profile.json"), JSON.stringify(w.profile));
}

/** The fixture library (test/fixtures/library.ts) in the work directory, built once. */
async function library(): Promise<string> {
  const dir = join(work, "library");
  if (existsSync(dir)) return dir;
  const built = fixtureLibrary();
  await cp(built.dir, dir, { recursive: true });
  await rm(built.dir, { recursive: true, force: true });
  return dir;
}

/** A scripted provider module written into the work directory under `name`. */
async function moduleScript(name: string, body: string): Promise<string> {
  const path = join(work, name);
  await writeFile(path, body);
  approve(path);
  return path;
}

/** The provenance a hand-made model carries into `rig` and `lod`. */
const modelProvenance = {
  generator: "character-3d",
  route: "scripted:model3d:synthetic",
  models: ["synthetic"],
  prompt: "a synthetic quadruped",
  parameters: { gait: "quadruped", rigType: "quadruped", heightM: 0.45 },
  requestIds: ["req-1"],
  referenceHashes: [],
  bibleVersion: "2026-11-10",
  license: "MIT",
  providerTerms: ["synthetic"],
  startedAt: "2026-11-10T00:00:00.000Z",
  finishedAt: "2026-11-10T00:00:01.000Z",
  costUsd: 0,
  calls: [],
};

/** A quadruped target with a rig template and a groom: the `rig` and `look_dev` world. */
async function quadrupedWorld() {
  const dir = join(work, "quadruped");
  await mkdir(join(dir, "refs"), { recursive: true });
  const roles = ["turnaround-front", "turnaround-side", "turnaround-back"];
  for (const [i, role] of roles.entries())
    await writeFile(join(dir, "refs", `${role}.png`), encodePng(drawSubject(64, i * 4)));
  await mkdir(join(dir, "rig"));
  await writeFile(join(dir, "rig", "quadruped.json"), JSON.stringify(quadrupedTemplate()));
  const files = {
    dir,
    spec: join(dir, "spec.json"),
    bible: join(dir, "bible.json"),
    profile: join(dir, "profile.json"),
    model: join(dir, "model.glb"),
    provenance: join(dir, "provenance.json"),
  };
  await writeFile(
    files.spec,
    JSON.stringify({
      kind: "character-3d",
      assetId: "kit",
      subject: "kit",
      gait: "quadruped",
      clips: ["walk"],
      heightM: 0.45,
    }),
  );
  await writeFile(
    files.bible,
    JSON.stringify({
      format: "assetgrove-style-bible/1",
      referenceLicense: "NOASSERTION",
      version: "2026-11-10",
      palette: PALETTE,
      references: roles.map((role) => ({ path: `refs/${role}.png`, role, subject: "kit" })),
      perspective: "refs/turnaround-front.png",
      subjects: { kit: { description: "a small synthetic quadruped" } },
    }),
  );
  await writeFile(
    files.profile,
    JSON.stringify({
      format: "assetgrove-target-profile/1",
      name: "synthetic-grove-quadruped",
      license: "MIT",
      frames: { width: 32, height: 32 },
      model3d: {
        format: "glb",
        budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
        units: "m",
        turntable: { sizePx: 64 },
        rig: { template: "rig/quadruped.json", kind: "synthetic-quadruped" },
        gaits: { walk: walkGait() },
        groom: {
          sizePx: 256,
          seasons: ["summer"],
          traits: { summer: "short, sleek, grey-brown" },
        },
      },
      layout: {
        media: "characters/{{spec.assetId}}/{{spec.assetId}}.{{output.extension}}",
        manifest: "characters/{{spec.assetId}}/manifest.json",
      },
      manifest: {
        assetId: "{{spec.assetId}}",
        source: { path: "{{output.path}}", mediaType: "{{output.mediaType}}" },
        license: "{{profile.license}}",
        review: { status: "pending" },
        contentHash: "{{output.sha256}}",
      },
      review: { path: "review.status", pending: "pending" },
    }),
  );
  await writeFile(files.model, syntheticQuadruped({ atlasUvs: true }));
  await writeFile(files.provenance, JSON.stringify(modelProvenance));
  return files;
}

/** A model the profile declares three detail levels for, as test/lod.test.ts builds it. */
async function lodWorld(): Promise<Args> {
  const dir = join(work, "lod");
  await mkdir(dir, { recursive: true });
  const profile = syntheticProfile({
    layout: {
      media: "assets/{{spec.assetId}}/{{spec.assetId}}.{{output.extension}}",
      manifest: "assets/{{spec.assetId}}/manifest.json",
    },
    manifest: {
      assetId: "{{spec.assetId}}",
      output: { path: "{{output.path}}", lods: "{{output.lods}}" },
      review: { status: "pending" },
    },
    model3d: {
      format: "glb",
      units: "m",
      budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 3 },
      turntable: { sizePx: 64 },
      lods: [
        { level: 0, triangleRatio: 1, minScreenHeight: 0.15 },
        { level: 1, triangleRatio: 0.33, minScreenHeight: 0.05 },
        { level: 2, triangleRatio: 0.1, minScreenHeight: 0 },
      ],
    },
  } as Partial<TargetProfile>);
  delete profile.validator;
  const files = {
    model: join(dir, "model.glb"),
    provenance: join(dir, "provenance.json"),
    spec: join(dir, "spec.json"),
    profile: join(dir, "profile.json"),
  };
  await writeFile(files.model, lodModel());
  await writeFile(
    files.provenance,
    JSON.stringify({ ...modelProvenance, generator: "model3d", parameters: {} }),
  );
  await writeFile(
    files.spec,
    JSON.stringify({
      kind: "character-3d",
      assetId: "kit",
      fields: {
        semantic: { role: "actor", entity: "grove.kit", archetype: null },
        accessibilityLabel: "A small synthetic kit",
      },
    }),
  );
  await writeFile(files.profile, JSON.stringify(profile));
  return { ...files, runs: join(dir, "runs") };
}

/** A bible with one approved identity record and its turnaround, as test/identity-cli.test.ts has. */
async function identityWorld(): Promise<{ dir: string; bible: string }> {
  const dir = join(work, "identity");
  const art = join(dir, "art");
  await mkdir(art, { recursive: true });
  const ref = createRaster(24, 24);
  setPixel(ref, 3, 3, [180, 90, 40, 255]);
  await writeFile(join(art, "bram-turnaround.png"), encodePng(ref));
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.referenceLicense = "NOASSERTION";
  data.world = "Synthetic";
  data.identities = {
    bram: {
      version: "bram-3",
      approved: true,
      turnaround: "bram-turnaround.png",
      signatureFeatures: ["striped tail"],
      proportions: "round body",
      palette: ["#b45a28"],
    },
  };
  const bible = join(art, "BIBLE.md");
  await writeFile(bible, serializeBible(data, "# Synthetic\n\n## Do's and Don'ts\nDo.\n"));
  await writeFile(join(dir, "sheet.png"), syntheticSheet().png);
  return { dir, bible };
}

/** An identity provider whose every answer is the same, so a long-lived server answers as a fresh CLI. */
const identityScript = () =>
  moduleScript(
    "identity-provider.mjs",
    `export default {
  image() { throw new Error("no image generation"); },
  vision() { return { text: '{"consistent": true, "conflicts": []}', costUsd: 0.0001 }; },
  decide() { return { answer: { type: "score", score: 4 }, confidence: 0.62, costUsd: 0.00003 }; },
};`,
  );

/** An eight-frame walk strip, its profile and the provenance fix-frame extends. */
async function stripWorld() {
  const dir = join(work, "strip");
  await mkdir(dir, { recursive: true });
  const { strip } = syntheticStrip({ count: 8, style: "painterly", motion: "walk", floatFrame: 3 });
  const files = { dir, strip: join(dir, "walk-right.png"), profile: join(dir, "profile.json") };
  await writeFile(files.strip, encodePng(strip));
  await writeFile(
    files.profile,
    JSON.stringify({ ...syntheticProfile(), frames: { width: 64, height: 64, durationMs: 100 } }),
  );
  await writeFile(
    `${files.strip}.provenance.json`,
    JSON.stringify({
      ...modelProvenance,
      generator: "sheet-import",
      route: "import:hand",
      models: ["hand"],
      prompt: "imported",
      parameters: {},
      requestIds: [],
      providerTerms: [],
    }),
  );
  return files;
}

const rows: Row[] = [
  { tool: "ops", prepare: async () => ({}) },
  {
    tool: "init",
    prepare: async () => ({
      directory: gitTarget(paths.repo()),
      profilePreset: "sprite-32",
      stylePreset: "flat-cartoon-kids",
      world: "Synthetic Grove",
    }),
  },
  { tool: "bible", prepare: async () => ({ action: "describe", bible: paths.bible() }) },
  {
    tool: "bible",
    prepare: async () => ({ action: "preset", bible: paths.bible(), preset: "cozy-storybook" }),
  },
  {
    tool: "plan",
    prepare: async () => {
      const dir = paths.repo();
      await writeFile(
        join(dir, "spec.json"),
        JSON.stringify({
          kind: "still",
          assetId: "icon",
          subject: "icon",
          animationFamily: "still",
        }),
      );
      await writeFile(join(dir, "profile.json"), JSON.stringify(syntheticProfile()));
      await writeFile(
        join(dir, "run-options.json"),
        JSON.stringify({ candidates: 1, strictness: 0.5 }),
      );
      return {
        spec: join(dir, "spec.json"),
        bible: paths.bible(),
        profile: join(dir, "profile.json"),
        runOptions: join(dir, "run-options.json"),
        out: join(dir, "plan.json"),
      };
    },
  },
  {
    tool: "apply",
    prepare: async () => {
      const plan = join(paths.repo(), "plan.json");
      return { plan, out: join(paths.repo(), "runs") };
    },
  },
  {
    tool: "stage",
    prepare: async () => {
      await world();
      const dir = paths.world();
      return {
        spec: join(dir, "spec.json"),
        bible: join(dir, "bible", "bible.json"),
        profile: join(dir, "profile.json"),
        runs: join(dir, "runs"),
        candidates: 1,
      };
    },
  },
  {
    tool: "estimate",
    prepare: async () => {
      const dir = paths.world();
      return {
        command: "stage",
        args: {
          spec: join(dir, "spec.json"),
          bible: join(dir, "bible", "bible.json"),
          profile: join(dir, "profile.json"),
          runs: join(dir, "runs"),
          candidates: 1,
        },
      };
    },
  },
  {
    tool: "pick",
    prepare: async () => {
      const runs = join(paths.world(), "runs");
      const [run] = await readdir(runs);
      const target = gitTarget(join(work, "target"));
      approveProfile(syntheticProfile(), { targetDir: target });
      return { run: join(runs, run!), candidate: "c1", target };
    },
  },
  { tool: "review", prepare: async () => ({ address: await pickedCard(), comment: "a row" }) },
  { tool: "approve", prepare: async () => ({ address: await pickedCard() }), exitCode: 8 },
  { tool: "card_edit", prepare: async () => ({ address: await pickedCard(), title: "A row" }) },
  {
    tool: "compare",
    prepare: async () => {
      const dir = join(work, "compare");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "before.png"), encodePng(drawSubject(48)));
      await writeFile(join(dir, "after.png"), encodePng(drawSubject(48, 2)));
      return {
        before: join(dir, "before.png"),
        candidate: join(dir, "after.png"),
        region: ["0,0,24,24 : check"],
        out: join(dir, "out"),
      };
    },
  },
  {
    tool: "vary",
    prepare: async () => {
      // Variations edit a still, so this row stages one beside the world's sprite-strip run.
      const dir = paths.world();
      const stills = join(dir, "still-runs");
      await writeFile(
        join(dir, "still.json"),
        JSON.stringify({ kind: "still", assetId: "fern", fields: { description: "a fern" } }),
      );
      const staged = await cli([
        ...["stage", "--spec", join(dir, "still.json")],
        ...["--bible", join(dir, "bible", "bible.json"), "--profile", join(dir, "profile.json")],
        ...["--runs", stills, "--candidates", "1", "--provider-script", script, "--json"],
      ]);
      assert.equal(staged.code, 0, staged.stderr + staged.stdout);
      return {
        run: (JSON.parse(staged.stdout) as Doc)["runDir"] as string,
        candidate: "c1",
        count: 2,
        runs: join(paths.world(), "vary-runs"),
      };
    },
  },
  { tool: "runs_list", prepare: async () => ({ runs: join(paths.world(), "runs") }) },
  {
    tool: "runs_show",
    prepare: async () => {
      const runs = join(paths.world(), "runs");
      const [run] = await readdir(runs);
      return { run: run!, runs };
    },
  },
  {
    tool: "ls",
    prepare: async () => ({ address: `asset://${GAME}/by-tag/prop/`, target: await library() }),
  },
  {
    tool: "cat",
    prepare: async () => ({ address: `asset://${GAME}/lantern/image`, target: await library() }),
  },
  {
    tool: "op",
    prepare: async () => {
      const input = join(work, "in.png");
      await writeFile(input, encodePng(drawSubject(48)));
      return { operation: "matte", inputs: [input], out: join(work, "out.png") };
    },
  },
  {
    tool: "import",
    prepare: async () => {
      const dir = join(work, "sheet");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "sheet.png"), syntheticSheet().png);
      // The style test/sheet-cli.test.ts imports under, which the target validator accepts.
      const base = syntheticProfile();
      const profile = {
        ...base,
        style: { alpha: { mode: "soft" }, color: { rule: "full" } },
        manifest: { ...(base.manifest as Doc), style: "{{profile.style?}}" },
      };
      await writeFile(join(dir, "profile.json"), JSON.stringify(profile));
      return {
        sheet: join(dir, "sheet.png"),
        profile: join(dir, "profile.json"),
        asset: "fern",
        tool: "hand drawn",
        noPropose: true,
        digitalSourceType: "digitalCreation",
        imports: join(dir, "imports"),
      };
    },
  },
  {
    tool: "write_families",
    prepare: async () => {
      const dir = join(work, "sheet");
      const imported = join(dir, "imports", (await readdir(join(dir, "imports")))[0]!);
      const proposal = JSON.parse(await readFile(join(imported, "grouping.json"), "utf8")) as Doc;
      const grouping = join(dir, "confirmed.json");
      await writeFile(
        grouping,
        JSON.stringify({
          ...proposal,
          status: "confirmed",
          families: [
            { name: "walk-right", frames: [5, 6, 7, 8, 9, 10], reason: "legs swing, facing right" },
            { name: "walk-left", mirrorOf: "walk-right", reason: "mirror of walk-right" },
          ],
        }),
      );
      const target = join(dir, "target");
      await mkdir(target, { recursive: true });
      approveProfile(syntheticProfile(), { targetDir: target });
      return { import: imported, target, grouping };
    },
  },
  {
    tool: "generate_sheet",
    // The model draws the 16-figure sheet the spec asks for; the grouping call proposes nothing.
    script: () =>
      moduleScript(
        "sheet-provider.mjs",
        `const png = ${JSON.stringify(Buffer.from(syntheticSheet().png).toString("base64"))};
export default {
  image: () => ({ images: [{ mediaType: "image/png", bytes: Uint8Array.from(Buffer.from(png, "base64")) }], costUsd: 0.2 }),
  vision: () => ({ text: JSON.stringify({ families: [], unassigned: [] }), costUsd: 0.01 }),
};`,
      ),
    prepare: async () => {
      const dir = paths.world();
      await writeFile(
        join(dir, "sheet-spec.json"),
        JSON.stringify({ ...shelterSpec, frames: { count: 16 } }),
      );
      return {
        spec: join(dir, "sheet-spec.json"),
        bible: join(dir, "bible", "bible.json"),
        profile: join(dir, "profile.json"),
        imports: join(dir, "imports"),
      };
    },
  },
  {
    tool: "rig",
    prepare: async () => {
      const w = await quadrupedWorld();
      return {
        model: w.model,
        provenance: w.provenance,
        spec: w.spec,
        profile: w.profile,
        runs: join(w.dir, "rigged"),
      };
    },
  },
  {
    tool: "look_dev",
    script: async () => LOOKDEV_SCRIPT,
    prepare: async (rigged) => {
      // The model the rig row's tool call made.
      const dir = join(work, "quadruped");
      const [candidate] = rigged["candidates"] as { file: string; provenance: unknown }[];
      const provenance = join(dir, "rigged.provenance.json");
      await writeFile(provenance, JSON.stringify(candidate!.provenance));
      return {
        model: join(rigged["runDir"] as string, candidate!.file),
        provenance,
        spec: join(dir, "spec.json"),
        bible: join(dir, "bible.json"),
        profile: join(dir, "profile.json"),
        runs: join(dir, "runs"),
      };
    },
  },
  { tool: "lod", prepare: lodWorld },
  {
    tool: "materials",
    // Fake-only renderer: it copies the albedo; the lit checks come from the scripted vision.
    script: () =>
      moduleScript(
        "materials-provider.mjs",
        `export default { image() { throw new Error("unexpected model generation"); }, vision() { return { text: JSON.stringify({ checks: ["flat-albedo", "normal-orientation", "emissive-placement", "dusk-rain", "night"].map((check) => ({ check, passed: true, reason: "synthetic fixture" })) }) }; } };`,
      ),
    prepare: async () => {
      const dir = join(work, "materials");
      await mkdir(dir, { recursive: true });
      const renderer = join(dir, "render.mjs");
      await writeFile(
        renderer,
        "import { copyFileSync } from 'node:fs'; copyFileSync(process.argv[2], process.argv[3]);",
      );
      const raster = createRaster(8, 8);
      for (let y = 1; y < 7; y++)
        for (let x = 1; x < 7; x++) setPixel(raster, x, y, [100, 100, 100, 255]);
      const albedo = join(dir, "albedo.png");
      await writeFile(albedo, encodePng(raster));
      await writeFile(
        join(dir, "spec.json"),
        JSON.stringify({
          kind: "still",
          assetId: "synthetic",
          frames: { count: 1, width: 4, height: 4 },
        }),
      );
      await writeFile(
        join(dir, "profile.json"),
        JSON.stringify({
          format: "assetgrove-target-profile/1",
          name: "synthetic",
          license: "MIT",
          frames: { width: 4, height: 4 },
          style: {
            materials: {
              channels: ["height", "normal"],
              scales: [1, 2],
              flickerBound: 0,
              lightRig: {
                "dusk-rain": { direction: [0.5, -0.5, 1], intensity: 0.4 },
                night: { direction: [0, 0, 1], intensity: 0.1 },
              },
              preview: {
                version: "synthetic-copy-1",
                command: [process.execPath, renderer, albedo, "{{output}}"],
              },
            },
          },
        }),
      );
      approveProfile(JSON.parse(await readFile(join(dir, "profile.json"), "utf8")), {
        profileDir: dir,
      });
      await writeFile(
        join(dir, "derivation.json"),
        JSON.stringify({
          maps: {
            height: { method: "mask-extraction", version: "1", path: "albedo.png" },
            normal: { method: "height-derived-normal", version: "1" },
          },
        }),
      );
      return {
        albedo,
        spec: join(dir, "spec.json"),
        profile: join(dir, "profile.json"),
        derivation: join(dir, "derivation.json"),
        out: join(dir, "out"),
      };
    },
  },
  {
    tool: "identity_check",
    script: identityScript,
    prepare: async () => ({ bible: (await identityWorld()).bible }),
  },
  {
    tool: "identity_eval",
    script: identityScript,
    prepare: async () => {
      const { dir, bible } = await identityWorld();
      const cases = [
        { image: "sheet.png", subject: "bram", same: true, qa: true },
        { image: "sheet.png", subject: "bram", same: true, qa: false },
      ];
      await writeFile(join(dir, "cases.json"), JSON.stringify(cases));
      return { bible, cases: join(dir, "cases.json"), log: join(dir, "eval.jsonl") };
    },
  },
  {
    tool: "animation_qa",
    prepare: async () => {
      const w = await stripWorld();
      return {
        strip: w.strip,
        family: "walk-right",
        profile: w.profile,
        out: join(w.dir, "qa"),
        noVision: true,
      };
    },
    // Frame 3 floats above the ground line: QA names it, which is the command's own result.
    exitCode: 5,
  },
  {
    tool: "fix_frame",
    script: async () => ANIMATION_SCRIPT,
    prepare: async () => {
      const w = join(work, "strip");
      return {
        strip: join(w, "walk-right.png"),
        family: "walk-right",
        profile: join(w, "profile.json"),
        frame: 3,
        from: 2,
        out: join(w, "fixed"),
      };
    },
  },
  {
    tool: "recipe",
    prepare: async () => {
      const dir = join(work, "recipe");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "hero.png"), encodePng(drawSubject(48)));
      await writeFile(
        join(dir, "recipe.json"),
        JSON.stringify({
          format: "assetgrove-recipe/1",
          steps: [
            { op: "trim" },
            { op: "pad", params: { top: 2, right: 2, bottom: 2, left: 2 } },
            { op: "renditions", params: { scales: [1, 2] } },
          ],
        }),
      );
      return {
        recipe: join(dir, "recipe.json"),
        inputs: [join(dir, "hero.png")],
        out: join(dir, "out"),
      };
    },
  },
  ...["library_check", "library_rebuild", "library_stats", "library_drift"].map((tool) => ({
    tool,
    prepare: async (): Promise<Args> => {
      const profile = join(work, "library-profile.json");
      await writeFile(profile, JSON.stringify(syntheticProfile()));
      return { target: join(work, "target"), profile };
    },
  })),
  // The picked asset's file, edited by hand, adopted with the handed-off version as the original.
  {
    tool: "library_adopt",
    prepare: async (): Promise<Args> => {
      const profile = join(work, "library-profile.json");
      await writeFile(profile, JSON.stringify(syntheticProfile()));
      const target = join(work, "target");
      // The run that made the asset, in the project's runs directory, where adopt reads it.
      const record = await readFile(join(target, "assets/source/fern/fern-shelter.review.json"));
      const run = /"run":"([^"]+)"/.exec(record.toString("utf8"))![1]!;
      await cp(join(paths.world(), "runs", run), join(target, ".assetgrove/runs", run), {
        recursive: true,
      });
      const media = join(target, "assets/source/fern/shelter.png");
      const original = join(work, "original.png");
      await cp(media, original);
      const edited = decodeImage(new Uint8Array(await readFile(media)));
      edited.data[3] = 255 - edited.data[3]!;
      await writeFile(media, encodePng(edited));
      return { target, profile, asset: "fern-shelter", original };
    },
    // Headless settings never adopt (design section 3.3): exit 8 and nothing written.
    exitCode: 8,
  },
  { tool: "settings", prepare: async () => ({ action: "path" }) },
  // Headless settings: the change exits 8 confirmation_required and writes nothing.
  { tool: "settings_change", prepare: async () => ({ runUsd: 4 }), exitCode: 8 },
  { tool: "extensions", prepare: async () => ({}) },
  { tool: "spend", prepare: async () => ({ action: "status", workItem: "mcp-row" }) },
  { tool: "spend_reconcile", prepare: async () => ({}) },
  { tool: "disclosure", prepare: async () => ({ root: work }) },
  {
    tool: "migrate",
    prepare: async () => {
      const file = join(work, "unversioned-profile.json");
      await writeFile(file, JSON.stringify({ name: "x", license: "MIT" }));
      return { file, kind: "target-profile" };
    },
  },
];

test("every tool's structuredContent deep-equals the CLI --json document", async () => {
  const covered = new Set(rows.map((r) => r.tool));
  // The search-only tools are compared in test/search-commands.test.ts, with a slot loaded.
  for (const c of commands)
    if (c.tool !== null && c.requires !== "search") assert.ok(covered.has(c.tool), c.tool);
  // One server per scripted provider; the shared one serves every row that names none.
  const servers = new Map<string, Client>([[script, server]]);
  let previous: Doc = {};
  for (const row of rows) {
    const provider = row.script ? await row.script() : script;
    if (!servers.has(provider))
      servers.set(provider, await connect(["--provider-script", provider]));
    const listed = settingsText();
    const args = await row.prepare(previous);
    // The server loads the settings once: a command the row approved (headless settings list it)
    // reaches the tool through a fresh server.
    if (settingsText() !== listed)
      servers.set(provider, await connect(["--provider-script", provider]));
    // A paid row runs under the work directory, which is restored between the command and the
    // tool, so neither returns a finished run another test left in the default runs directory.
    const command = spec(row.tool);
    if (command.plan !== undefined && "runs" in command.input.properties && !("runs" in args))
      args["runs"] = join(work, ".runs");
    const label = `${row.tool} ${JSON.stringify(args)}`;
    // The command and the tool start from the same files: the work directory is restored between.
    const snapshot = `${work}.snapshot`;
    await rm(snapshot, { recursive: true, force: true });
    await cp(work, snapshot, { recursive: true });
    const ran = await cli(commandLine(spec(row.tool), args, provider));
    const document = JSON.parse(ran.stdout) as Doc;
    // A paid run's directory may sit outside the work directory (the default runs directory):
    // it goes too, or the tool would return the command's finished run (reused) instead.
    const removeRun = async (doc: Doc) => {
      const runDir = doc["runDir"];
      if (
        typeof runDir === "string" &&
        !runDir.startsWith(`${work}${sep}`) &&
        /[\\/]r-[0-9a-f]{16}$/.test(runDir)
      )
        await rm(runDir, { recursive: true, force: true });
    };
    await removeRun(document);
    await rm(work, { recursive: true, force: true });
    await cp(snapshot, work, { recursive: true });
    await rm(snapshot, { recursive: true, force: true });
    const result = await servers.get(provider)!.callTool({ name: row.tool, arguments: args });
    await removeRun(result.structuredContent as Doc);
    assert.equal(ran.code, row.exitCode ?? 0, `${label}: ${ran.stderr}`);
    // The document carries the command's own result fields, not only a refusal.
    const fields = Object.keys(document).filter(
      (k) => !["ok", "exitCode", "command", "error"].includes(k),
    );
    assert.ok(fields.length > 0, `${label}: no result fields`);
    assert.equal(result.isError, document["ok"] !== true, label);
    if (row.tool === "cat") {
      // cat carries the read once: the document lists each content's uri and mimeType, and the
      // contents follow as image content or embedded resources, in order.
      const contents = document["contents"] as Array<{ uri: string; mimeType: string }>;
      const listed = contents.map(({ uri, mimeType }) => ({ uri, mimeType }));
      assert.deepEqual(
        normalise(result.structuredContent),
        normalise({ ...document, contents: listed }),
        label,
      );
      const items = (result.content as Array<Doc>).slice(1);
      const carried = items.map((item, i) =>
        item["type"] === "image" ? { ...listed[i], blob: item["data"] } : item["resource"],
      );
      assert.deepEqual(carried, contents, label);
    } else {
      assert.deepEqual(normalise(result.structuredContent), normalise(document), label);
    }
    const [text] = result.content as { type: string; text: string }[];
    assert.deepEqual(JSON.parse(text!.text), result.structuredContent, label);
    previous = result.structuredContent as Doc;
  }
});

async function settingsFile(settings: Doc): Promise<string> {
  const dir = await tempDir("assetgrove-mcp-settings-");
  const path = join(dir, "settings.json");
  await writeFile(path, JSON.stringify({ format: "assetgrove-settings/1", ...settings }));
  return path;
}

const MARK = "anthropic/requiresUserInteraction";

test("the requiresUserInteraction mark follows confirm, and headless settings lift it from spend, pick and write tools", async () => {
  const confirmKinds = commands.filter((c) => c.tool !== null && c.confirm !== undefined);
  assert.ok(confirmKinds.some((c) => c.confirm === "spend"));
  assert.ok(confirmKinds.some((c) => c.confirm === "pick"));
  assert.ok(confirmKinds.some((c) => c.confirm === "write"));

  const attended = await connect([], childEnv({ ASSETGROVE_CONFIG: await settingsFile({}) }));
  for (const tool of (await attended.listTools()).tools) {
    const command = spec(tool.name);
    assert.equal(tool._meta?.[MARK] === true, command.confirm !== undefined, tool.name);
  }

  const headless = await connect(
    [],
    childEnv({ ASSETGROVE_CONFIG: await settingsFile({ headless: { operator: "ci:example" } }) }),
  );
  for (const tool of (await headless.listTools()).tools) {
    const command = spec(tool.name);
    if (command.confirm === "spend" || command.confirm === "pick" || command.confirm === "write")
      assert.equal(tool._meta?.[MARK], undefined, tool.name);
    else assert.equal(tool._meta?.[MARK] === true, command.confirm !== undefined, tool.name);
  }
});
