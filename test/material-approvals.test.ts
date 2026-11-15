import { approve, approveScript } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function cli(...args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await exec(process.execPath, [CLI, ...args], { timeout: 60_000 });
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code: number; stdout: string };
    return { code: e.code, stdout: e.stdout };
  }
}

/** A still with height and normal maps, a fake KTX2 compressor and a copying preview renderer. */
async function materialWorld() {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-material-approvals-"));
  const renderer = join(dir, "render.mjs");
  await writeFile(
    renderer,
    `import {copyFileSync} from 'node:fs'; copyFileSync(process.argv[2],process.argv[3]);`,
  );
  // Fake-only codec proof: a structural KTX2 container, never an actual Basis encoder.
  const compressor = join(dir, "compressor.mjs");
  await writeFile(
    compressor,
    `import {readFile,writeFile} from 'node:fs/promises'; const [input,out]=process.argv.slice(2);const png=await readFile(input);const b=Buffer.alloc(133);Buffer.from([171,75,84,88,32,50,48,187,13,10,26,10]).copy(b);b.writeUInt32LE(1,16);b.writeUInt32LE(png.readUInt32BE(16),20);b.writeUInt32LE(png.readUInt32BE(20),24);b.writeUInt32LE(1,36);b.writeUInt32LE(1,40);b.writeUInt32LE(1,44);b.writeUInt32LE(104,48);b.writeUInt32LE(28,52);b.writeUInt32LE(28,104);b[116]=163;b.writeBigUInt64LE(132n,80);b.writeBigUInt64LE(1n,88);b.writeBigUInt64LE(1n,96);await writeFile(out,b);`,
  );
  const provider = join(dir, "provider.mjs");
  await writeFile(
    provider,
    `export default { image(){throw new Error('unexpected model generation')}, vision(){return {text:JSON.stringify({checks:['flat-albedo','normal-orientation','emissive-placement','dusk-rain','night'].map(check=>({check,passed:true,reason:'synthetic fixture'}))})}} };`,
  );
  approveScript(provider);
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
  const compression = {
    command: [process.execPath, compressor, "{{input}}", "{{output}}"],
    version: "fake-ktx2-container",
  };
  const preview = {
    version: "synthetic-copy-1",
    command: [process.execPath, renderer, albedo, "{{output}}"],
  };
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
          compression,
          preview,
        },
      },
    }),
  );
  await writeFile(
    join(dir, "derivation.json"),
    JSON.stringify({
      maps: {
        height: { method: "mask-extraction", version: "1", path: "albedo.png" },
        normal: { method: "height-derived-normal", version: "1" },
      },
    }),
  );
  const run = () =>
    cli(
      "materials",
      ...["--albedo", albedo, "--spec", join(dir, "spec.json")],
      ...["--profile", join(dir, "profile.json"), "--derivation", join(dir, "derivation.json")],
      ...["--out", join(dir, "out"), "--provider-script", provider],
      ...["--digital-source-type", "digitalCapture", "--json"],
    );
  return { dir, compression, preview, run };
}

test("an unapproved compression command exits 8; approved in settings it runs and provenance records it", async () => {
  const world = await materialWorld();
  approve({ kind: "material-preview", argv: world.preview.command, cwd: world.dir });
  const refused = await world.run();
  assert.equal(refused.code, 8, refused.stdout);
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, "confirmation_required");
  assert.equal(error.confirmation.command.kind, "material-compression");
  assert.deepEqual(error.confirmation.command.argv, world.compression.command);

  const hash = approve({
    kind: "material-compression",
    argv: world.compression.command,
    cwd: world.dir,
  });
  assert.equal(hash, error.confirmation.id);
  const ran = await world.run();
  assert.equal(ran.code, 0, ran.stdout);
  const doc = JSON.parse(ran.stdout) as { outputs: { path: string; mediaType: string }[] };
  const ktx2 = doc.outputs.filter((o) => o.mediaType === "image/ktx2");
  assert.ok(ktx2.length > 0);
  for (const output of ktx2) {
    const provenance = JSON.parse(await readFile(`${output.path}.provenance.json`, "utf8"));
    assert.equal(provenance.compression.hash, hash);
    assert.equal(provenance.compression.method, "settings");
  }
  const report = JSON.parse(await readFile(join(world.dir, "out", "materials.json"), "utf8"));
  assert.deepEqual(
    report.commands.map((c: { kind: string; method: string }) => [c.kind, c.method]),
    [
      ["material-compression", "settings"],
      ["material-preview", "settings"],
    ],
  );
});

test("an unapproved preview command exits 8 like a validator", async () => {
  const world = await materialWorld();
  approve({ kind: "material-compression", argv: world.compression.command, cwd: world.dir });
  const refused = await world.run();
  assert.equal(refused.code, 8, refused.stdout);
  assert.equal(JSON.parse(refused.stdout).error.confirmation.command.kind, "material-preview");
});

test("ops does not list material-encode, and a recipe naming it exits 2", async () => {
  const ops = await cli("ops", "--json");
  assert.equal(ops.code, 0);
  const names = (JSON.parse(ops.stdout).operations as { name: string }[]).map((o) => o.name);
  assert.ok(names.includes("material-rendition"));
  assert.ok(!names.includes("material-encode"));

  const dir = await mkdtemp(join(tmpdir(), "assetgrove-material-encode-"));
  await writeFile(join(dir, "in.png"), encodePng(createRaster(4, 4)));
  await writeFile(
    join(dir, "recipe.json"),
    JSON.stringify({
      format: "assetgrove-recipe/1",
      steps: [
        {
          op: "material-encode",
          params: { command: ["x"], version: "1", input: "a.png", output: "b.ktx2", cwd: dir },
        },
      ],
    }),
  );
  const run = await cli(
    "recipe",
    join(dir, "recipe.json"),
    join(dir, "in.png"),
    "--out",
    join(dir, "out"),
    "--json",
  );
  assert.equal(run.code, 2, run.stdout);
  assert.equal(JSON.parse(run.stdout).error.code, "invalid_input");
});
