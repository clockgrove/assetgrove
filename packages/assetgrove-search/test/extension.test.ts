import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import extension from "../src/extension.ts";
import { SearchError } from "../src/errors.ts";
import { cleanup } from "./helpers/fixture.ts";
import { makeProject, type Project } from "./helpers/project.ts";

describe("the search extension", () => {
  let p: Project;
  before(async () => {
    p = await makeProject();
  });
  after(() => cleanup(p.root, p.stateDir));

  const slot = extension({ api: 1 }).search!;

  it("declares the search slot", () => {
    const ext = extension({ api: 1 });
    assert.equal(ext.api, 1);
    assert.equal(ext.name, "search");
  });

  it("finds by words with shared text, and indexes every source locally", async () => {
    const ctx = p.context();
    await slot.index({}, ctx);
    const r = await slot.find({ words: "red lantern", limit: 5 }, ctx);
    assert.equal(r.hits[0]?.address, "asset://g/pick/lantern");
    assert.equal(r.hits[0]?.rank, 1);
    assert.equal(r.hits[0]?.sharedText.title, "Porch lantern");
    assert.equal(r.hits[0]?.fields.kind, "sprite");
    assert.equal("subject" in (r.hits[0]?.fields ?? {}), false);
    assert.equal(r.fresh, true);
    assert.equal(r.builtFrom?.head, "head-1");
    const all = await slot.find({ limit: 20 }, ctx);
    assert.equal(all.hits.length, 5);
  });

  it("ranks by the image vector for --like, by address and by image bytes", async () => {
    const ctx = p.context();
    const byAddress = await slot.find(
      { like: { address: "asset://g/reference/crystal" }, limit: 3 },
      ctx,
    );
    assert.equal(byAddress.hits[0]?.address, "asset://g/reference/crystal");
    const byImage = await slot.find(
      { like: { image: Buffer.from("stone bridge over a river") }, limit: 3 },
      ctx,
    );
    assert.equal(byImage.hits[0]?.address, "asset://g/pick/bridge");
    const rankOf = (r: { hits: { address: string }[] }) =>
      r.hits.findIndex((h) => h.address === "asset://g/pick/bridge");
    const wordsOnly = await slot.find({ words: "lantern", limit: 5 }, ctx);
    const both = await slot.find(
      { words: "lantern", like: { image: Buffer.from("stone bridge") }, limit: 5 },
      ctx,
    );
    assert.equal(both.hits[0]?.address, "asset://g/pick/lantern");
    assert.ok(rankOf(both) < rankOf(wordsOnly), "the image list lifts the bridge");
    await assert.rejects(
      slot.find({ like: { address: "asset://g/none" }, limit: 3 }, ctx),
      (e) => e instanceof SearchError && e.code === "invalid_input",
    );
  });

  it("filters with where and sources; an unknown field is invalid_input", async () => {
    const ctx = p.context();
    const tiles = await slot.find({ where: ["kind=tile"], limit: 10 }, ctx);
    assert.deepEqual(tiles.hits.map((h) => h.address).sort(), [
      "asset://g/pick/bridge",
      "asset://g/reference/crystal",
    ]);
    const picks = await slot.find({ sources: ["pick", "candidate"], limit: 10 }, ctx);
    assert.deepEqual(new Set(picks.hits.map((h) => h.source)), new Set(["pick", "candidate"]));
    await assert.rejects(
      slot.find({ where: ["colour=red"], limit: 3 }, ctx),
      (e) => e instanceof SearchError && e.code === "invalid_input",
    );
  });

  it("leaves candidates out when the settings say so, after a rebuild", async () => {
    const ctx = p.context({ candidates: false });
    await slot.index({ rebuild: true }, ctx);
    const r = await slot.find({ limit: 20 }, ctx);
    assert.ok(!r.hits.some((h) => h.source === "candidate"));
    assert.equal(r.hits.length, 4);
  });

  it("re-embeds everything on a rebuild with a model that is not hosted: the content cache goes too", async () => {
    const ctx = p.context();
    await slot.index({}, ctx);
    const rebuilt = (await slot.index({ rebuild: true }, ctx)) as {
      local: { written: number; embeddedImages: number };
    };
    assert.ok(rebuilt.local.written > 0);
    assert.ok(rebuilt.local.embeddedImages > 0, "the cache did not answer the rebuild");
  });

  it("reports status and setup for the scripted embedder", async () => {
    const ctx = p.context();
    const s = await slot.status(ctx);
    assert.equal((s.embedder as { id: string }).id, "scripted");
    assert.deepEqual(await slot.setup(ctx), { model: "scripted", installed: true });
  });
});
