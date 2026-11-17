import "./fixtures/env.ts";
import { approveProfile, ledgerPath } from "./fixtures/env.ts";
import { approve } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { compareRasters } from "../src/compare.ts";
import { createRaster, decodePng, encodePng, setPixel } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { packageBlocklist } from "../src/policy/blocklist.ts";
import { parseRegion } from "../src/regions.ts";
import { shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(passingScript);

const temporary: string[] = [];
after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], cwd = root): Promise<Result> {
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [join(root, "src/cli.ts"), ...args],
      { cwd, env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ code: error ? ((error.code as unknown as number) ?? null) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = (r: Result): Record<string, any> => JSON.parse(r.stdout);

function flat(w: number, h: number, rgb = [90, 120, 160]): Raster {
  const r = createRaster(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(r, x, y, [...rgb, 255]);
  return r;
}

function paint(r: Raster, x0: number, y0: number, w: number, h: number): Raster {
  const out = { ...r, data: new Uint8Array(r.data) };
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) setPixel(out, x, y, [250, 10, 10, 255]);
  return out;
}

test("region text parses pixel and percent boxes, mask, frame, view and ref", async () => {
  const dir = await tempDir("assetgrove-region-");
  const px = parseRegion("10,20,30,40 : tail darker", { base: dir });
  assert.deepEqual(px.shape, { kind: "box", unit: "px", x: 10, y: 20, width: 30, height: 40 });
  assert.equal(px.note, "tail darker");
  const pct = parseRegion("25%,10%,12.5%,12.5% frame 3 : paws: bigger", { base: dir });
  assert.deepEqual(pct.shape, {
    kind: "box",
    unit: "percent",
    x: 25,
    y: 10,
    width: 12.5,
    height: 12.5,
  });
  assert.equal(pct.frame, 3);
  assert.equal(pct.note, "paws: bigger");
  const mask = parseRegion("mask=m.png view 2 ref a.png ref b.png : redo", { base: dir });
  assert.deepEqual(mask.shape, { kind: "mask", path: join(dir, "m.png") });
  assert.equal(mask.view, 2);
  assert.deepEqual(mask.refs, [join(dir, "a.png"), join(dir, "b.png")]);
});

test("a malformed region or a path outside the project root is invalid input", async () => {
  const dir = await tempDir("assetgrove-region-bad-");
  for (const text of [
    "1,2,3 : x",
    "1,2,3,4",
    "10%,2,3,4 : x",
    "1,2,3,4 frame 0 : x",
    "1,2,3,4 frame 1 view 1 : x",
    "1,2,3,4 ref : x",
    "1,2,3,4 spin 3 : x",
    "mask= : x",
    "0,0,0,4 : x",
    ": x",
  ])
    assert.throws(() => parseRegion(text, { base: dir }), /malformed region/, text);
  assert.throws(
    () => parseRegion("mask=/etc/passwd : x", { base: dir }),
    /outside the project root/,
  );
  assert.throws(
    () => parseRegion("1,2,3,4 ref ../../x.png : x", { base: dir }),
    /outside the project root/,
  );
});

test("a change inside the box has outsideChange 0; a change outside raises the advisory reason", async () => {
  const before = flat(40, 40);
  const region = parseRegion("10,10,10,10 : x", { requireNote: true, base: process.cwd() });
  const inside = await compareRasters(before, paint(before, 12, 12, 4, 4), [region]);
  assert.equal(inside.outsideChange, 0);
  assert.deepEqual(inside.reasons, []);
  const outside = await compareRasters(before, paint(before, 0, 0, 20, 8), [region]);
  assert.ok(outside.outsideChange > 0.05);
  assert.equal(outside.reasons[0]?.check, "changed_outside_region");
  const same = await compareRasters(before, before, [region]);
  assert.equal(same.identical, true);
  assert.ok(same.difference.data.every((v, i) => i % 4 === 3 || v === 0));
});

test("outsideChange is a share of the figure: a small figure repainted outside the region is reported", async () => {
  // A 100 x 100 transparent render whose figure (20 x 20 = 4% of the canvas) is repainted whole,
  // outside the region: over the canvas that is 4%, below the 0.05 limit, and was never reported.
  const before = createRaster(100, 100);
  for (let y = 40; y < 60; y++)
    for (let x = 40; x < 60; x++) setPixel(before, x, y, [90, 120, 160, 255]);
  const candidate = paint(before, 40, 40, 20, 20);
  const region = parseRegion("0,0,10,10 : x", { requireNote: true, base: process.cwd() });
  const result = await compareRasters(before, candidate, [region]);
  assert.equal(result.changed, 0.04);
  assert.equal(result.outsideChange, 1);
  assert.equal(result.reasons[0]?.check, "changed_outside_region");
  assert.match(result.reasons[0]?.reason ?? "", /100\.0% of the figure's pixels/);
  // Colour kept under alpha 0 changing is not a visible change: those pixels are not the figure.
  const hidden = { ...before, data: new Uint8Array(before.data) };
  for (let y = 0; y < 30; y++) for (let x = 0; x < 100; x++) setPixel(hidden, x, y, [255, 0, 0, 0]);
  const quiet = await compareRasters(before, hidden, [region]);
  assert.equal(quiet.outsideChange, 0);
  assert.deepEqual(quiet.reasons, []);
  // An opaque image's figure is the whole canvas, as before.
  const opaque = flat(40, 40);
  const small = await compareRasters(opaque, paint(opaque, 30, 30, 2, 2), [region]);
  assert.equal(small.outsideChange, 4 / 1600);
});

test("compare writes a sheet, names a strip frame, and refuses bad regions with exit 2", async () => {
  const dir = await tempDir("assetgrove-compare-");
  const before = flat(24, 12);
  const after = paint(before, 14, 2, 4, 4);
  await writeFile(join(dir, "before.png"), encodePng(before));
  await writeFile(join(dir, "after.png"), encodePng(after));
  const out = join(dir, "out");
  const run = await cli(
    [
      ...["compare", "before.png", "after.png", "--out", out],
      ...["--region", "0,0,12,12 : x"],
      ...["--frame", "2", "--json"],
    ],
    dir,
  );
  assert.equal(run.code, 0, run.stderr + run.stdout);
  const d = doc(run);
  assert.equal(d.rows[0].outsideChange, 0);
  assert.equal(d.rows[0].identical, false);
  const sheet = decodePng(new Uint8Array(await readFile(join(out, "compare.png"))));
  // Region outlines are drawn on all three cells (before, candidate, difference map).
  const reds = outlinePixels(sheet);
  assert.ok(reds.length > 0);
  const thirds = new Set(reds.map((x) => Math.floor((x * 3) / sheet.width)));
  assert.deepEqual([...thirds].sort(), [0, 1, 2]);
  // Only the region text's note differs: the sheet is byte-identical.
  const other = await cli(
    [
      ...["compare", "before.png", "after.png", "--out", join(dir, "out2")],
      ...["--region", "0,0,12,12 : something else entirely"],
      ...["--frame", "2", "--json"],
    ],
    dir,
  );
  assert.equal(other.code, 0, other.stderr + other.stdout);
  const bytes = await readFile(join(out, "compare.png"));
  assert.ok(bytes.equals(await readFile(join(dir, "out2", "compare.png"))));
  // Without a region there are no outlines.
  const bare = await cli(
    ["compare", "before.png", "after.png", "--frame", "2", "--out", join(dir, "out3"), "--json"],
    dir,
  );
  assert.equal(bare.code, 0, bare.stderr + bare.stdout);
  assert.equal(
    outlinePixels(decodePng(new Uint8Array(await readFile(join(dir, "out3", "compare.png")))))
      .length,
    0,
  );
  // frame 1 of the strip is unchanged: pixel-identical, difference map black.
  const first = await cli(
    ["compare", "before.png", "after.png", "--frame", "1", "--out", out, "--json"],
    dir,
  );
  assert.equal(doc(first).rows[0].identical, true);
  const bad = await cli(["compare", "before.png", "after.png", "--region", "1,2,3", "--json"], dir);
  assert.equal(bad.code, 2);
  assert.equal(doc(bad).error.code, "invalid_input");
  const outside = await cli(
    ["compare", "before.png", "after.png", "--region", "mask=/etc/hosts : x", "--json"],
    dir,
  );
  assert.equal(outside.code, 2);
});

/** The x of every pixel in the sheet that has the outline colour. */
function outlinePixels(sheet: Raster): number[] {
  const xs: number[] = [];
  for (let i = 0; i < sheet.width * sheet.height; i++)
    if (sheet.data[i * 4] === 230 && sheet.data[i * 4 + 1] === 40 && sheet.data[i * 4 + 2] === 40)
      xs.push(i % sheet.width);
  return xs;
}

const stillSpec = {
  kind: "still",
  assetId: "fern",
  fields: { description: "a round icon" },
};

async function stageWorld(kind: "still" | "strip" = "strip") {
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  await writeFile(spec, JSON.stringify(kind === "still" ? stillSpec : shelterSpec));
  await writeFile(bible, JSON.stringify(world.bible));
  await writeFile(profile, JSON.stringify(world.profile));
  approveProfile(world.profile, { targetDir: world.targetDir });
  const flags = ["--spec", spec, "--bible", bible, "--profile", profile, "--runs", world.runsDir];
  return { world, flags };
}

async function countingScript(dir: string) {
  const script = join(dir, "counting.mjs");
  const events = join(dir, "counting.events");
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
import base from ${JSON.stringify(pathToFileURL(passingScript).href)};
export default {
  paid: true,
  image: (r, i) => (appendFileSync(${JSON.stringify(events)}, "image\\n"), base.image(r, i)),
  vision: (r, i) => base.vision(r, i),
  promptPolicy: () => ({ answer: { type: "boolean", probability: 0 } }),
};`,
  );
  approve(script);
  const count = async () =>
    existsSync(events) ? (await readFile(events, "utf8")).split("\n").filter(Boolean).length : 0;
  return { script, count };
}

test("vary makes variations of one candidate with a contact and a compare sheet; a repeat is reused", async () => {
  const { world, flags } = await stageWorld("still");
  const provider = await countingScript(world.dir);
  const staged = await cli([
    "stage",
    ...flags,
    "--candidates",
    "1",
    "--provider-script",
    provider.script,
    "--json",
  ]);
  assert.equal(staged.code, 0, staged.stderr + staged.stdout);
  const sourceRun = doc(staged).runDir as string;
  const afterStage = await provider.count();
  const vary = [
    "vary",
    "--run",
    sourceRun,
    "--candidate",
    "c1",
    "--count",
    "2",
    "--runs",
    join(world.dir, "vary-runs"),
    "--provider-script",
    provider.script,
  ];
  const dry = await cli([...vary, "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stderr + dry.stdout);
  assert.equal(doc(dry).jobs.find((j: { operation: string }) => j.operation === "edit").count, 2);
  assert.equal(await provider.count(), afterStage, "a dry run makes no call");
  const first = await cli([...vary, "--json"]);
  assert.equal(first.code, 0, first.stderr + first.stdout);
  const d = doc(first);
  assert.equal(d.reused, false);
  assert.equal(d.variations.length, 2);
  assert.equal(await provider.count(), afterStage + 2);
  for (const file of ["contact.png", "compare.png", "v1.png", "v2.png", "v1.provenance.json"])
    assert.ok(existsSync(join(d.runDir, file)), file);
  assert.equal(typeof d.variations[0].outsideChange, "number");
  const ledger = await readFile(ledgerPath, "utf8");
  const again = await cli([...vary, "--json"]);
  assert.equal(doc(again).reused, true);
  assert.equal(await provider.count(), afterStage + 2, "no provider call");
  assert.equal(await readFile(ledgerPath, "utf8"), ledger);
  // Another round is another run directory, so its seeds are fresh.
  const round2 = doc(await cli([...vary, "--round", "2", "--json"]));
  assert.notEqual(round2.runDir, d.runDir);
  const seedOf = async (dir: string) =>
    JSON.parse(await readFile(join(dir, "v1.provenance.json"), "utf8")).seed;
  assert.notEqual(await seedOf(round2.runDir), await seedOf(d.runDir));
});

test("vary refuses a sprite-strip candidate", async () => {
  const { world, flags } = await stageWorld();
  const provider = await countingScript(world.dir);
  const staged = await cli([
    "stage",
    ...flags,
    "--candidates",
    "1",
    "--provider-script",
    provider.script,
    "--json",
  ]);
  assert.equal(staged.code, 0, staged.stderr + staged.stdout);
  const before = await provider.count();
  const refused = await cli([
    ...["vary", "--run", doc(staged).runDir, "--candidate", "c1", "--count", "1"],
    ...["--runs", join(world.dir, "vary-runs"), "--provider-script", provider.script, "--json"],
  ]);
  assert.equal(refused.code, 2, refused.stdout + refused.stderr);
  assert.equal(await provider.count(), before);
});

test("a stage note changes the digest and a blocklisted note exits 9 before spend", async () => {
  const { world, flags } = await stageWorld();
  const provider = await countingScript(world.dir);
  const base = [
    ...flags,
    "--candidates",
    "1",
    "--provider-script",
    provider.script,
    "--dry-run",
    "--json",
  ];
  const plain = doc(await cli(["stage", ...base]));
  const noted = doc(await cli(["stage", ...base, "--note", "warmer light", "--round", "2"]));
  assert.notEqual(plain.digest, noted.digest);
  assert.equal(noted.options.note, "warmer light");
  const term = packageBlocklist().terms.find(
    (t) => t.kind === "artist" && t.term.includes(" "),
  )!.term;
  const refused = await cli(["stage", ...base, "--note", `in the style of ${term}`]);
  assert.equal(refused.code, 9, refused.stdout + refused.stderr);
  assert.equal(await provider.count(), 0);
  // The same refusal without --dry-run, which would otherwise spend.
  const live = base.filter((a) => a !== "--dry-run");
  const spent = await cli(["stage", ...live, "--note", `in the style of ${term}`]);
  assert.equal(spent.code, 9, spent.stdout + spent.stderr);
  assert.equal(doc(spent).error.code, "prompt_refused");
  assert.equal(await provider.count(), 0, "no provider call");
});

test("apply and generate-sheet notes change the digest and a blocklisted note exits 9 before spend", async () => {
  const { world, flags } = await stageWorld();
  const provider = await countingScript(world.dir);
  const planFile = join(world.dir, "plan.json");
  const art = join(world.dir, ".assetgrove/art-direction");
  await mkdir(art, { recursive: true });
  await mkdir(join(world.dir, ".assetgrove/prompts"), { recursive: true });
  const data = structuredClone(BIBLE_PRESETS["flat-cartoon-kids"]!);
  data.referenceLicense = "NOASSERTION";
  data.world = "Synthetic Grove";
  const md = join(art, "BIBLE.md");
  await writeFile(md, serializeBible(data, "## Do's and Don'ts\nDo keep silhouettes readable.\n"));
  await writeFile(
    join(world.dir, ".assetgrove/prompts/default.md"),
    "---\nversion: 1\n---\nCreate original art.\n{{constitution}}\n{{spec}}\n{{brief}}\n",
  );
  const stillFile = join(world.dir, "still.json");
  await writeFile(stillFile, JSON.stringify(stillSpec));
  const optionsFile = join(world.dir, "run-options.json");
  await writeFile(optionsFile, JSON.stringify({ candidates: 1 }));
  const made = await cli([
    ...["plan", "--spec", stillFile, "--bible", md, "--profile", flags[5]!],
    ...["--run-options", optionsFile, "--out", planFile, "--runs", join(world.dir, "plan-runs")],
    "--json",
  ]);
  assert.equal(made.code, 0, made.stderr + made.stdout);
  const term = packageBlocklist().terms.find(
    (t) => t.kind === "artist" && t.term.includes(" "),
  )!.term;
  const runs = join(world.dir, "apply-runs");
  const apply = ["apply", planFile, "--out", runs, "--provider-script", provider.script];
  const plain = doc(await cli([...apply, "--dry-run", "--json"]));
  const noted = doc(
    await cli([...apply, "--note", "warmer light", "--round", "2", "--dry-run", "--json"]),
  );
  assert.notEqual(plain.digest, noted.digest);
  const sheet = [
    ...["generate-sheet", ...flags.slice(0, 6), "--runs", join(world.dir, "sheet-runs")],
    ...["--provider-script", provider.script],
  ];
  const sheetPlain = doc(await cli([...sheet, "--dry-run", "--json"]));
  const sheetNoted = doc(
    await cli([...sheet, "--note", "warmer light", "--round", "2", "--dry-run", "--json"]),
  );
  assert.notEqual(sheetPlain.digest, sheetNoted.digest);
  for (const argv of [apply, sheet]) {
    const refused = await cli([...argv, "--note", `in the style of ${term}`, "--json"]);
    assert.equal(refused.code, 9, refused.stdout + refused.stderr);
    assert.equal(doc(refused).error.code, "prompt_refused");
  }
  assert.equal(await provider.count(), 0, "no provider call");
});

test("stage with a note puts it in the prompt of each candidate", async () => {
  const { world, flags } = await stageWorld();
  const provider = await countingScript(world.dir);
  const run = await cli([
    "stage",
    ...flags,
    "--candidates",
    "1",
    "--note",
    "tail tip darker",
    "--provider-script",
    provider.script,
    "--json",
  ]);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  const candidate = doc(run).candidates[0];
  assert.match(candidate.provenance.prompt, /Author's note: tail tip darker/);
});

test("compare names a 3D asset's view from its turntable renders", async () => {
  const dir = await tempDir("assetgrove-compare-3d-");
  for (const [name, shade] of [
    ["a", [90, 120, 160]],
    ["b", [91, 120, 160]],
  ] as const) {
    const views = join(dir, `${name}-character-3d`);
    await mkdir(views, { recursive: true });
    await writeFile(join(views, "view-1.png"), encodePng(flat(16, 16)));
    await writeFile(join(views, "view-2.png"), encodePng(flat(16, 16, [...shade])));
    await writeFile(join(dir, `${name}.glb`), "glb");
  }
  await writeFile(join(dir, "b-character-3d", "view-2.png"), encodePng(flat(16, 16, [200, 0, 0])));
  const view = (n: string) =>
    cli(["compare", "a.glb", "b.glb", "--view", n, "--out", join(dir, "out"), "--json"], dir);
  assert.equal(doc(await view("1")).rows[0].identical, true);
  assert.equal(doc(await view("2")).rows[0].identical, false);
  assert.equal((await view("9")).code, 2);
});
