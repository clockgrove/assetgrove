import "./fixtures/env.ts";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { after, test } from "node:test";
import { planDelivery } from "../src/delivery.ts";
import { encodePng } from "../src/image/raster.ts";
import { lfsObjectPath } from "../src/library/lfs.ts";
import { appendVersion, emptyReview, parseReview, writeReview } from "../src/library/review.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType } from "../src/metadata.ts";
import { sha256Hex } from "../src/library/canonical.ts";
import { gitTarget } from "./fixtures/git.ts";
import { drawSubject } from "./fixtures/synthetic.ts";

const image = (n: number) =>
  embedDigitalSourceType(
    encodePng(drawSubject(16, n)),
    "image/png",
    DIGITAL_SOURCE_TYPES.generated,
  );

const temporary: string[] = [];
after(async () => {
  await Promise.all(temporary.map((d) => rm(d, { recursive: true, force: true })));
});

interface Fixture {
  dir: string;
  target: string;
  assets: string;
  base: string;
}

async function setup(): Promise<Fixture> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-delivery-test-")));
  temporary.push(dir);
  const target = gitTarget(join(dir, "target"));
  const assets = join(target, "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(
    join(target, "index.md"),
    "---\nokf_version: 0.2\ntype: Asset Library\ngame: test-grove\n---\n\n# test-grove\n",
  );
  const base = join(dir, "project");
  await mkdir(join(base, "recipes"), { recursive: true });
  await writeFile(
    join(base, "recipes", "icon.json"),
    JSON.stringify({
      format: "assetgrove-recipe/1",
      steps: [{ op: "scale", params: { factor: 2 } }],
    }),
  );
  await writeFile(
    join(base, "recipes", "mirror.json"),
    JSON.stringify({ format: "assetgrove-recipe/1", steps: [{ op: "flip", params: {} }] }),
  );
  return { dir, target, assets, base };
}

/** An asset whose current media is the last version; `store` versions also sit in the LFS store. */
async function asset(
  f: Fixture,
  id: string,
  versions: Uint8Array[],
  options: { store?: number[]; pointer?: boolean } = {},
) {
  let record = emptyReview(`asset://test-grove/${id}/review`);
  for (const [i, bytes] of versions.entries())
    record = appendVersion(record, {
      sha256: sha256Hex(bytes),
      at: `2026-01-0${i + 1}T00:00:00Z`,
      run: `r-${id}`,
      candidate: "c1",
      confirmation: { method: "tty" },
    });
  const current = versions.at(-1)!;
  await writeFile(join(f.assets, `${id}.review.json`), writeReview(record));
  const media = options.pointer
    ? `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256Hex(current)}\nsize ${current.length}\n`
    : current;
  await writeFile(join(f.assets, `${id}.png`), media);
  await writeFile(
    join(f.assets, `${id}.md`),
    `---\ntype: Game Asset\nformat: assetgrove-card/1\ntitle: ${id}\nresource: ${id}.png\nversion: ${versions.length}\nlock: { sha256: ${sha256Hex(current)} }\n---\n`,
  );
  const stored = options.pointer ? [versions.length - 1] : (options.store ?? []);
  for (const i of stored) {
    const path = lfsObjectPath(join(f.target, ".git"), sha256Hex(versions[i]!));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, versions[i]!);
  }
}

async function select(f: Fixture, items: Record<string, unknown>[]) {
  const path = join(f.base, "selection.json");
  await writeFile(
    path,
    JSON.stringify({ format: "assetgrove-delivery/1", recipes: "recipes", items }),
  );
  return path;
}

async function files(root: string, rel = ""): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(found, await files(root, path));
    else found[path] = sha256Hex(await readFile(join(root, path)));
  }
  return found;
}

const lantern = (extra: Record<string, unknown> = {}) => ({
  asset: "../target/assets/lantern.md",
  version: 1,
  recipe: "icon",
  to: "icons",
  name: "lantern",
  ...extra,
});

test("a dry run resolves content hashes and destination paths and writes nothing", async () => {
  const f = await setup();
  await asset(f, "lantern", [image(1)]);
  const selection = await select(f, [lantern(), lantern({ recipe: "mirror", to: "flipped" })]);
  const out = join(f.dir, "out");
  const dry = await planDelivery({ selection, out, preview: true });
  assert.deepEqual(dry.problems, []);
  assert.equal(dry.written, false);
  assert.deepEqual(await readdir(f.dir).then((names) => names.includes("out")), false);
  const planned = dry.manifest.items.flatMap((item) => item.outputs);
  assert.equal(planned.length, 2);
  assert.deepEqual(
    planned.map((o) => o.path),
    ["icons/lantern.png", "flipped/lantern.png"],
  );
  const real = await planDelivery({ selection, out });
  assert.equal(real.written, true);
  const onDisk = await files(out);
  for (const output of planned) assert.equal(onDisk[output.path], output.sha256);
  assert.deepEqual(
    Object.keys(onDisk).sort(),
    [...planned.map((o) => o.path), "delivery.json"].sort(),
  );
});

test("a missing object, version, asset and an output collision are reported before any write", async () => {
  const f = await setup();
  await asset(f, "lantern", [image(1), image(2)]);
  const selection = await select(f, [
    lantern({ version: 1 }),
    lantern({ version: 9, name: "other" }),
    lantern({ asset: "../target/assets/nope.md", name: "third" }),
    lantern({ version: 2, name: "same" }),
    lantern({ version: 2, name: "same" }),
  ]);
  const out = join(f.dir, "out");
  const dry = await planDelivery({ selection, out, preview: true });
  const codes = dry.problems.map((p) => `${p.item}:${p.code}`);
  assert.deepEqual(codes, [
    "0:object_missing",
    "1:version_missing",
    "2:asset_missing",
    "4:output_collision",
  ]);
  const refused = await planDelivery({ selection, out });
  assert.equal(refused.written, false);
  assert.deepEqual(refused.problems, dry.problems);
  assert.deepEqual(await files(out), {});

  const solo = await select(f, [lantern({ version: 2 })]);
  await mkdir(join(out, "icons"), { recursive: true });
  await writeFile(join(out, "icons", "lantern.png"), "someone else's file");
  const before = await files(out);
  const clash = await planDelivery({ selection: solo, out });
  assert.deepEqual(
    clash.problems.map((p) => p.code),
    ["output_collision"],
  );
  assert.equal(clash.written, false);
  assert.deepEqual(await files(out), before);
});

test("repeating the same selection gives an identical delivery set linked to mezzanine and recipe", async () => {
  const f = await setup();
  const bytes = image(1);
  await asset(f, "lantern", [bytes]);
  const selection = await select(f, [lantern(), lantern({ recipe: "mirror", to: "flipped" })]);
  const first = await planDelivery({ selection, out: join(f.dir, "one") });
  await planDelivery({ selection, out: join(f.dir, "two") });
  const again = await planDelivery({ selection, out: join(f.dir, "one") });
  assert.deepEqual(again.problems, []);
  const one = await files(join(f.dir, "one"));
  assert.deepEqual(await files(join(f.dir, "two")), one);
  const manifest = JSON.parse(await readFile(join(f.dir, "one", "delivery.json"), "utf8"));
  assert.deepEqual(manifest, JSON.parse(JSON.stringify(first.manifest)));
  assert.equal(manifest.items.length, 2);
  for (const item of manifest.items) {
    assert.equal(item.mezzanine.sha256, sha256Hex(bytes));
    assert.match(item.recipe.sha256, /^[0-9a-f]{64}$/);
    for (const output of item.outputs) assert.equal(one[output.path], output.sha256);
  }
  assert.deepEqual(
    manifest.items.map((i: { recipe: { name: string } }) => i.recipe.name),
    ["icon", "mirror"],
  );
});

test("a previously picked version is delivered without changing the library", async () => {
  const f = await setup();
  const [old, current] = [image(1), image(2)];
  await asset(f, "lantern", [old, current], { store: [0] });
  const watched = ["lantern.review.json", "lantern.md", "lantern.png"].map((n) =>
    join(f.assets, n),
  );
  const before = await Promise.all(watched.map((p) => readFile(p)));
  const selection = await select(f, [
    lantern({ version: 1, name: "old" }),
    lantern({ version: 2, name: "new" }),
  ]);
  const out = join(f.dir, "out");
  const result = await planDelivery({ selection, out });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    result.manifest.items.map((i) => i.mezzanine.sha256),
    [sha256Hex(old), sha256Hex(current)],
  );
  const after = await Promise.all(watched.map((p) => readFile(p)));
  assert.deepEqual(after, before);
  assert.equal(parseReview(after[0]!.toString("utf8"), "review").versions.length, 2);
});

test("current media stored as a Git LFS pointer is delivered from the local object", async () => {
  const f = await setup();
  await asset(f, "lantern", [image(3)], { pointer: true });
  const selection = await select(f, [lantern()]);
  const result = await planDelivery({ selection, out: join(f.dir, "out") });
  assert.deepEqual(result.problems, []);
  assert.equal(result.written, true);
  assert.equal(result.manifest.items[0]!.mezzanine.sha256, sha256Hex(image(3)));
});

test("a destination folder that is a file, or another item's output, is a collision before any write", async () => {
  const f = await setup();
  await asset(f, "lantern", [image(1)]);
  const out = join(f.dir, "out");
  await mkdir(out);
  await writeFile(join(out, "icons"), "a file where a folder must go");
  const blocked = await planDelivery({ selection: await select(f, [lantern()]), out });
  assert.deepEqual(
    blocked.problems.map((p) => p.code),
    ["output_collision"],
  );
  const nested = await select(f, [
    lantern({ to: "nested" }),
    lantern({ recipe: "mirror", to: "nested/lantern.png" }),
  ]);
  const fresh = join(f.dir, "fresh");
  const clash = await planDelivery({ selection: nested, out: fresh });
  assert.deepEqual(
    clash.problems.map((p) => `${p.item}:${p.code}`),
    ["1:output_collision"],
  );
  assert.deepEqual(await files(fresh), {});
});

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function deliverCli(selection: string, out: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const name of REFUSED_VARIABLES) {
    delete env[name];
    delete env[name.toLowerCase()];
  }
  delete env.AI_GATEWAY_API_KEY;
  return exec(
    process.execPath,
    [CLI, "deliver", "--selection", selection, "--out", out, "--preview", "--json"],
    { env },
  ).then(
    (r) => ({ code: 0, stdout: r.stdout }),
    (e: { code: number; stdout: string }) => ({ code: e.code, stdout: e.stdout }),
  );
}

test("the deliver command dry run names destination paths and refuses a missing object before any write", async () => {
  const f = await setup();
  await asset(f, "lantern", [image(1)]);
  await asset(f, "gourd", [image(1), image(2)]);
  const out = join(f.dir, "out");

  const clean = await deliverCli(await select(f, [lantern()]), out);
  assert.equal(clean.code, 0);
  const planned = JSON.parse(clean.stdout);
  assert.equal(planned.preview, true);
  assert.deepEqual(planned.problems, []);
  assert.equal(planned.manifest.items[0].outputs[0].path, "icons/lantern.png");
  assert.equal(existsSync(out), false);

  const selection = await select(f, [
    lantern(),
    lantern({ asset: "../target/assets/gourd.md", version: 1, name: "gourd" }),
  ]);
  const refused = await deliverCli(selection, out);
  assert.equal(refused.code, 2);
  const doc = JSON.parse(refused.stdout);
  assert.equal(doc.error.code, "invalid_input");
  assert.deepEqual(
    doc.problems.map((p: { code: string; item: number }) => `${p.item}:${p.code}`),
    ["1:object_missing"],
  );
  const good = doc.manifest.items[0].outputs[0];
  assert.equal(good.path, "icons/lantern.png");
  assert.match(good.sha256, /^[0-9a-f]{64}$/);
  assert.equal(existsSync(out), false);
});
