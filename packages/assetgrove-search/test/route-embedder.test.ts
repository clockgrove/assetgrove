import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { SearchContext, SearchRouteEmbedder } from "../src/contract.ts";
import { SearchError } from "../src/errors.ts";
import { searchSlot } from "../src/extension.ts";
import { ScriptedEmbedder } from "../src/scripted.ts";
import { cleanup } from "./helpers/fixture.ts";
import { makeProject, PROJECT, type Project } from "./helpers/project.ts";

const scripted = new ScriptedEmbedder();

/** A fake hosted route: scripted vectors, one counted call per input. */
function port(
  model: string,
  calls: { n: number },
  withEmbed = true,
  via = "vercel",
): SearchRouteEmbedder {
  const p: SearchRouteEmbedder = { route: via, model, dimension: 768 };
  if (withEmbed) {
    p.embed = async (input) => {
      calls.n++;
      const [v] =
        "image" in input
          ? await scripted.embedImages([input.image])
          : await scripted.embedTexts([input.text]);
      return Array.from(v as Float32Array);
    };
  }
  return p;
}

const isCode = (code: string) => (e: unknown) => e instanceof SearchError && e.code === code;

describe("the route embedder", () => {
  let p: Project;
  before(async () => {
    p = await makeProject();
  });
  after(() => cleanup(p.root, p.stateDir));

  const route = (
    model: string,
    calls: { n: number },
    withEmbed = true,
    via = "vercel",
  ): SearchContext => ({
    ...p.context({ embedder: "route" }),
    embedder: port(model, calls, withEmbed, via),
  });
  const files = Object.keys(PROJECT).length;

  it("forecasts one embedding per image view and text, and none after an index", async () => {
    const calls = { n: 0 };
    const ctx = route("model-a", calls);
    const f = await searchSlot.forecast!({ index: {} }, ctx);
    assert.deepEqual([f.images, f.texts, f.queries], [files, files, 0]);
    assert.equal(calls.n, 0, "a forecast never embeds");
    assert.equal(
      (await searchSlot.forecast!({ index: {} }, route("model-a", calls, false))).state,
      f.state,
    );

    await searchSlot.index({}, ctx);
    assert.equal(calls.n, f.images + f.texts);

    calls.n = 0;
    const after = await searchSlot.forecast!({ index: {} }, ctx);
    assert.deepEqual([after.images, after.texts], [0, 0]);
    await searchSlot.index({}, ctx);
    assert.equal(calls.n, 0, "a repeat pays nothing");

    const q = await searchSlot.forecast!({ find: { words: "lantern", limit: 3 } }, ctx);
    assert.equal(q.queries, 1);
    const li = await searchSlot.forecast!(
      { find: { like: { image: Buffer.from("x") }, limit: 3 } },
      ctx,
    );
    assert.equal(li.queries, 1);
    const none = await searchSlot.forecast!({ find: { where: ["kind=tile"], limit: 3 } }, ctx);
    assert.equal(none.queries, 0);
    assert.equal(calls.n, 0);
  });

  it("rebuilds without re-embedding what the cache holds", async () => {
    const calls = { n: 0 };
    const ctx = route("model-a", calls);
    const f = await searchSlot.forecast!({ index: { rebuild: true } }, ctx);
    assert.deepEqual([f.images, f.texts], [0, 0]);
    await searchSlot.index({ rebuild: true }, ctx);
    assert.equal(calls.n, 0);
    assert.equal((await searchSlot.find({ words: "lantern", limit: 1 }, ctx)).hits.length, 1);
  });

  it("answers reads from stored vectors without the port, and refuses words", async () => {
    const calls = { n: 0 };
    const ctx = route("model-a", calls, false);
    const tiles = await searchSlot.find({ where: ["kind=tile"], limit: 10 }, ctx);
    assert.deepEqual(tiles.hits.map((h) => h.address).sort(), [
      "asset://g/pick/bridge",
      "asset://g/reference/crystal",
    ]);
    assert.equal(tiles.fresh, false);
    const like = await searchSlot.find(
      { like: { address: "asset://g/pick/bridge" }, limit: 1 },
      ctx,
    );
    assert.equal(like.hits[0]?.address, "asset://g/pick/bridge");
    await assert.rejects(
      searchSlot.find({ words: "lantern", limit: 1 }, ctx),
      isCode("invalid_input"),
    );
    await assert.rejects(
      searchSlot.find({ like: { image: Buffer.from("x") }, limit: 1 }, ctx),
      isCode("invalid_input"),
    );
    assert.equal(calls.n, 0);
  });

  it("refuses a different embedder until the index is rebuilt", async () => {
    const calls = { n: 0 };
    const other = route("model-b", calls);
    for (const attempt of [
      () => searchSlot.find({ words: "lantern", limit: 1 }, other),
      () => searchSlot.index({}, other),
      () => searchSlot.forecast!({ index: {} }, other),
      // A plan step's near matches and the free ranking refuse it too (design 7.6, 7.7).
      () =>
        searchSlot.nearMatch!(
          { kind: "still", subject: "lantern", references: [], limit: 3 },
          other,
        ),
      () => searchSlot.outliers(["asset://g/pick/lantern"], other),
    ]) {
      await assert.rejects(attempt(), (e) => {
        assert.ok(e instanceof SearchError);
        assert.equal(e.code, "embedder_changed");
        assert.match(e.message, /search index --rebuild/);
        return true;
      });
    }
    await assert.rejects(
      searchSlot.find({ limit: 1 }, p.context({ embedder: "scripted" })),
      isCode("embedder_changed"),
    );
    assert.equal(calls.n, 0);

    await searchSlot.index({ rebuild: true }, other);
    assert.equal(calls.n, files * 2, "a new model embeds everything once");
    const r = await searchSlot.find({ words: "lantern", limit: 1 }, other);
    assert.equal(r.hits[0]?.address, "asset://g/pick/lantern");
    await assert.rejects(
      searchSlot.find({ limit: 1 }, route("model-a", calls)),
      isCode("embedder_changed"),
    );
  });

  it("keeps another route's vectors apart: a rebuild under a new route with the same model re-embeds", async () => {
    const calls = { n: 0 };
    const other = route("model-b", calls, true, "openai");
    await assert.rejects(searchSlot.index({}, other), isCode("embedder_changed"));
    const f = await searchSlot.forecast!({ index: { rebuild: true } }, other);
    assert.deepEqual([f.images, f.texts], [files, files], "no vector of the old route counts");
    await searchSlot.index({ rebuild: true }, other);
    assert.equal(calls.n, files * 2, "the new route embeds everything once");
    const status = await searchSlot.status(other);
    assert.equal((status["recordedEmbedder"] as { route?: string }).route, "openai");
  });
});
