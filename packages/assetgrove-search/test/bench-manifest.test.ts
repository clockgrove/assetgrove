import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fixtureSource, buildFixtureManifest } from "../../../bench/search/fixture.ts";
import { checkManifest, containsStem, readManifest } from "../../../bench/search/manifest.ts";
import { buildManifest, parseInventory } from "../../../bench/search/build-manifest.ts";
import { stratifiedSample, type InventoryImage } from "../../../bench/search/sample.ts";

const fixtureUrl = new URL("../../../bench/search/fixture/manifest.json", import.meta.url);
const realUrl = new URL("../../../bench/search/manifest.json", import.meta.url);

describe("manifest checks", () => {
  it("accepts the committed fixture and keeps it in step with its builder", async () => {
    const fixture = await readManifest(fixtureUrl);
    assert.deepEqual(checkManifest(fixture), []);
    const built = buildFixtureManifest();
    assert.deepEqual(
      fixture.images.map((i) => [i.id, i.sha256, i.file]),
      built.images.map((i) => [i.id, i.sha256, i.file]),
    );
    assert.equal(fixture.images.length, 20);
    for (const i of fixture.images) {
      const bytes = await fixtureSource().bytes(i);
      assert.equal(bytes.length > 0, true);
    }
  });

  it("fails when a label, look query, written query or pair names no image", async () => {
    for (const edit of [
      (m: Awaited<ReturnType<typeof readManifest>>) =>
        m.labels.push({ image: "nope", category: "tiles", pack: "pack-a" }),
      (m: Awaited<ReturnType<typeof readManifest>>) => m.lookQueries.push("nope"),
      (m: Awaited<ReturnType<typeof readManifest>>) =>
        m.writtenQueries.push({ id: "w", text: "x", relevant: ["nope"] }),
      (m: Awaited<ReturnType<typeof readManifest>>) => m.pairs.push(["fx-01", "nope"]),
    ]) {
      const m = await readManifest(fixtureUrl);
      edit(m);
      assert.match(checkManifest(m).join("\n"), /nope/);
    }
  });

  it("fails when a stratum has no image or pixel art runs short", async () => {
    const m = await readManifest(fixtureUrl);
    m.strata.packs.push("pack-z");
    m.strata.minPixel16 = 99;
    const problems = checkManifest(m).join("\n");
    assert.match(problems, /pack pack-z has no image/);
    assert.match(problems, /16-px/);
  });

  it("fails when a card text contains its image's file stem", async () => {
    const m = await readManifest(fixtureUrl);
    const first = m.images[0]!;
    (first.card as { text: string }).text = `A knight, see characters_1 here`;
    assert.match(checkManifest(m).join("\n"), /file stem/);
    assert.equal(containsStem("a Tile-0042 photo", "tile_0042.png"), true);
    assert.equal(containsStem("a tile", "tile_0042.png"), false);
  });

  it("records which texts a person spot-checked", async () => {
    const m = await readManifest(fixtureUrl);
    const checked = m.images.filter((i) => i.card?.spotCheck).map((i) => i.id);
    assert.deepEqual(checked, ["fx-01", "fx-09"]);
  });

  it("the real manifest, when present, holds about 300 images covering every stratum", async (t) => {
    if (!existsSync(realUrl)) return t.skip("bench/search/manifest.json is not built yet");
    const m = await readManifest(realUrl);
    assert.deepEqual(checkManifest(m, { cardsPending: true }), []);
    assert.ok(m.images.length >= 250 && m.images.length <= 350);
    assert.equal(m.writtenQueries.length, 30);
    assert.ok(m.pairs.length > 0);
  });
});

describe("real manifest", () => {
  it("is what build-manifest.ts makes from inventory.csv, with the owner's 300 rows and 30 queries", async () => {
    const rows = parseInventory(
      readFileSync(new URL("../../../bench/search/inventory.csv", import.meta.url), "utf8"),
    );
    assert.equal(rows.length, 300);
    const m = await readManifest(realUrl);
    assert.deepEqual(m, buildManifest(rows, m));
    assert.equal(m.strata.categories.length, 9);
    assert.equal(m.strata.packs.length, 11);
    assert.equal(m.writtenQueries.length, 30);
    assert.ok(m.writtenQueries.filter((q) => q.relevant.length > 0).length >= 20);
  });
});

describe("stratified sample", () => {
  const inventory: InventoryImage[] = [];
  for (const category of ["a", "b", "c"])
    for (const pack of ["p1", "p2"])
      for (let i = 0; i < 12; i++)
        inventory.push({
          id: `${category}-${pack}-${i}`,
          file: `${category}${i}.png`,
          url: "https://x.invalid/i.png",
          sha256: "0".repeat(64),
          width: 16,
          height: 16,
          category,
          pack,
          pixel: i < 3 ? 16 : undefined,
          variantOf: i === 11 ? `${category}-${pack}-10` : undefined,
        });

  it("covers every category and pack cell, enough pixel art, and is deterministic", () => {
    const a = stratifiedSample(inventory, 20, 8, "seed");
    const b = stratifiedSample(inventory, 20, 8, "seed");
    assert.deepEqual(a, b);
    for (const c of ["a", "b", "c"])
      for (const p of ["p1", "p2"]) assert.ok(a.some((i) => i.category === c && i.pack === p));
    assert.ok(a.filter((i) => i.pixel === 16).length >= 8);
    for (const i of a) if (i.variantOf) assert.ok(a.some((x) => x.id === i.variantOf));
  });
});
