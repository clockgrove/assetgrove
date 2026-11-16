import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { RRF_K } from "../src/find.ts";
import { SearchError } from "../src/errors.ts";
import type { Hit } from "../src/store.ts";
import { compareVersions, FILTER_FIELDS } from "../src/where.ts";
import { cleanup, fixtureRepo, LIBRARY, openIndex, tempDir } from "./helpers/fixture.ts";

/** `<` and `>` order `bible` as versions ("2" before "10") and every other field as strings. */
const precedes = (field: string, a: string, b: string): boolean =>
  field === "bible" ? compareVersions(a, b) < 0 : a < b;
import { folderLibrary } from "./helpers/library.ts";

describe("find over the LanceDB store", () => {
  let repo: string;
  let store: string;
  let opened: Awaited<ReturnType<typeof openIndex>>;
  before(async () => {
    repo = await fixtureRepo();
    store = await tempDir("store");
    opened = await openIndex(store, repo);
  });
  after(async () => {
    opened.index.close();
    await cleanup(repo, store);
  });

  it("fuses the image-vector, card-text-vector and full-text lists by RRF (k = 60)", async () => {
    const { index, embedder } = opened;
    const words = "red lantern";
    const result = await index.find({ words, limit: 10 });
    assert.equal(result.fresh, true);
    assert.ok(result.builtFrom?.head.match(/^[0-9a-f]{40}$/));

    // The three rankings, asked of the store directly.
    const [value] = await embedder.inner.embedTexts([words]);
    const filter = [{ field: "tree", op: "=" as const, value: index.tree }];
    const lists = await Promise.all([
      index.store.query({ vector: { column: "imageVec", value: value! }, filter, limit: 100 }),
      index.store.query({ vector: { column: "textVec", value: value! }, filter, limit: 100 }),
      index.store.query({ text: words, filter, limit: 100 }),
    ]);
    assert.ok(
      lists.every((l) => l.length > 0),
      "each list ranks something",
    );
    // Each list cut to one row per asset, then Σ 1 / (60 + rank); the view is the best-ranked one.
    const asset = (h: Hit) => h.row.id;
    const expected = new Map<string, { score: number; best: number; view: string }>();
    for (const list of lists) {
      const seen = new Set<string>();
      let rank = 0;
      for (const h of list) {
        if (seen.has(asset(h))) continue;
        seen.add(asset(h));
        rank++;
        const had = expected.get(h.row.address);
        const add = 1 / (RRF_K + rank);
        if (!had) expected.set(h.row.address, { score: add, best: rank, view: h.row.view ?? "" });
        else {
          had.score += add;
          if (rank < had.best) Object.assign(had, { best: rank, view: h.row.view ?? "" });
        }
      }
    }
    const want = [...expected].sort(([a, x], [b, y]) => y.score - x.score || (a < b ? -1 : 1));
    assert.deepEqual(
      result.hits.map((h) => [h.address, h.view, h.score]),
      want.map(([address, w]) => [address, w.view, w.score]),
    );
    assert.deepEqual(
      result.hits.map((h) => h.rank),
      result.hits.map((_, i) => i + 1),
    );

    // One row per asset, at its best view: the turntable's red, glowing side view.
    const addresses = result.hits.map((h) => h.address);
    assert.equal(new Set(addresses).size, addresses.length);
    const turntable = result.hits.find((h) => h.address === "asset://g/models/lantern-turntable");
    assert.equal(turntable?.view, "side");
    assert.equal(result.hits[0]?.address, "asset://g/sprites/lantern-porch");
    assert.equal(result.hits[0]?.sharedText.title, "Porch lantern");
    assert.deepEqual(result.hits[0]?.fields.tags, ["light", "prop"]);
  });

  it("filters return only matching rows for every allowed field", async () => {
    const { index } = opened;
    const items = await folderLibrary(repo).list();
    const all = await index.find({ limit: 100 });
    assert.equal(all.hits.length, items.length);
    for (const field of FILTER_FIELDS) {
      // Each value a fixture row holds, plus one no row holds.
      const values = new Set<string>(["nothing-has-this"]);
      for (const h of all.hits) {
        const row = { ...h.fields, ...h.sharedText, source: h.source, path: h.path, view: h.view };
        const v = (row as Record<string, unknown>)[field];
        if (typeof v === "string") values.add(v);
      }
      for (const value of values) {
        for (const op of ["=", "!=", "<", ">"] as const) {
          const { hits } = await index.find({ where: `${field}${op}${value}`, limit: 100 });
          const ordered = op === "<" || op === ">";
          const raw = await index.store.query({
            filter: [
              { field: "tree", op: "=", value: index.tree },
              ...(ordered && field === "bible" ? [] : [{ field, op, value }]),
            ],
            limit: 1000,
          });
          if (ordered && field === "bible") {
            // The store compares strings; the expected rows are those on the asked side by version.
            const keep = raw.filter((r) => {
              const got = r.row.bible;
              return (
                got !== undefined &&
                (op === "<" ? precedes(field, got, value) : precedes(field, value, got))
              );
            });
            raw.splice(0, raw.length, ...keep);
          }
          for (const r of raw) {
            const got = (r.row as unknown as Record<string, unknown>)[field] as string | undefined;
            const ok =
              op === "="
                ? got === value
                : op === "!="
                  ? got !== value
                  : got !== undefined &&
                    (op === "<" ? precedes(field, got, value) : precedes(field, value, got));
            assert.ok(ok, `${field}${op}${value} returned ${String(got)}`);
          }
          // And every matching asset is found.
          const want = new Set(raw.map((r) => r.row.address));
          assert.deepEqual(new Set(hits.map((h) => h.address)), want, `${field}${op}${value}`);
        }
      }
    }
    const tagged = await index.find({ where: "tag=light", limit: 100 });
    assert.deepEqual(tagged.hits.map((h) => h.address).sort(), [
      "asset://g/models/lantern-turntable",
      "asset://g/sprites/lantern-porch",
    ]);
    const both = await index.find({ where: ["tag=light", "kind=sprite"], limit: 100 });
    assert.deepEqual(
      both.hits.map((h) => h.address),
      ["asset://g/sprites/lantern-porch"],
    );
  });

  it("refuses an unknown field before searching", async () => {
    for (const where of ["colour=red", "tree=x", "1=1", "kind; DROP TABLE rows=x"]) {
      await assert.rejects(
        opened.index.find({ where, limit: 5 }),
        (e) => e instanceof SearchError && e.code === "invalid_input",
        where,
      );
    }
  });

  it("matches a value holding quotes or SQL keywords literally", async () => {
    const { index } = opened;
    const subject = LIBRARY["sprites/quoted.png"]!.card!.subject as string;
    const exact = await index.find({ where: `subject=${subject}`, limit: 100 });
    assert.deepEqual(
      exact.hits.map((h) => h.address),
      ["asset://g/sprites/quoted"],
    );
    for (const where of [
      "title=x' OR '1'='1",
      "kind=sprite' OR '1'='1",
      "state=x'); DROP TABLE rows; --",
      'kind="sprite"',
      "kind=sprite\\",
    ]) {
      const { hits } = await index.find({ where, limit: 100 });
      if (where.startsWith("title=")) {
        assert.deepEqual(
          hits.map((h) => h.address),
          ["asset://g/sprites/quoted"],
          where,
        );
      } else assert.deepEqual(hits, [], where);
    }
    const tag = await index.find({ where: "tag=o'brien", limit: 100 });
    assert.deepEqual(
      tag.hits.map((h) => h.address),
      ["asset://g/sprites/quoted"],
    );
    // The table is untouched.
    assert.equal((await index.find({ limit: 100 })).hits.length, Object.keys(LIBRARY).length);
  });
});

describe("SearchIndex.find orders bible as versions", () => {
  let repo: string;
  let store: string;
  let opened: Awaited<ReturnType<typeof openIndex>>;
  const numbered = Array.from({ length: 10 }, (_, i) => String(i + 1));
  before(async () => {
    const files: Record<string, { caption: string; card: Record<string, unknown> }> = {};
    for (const b of numbered) files[`n-${b}.png`] = { caption: `crate ${b}`, card: { bible: b } };
    repo = await fixtureRepo(files);
    store = await tempDir("store");
    opened = await openIndex(store, repo);
  });
  after(async () => {
    opened.index.close();
    await cleanup(repo, store);
  });

  const bibles = async (where: string) =>
    (await opened.index.find({ where, limit: 50 })).hits
      .map((h) => h.fields.bible as string)
      .sort(compareVersions);

  it("bible<10 keeps every bible from 1 to 9, with and without words", async () => {
    assert.deepEqual(await bibles("bible<10"), numbered.slice(0, 9));
    assert.deepEqual(await bibles("bible>9"), ["10"]);
    const worded = await opened.index.find({ words: "crate", where: "bible<10", limit: 50 });
    assert.deepEqual(
      worded.hits.map((h) => h.fields.bible as string).sort(compareVersions),
      numbered.slice(0, 9),
    );
  });

  it("other fields keep string order", async () => {
    // "n-10.png" sorts before "n-2.png" as a string.
    const { hits } = await opened.index.find({ where: "path<n-2.png", limit: 50 });
    assert.deepEqual(hits.map((h) => h.path).sort(), ["n-1.png", "n-10.png"]);
  });
});
