import "./fixtures/env.ts";
import { approve, approveCommand, approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { commandIdentity } from "../src/approvals.ts";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import { targetCommand } from "../src/material/engine.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

/** A still with a copying preview and a fake-only KTX2 compressor (a structural fixture). */
async function materialFiles() {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-material-approvals-"));
  await writeFile(
    join(dir, "render.mjs"),
    `import {copyFileSync} from 'node:fs'; copyFileSync(process.argv[2],process.argv[3]);`,
  );
  await writeFile(
    join(dir, "compressor.mjs"),
    `import {readFile,writeFile} from 'node:fs/promises'; const [input,out]=process.argv.slice(2);const png=await readFile(input);const b=Buffer.alloc(133);Buffer.from([171,75,84,88,32,50,48,187,13,10,26,10]).copy(b);b.writeUInt32LE(1,16);b.writeUInt32LE(png.readUInt32BE(16),20);b.writeUInt32LE(png.readUInt32BE(20),24);b.writeUInt32LE(1,36);b.writeUInt32LE(1,40);b.writeUInt32LE(1,44);b.writeUInt32LE(104,48);b.writeUInt32LE(28,52);b.writeUInt32LE(28,104);b[116]=163;b.writeBigUInt64LE(132n,80);b.writeBigUInt64LE(1n,88);b.writeBigUInt64LE(1n,96);await writeFile(out,b);`,
  );
  const provider = join(dir, "provider.mjs");
  await writeFile(
    provider,
    `export default { image(){throw new Error('unexpected model generation')}, vision(){return {text:JSON.stringify({checks:['flat-albedo','normal-orientation','emissive-placement','dusk-rain','night'].map(check=>({check,passed:true,reason:'synthetic fixture'}))})}} };`,
  );
  approve(provider);
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
  const compression = ["node", "compressor.mjs", "{{input}}", "{{output}}"].map((arg) =>
    arg === "node" ? process.execPath : arg,
  );
  const preview = [process.execPath, "render.mjs", albedo, "{{output}}"];
  const profile = {
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
        compression: { version: "fake-ktx2-container", command: compression },
        preview: { version: "synthetic-copy-1", command: preview },
      },
    },
  };
  await writeFile(join(dir, "profile.json"), JSON.stringify(profile));
  await writeFile(
    join(dir, "derivation.json"),
    JSON.stringify({
      maps: {
        height: { method: "mask-extraction", version: "1", path: "albedo.png" },
        normal: { method: "height-derived-normal", version: "1" },
      },
    }),
  );
  const out = join(dir, "out");
  const run = () =>
    cli(
      "materials",
      "--albedo",
      albedo,
      "--spec",
      join(dir, "spec.json"),
      "--profile",
      join(dir, "profile.json"),
      "--derivation",
      join(dir, "derivation.json"),
      "--out",
      out,
      "--provider-script",
      provider,
      "--digital-source-type",
      "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation",
      "--json",
    );
  return { dir, out, profile, compression, preview, run };
}

test("an unapproved compression command exits 8; with its hash in settings it runs and provenance records the approval", async () => {
  const f = await materialFiles();
  // The preview is approved; the compression command is not.
  approve({ kind: "material-preview", argv: f.preview, cwd: f.dir });
  const refused = await f.run();
  assert.equal(refused.code, 8, refused.stderr);
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, "confirmation_required");
  const identity = commandIdentity("material-compression", f.compression, f.dir);
  assert.equal(error.confirmation.id, identity.hash);
  assert.equal(error.confirmation.command.kind, "material-compression");
  assert.deepEqual(error.confirmation.command.argv, f.compression);
  assert.deepEqual(Object.keys(error.confirmation.command.files), ["compressor.mjs"]);
  // Refused before any map, rendition or report was written.
  assert.equal(existsSync(join(f.out, "materials.json")), false);
  assert.equal(existsSync(join(f.out, "albedo@1x.png")), false);

  approveCommand({ hash: identity.hash, kind: identity.kind, argv: identity.argv });
  const ran = await f.run();
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  const p = JSON.parse(await readFile(join(f.out, "normal@1x.ktx2.provenance.json"), "utf8"));
  assert.equal(p.compression.hash, identity.hash);
  assert.equal(p.compression.method, "settings");
  const preview = commandIdentity("material-preview", f.preview, f.dir);
  assert.deepEqual(p.commands, [
    { kind: "material-compression", hash: identity.hash, method: "settings" },
    // approve() also lists its commands in the fixture's (headless) settings.
    { kind: "material-preview", hash: preview.hash, method: "settings" },
  ]);
  const report = JSON.parse(await readFile(join(f.out, "materials.json"), "utf8"));
  assert.ok(
    report.commandResults.some(
      (r: { approval?: { hash: string } }) => r.approval?.hash === identity.hash,
    ),
  );
  // A changed compressor is another command, and needs its own approval.
  await writeFile(join(f.dir, "compressor.mjs"), "process.exit(1);\n");
  const changed = await f.run();
  assert.equal(changed.code, 8, changed.stderr);
});

test("an unapproved preview command exits 8, and approveProfile approves both commands", async () => {
  const f = await materialFiles();
  const refused = await f.run();
  assert.equal(refused.code, 8);
  assert.equal(JSON.parse(refused.stdout).error.code, "confirmation_required");
  approveProfile(f.profile, { profileDir: f.dir });
  const ran = await f.run();
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
});

test("ops --json does not list material-encode, and a recipe naming it exits 2", async () => {
  const ops = await cli("ops", "--json");
  assert.equal(ops.code, 0);
  const listed = JSON.parse(ops.stdout) as { operations: { name: string }[] };
  const names = listed.operations.map((o) => o.name);
  assert.ok(names.includes("material-rendition"));
  assert.equal(names.includes("material-encode"), false);
  assert.equal(ops.stdout.includes("material-encode"), false);

  const dir = await mkdtemp(join(tmpdir(), "assetgrove-material-encode-"));
  const input = join(dir, "in.png");
  await writeFile(input, encodePng(createRaster(2, 2)));
  const recipe = join(dir, "recipe.json");
  await writeFile(
    recipe,
    JSON.stringify({
      format: "assetgrove-recipe/1",
      steps: [
        {
          op: "material-encode",
          params: { command: ["x"], version: "1", input: "a", output: "b", cwd: "." },
        },
      ],
    }),
  );
  const r = await cli("recipe", recipe, input, "--out", join(dir, "out"), "--json");
  assert.equal(r.code, 2, r.stdout);
  assert.equal(JSON.parse(r.stdout).error.code, "invalid_input");
  assert.match(JSON.parse(r.stdout).error.message, /material-encode/);
});

test("a material command runs without any key variable, and its output and failure are redacted", async () => {
  const gateway = ["AI", "GATEWAY", "API", "KEY"].join("_");
  const value = `vck-${"0123456789abcdef".split("").reverse().join("")}-synthetic`;
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-material-env-"));
  await writeFile(join(dir, "leak.txt"), value);
  const print = `process.stdout.write("gateway=" + process.env.${gateway} + " file=" + require("fs").readFileSync("leak.txt", "utf8"))`;
  const saved = process.env[gateway];
  process.env[gateway] = value;
  try {
    const ran = await targetCommand([process.execPath, "-e", print], {}, dir);
    assert.equal(ran.stdout, `gateway=undefined file=[redacted:${gateway}]`);
    const fail = `process.stderr.write(require("fs").readFileSync("leak.txt", "utf8")); process.exit(3)`;
    const error = await targetCommand([process.execPath, "-e", fail], {}, dir).then(
      () => assert.fail("the command should fail"),
      (e: Error & { commandRecord: { stderr: string } }) => e,
    );
    assert.equal(error.commandRecord.stderr, `[redacted:${gateway}]`);
    assert.ok(!error.message.includes(value), "the failure message holds the key value");
  } finally {
    if (saved === undefined) delete process.env[gateway];
    else process.env[gateway] = saved;
  }
});
