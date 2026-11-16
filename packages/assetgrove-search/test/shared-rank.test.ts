import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { searchSlot } from "../src/extension.ts";
import { mergeByScore, rankAcross, rankingQueries, rrf } from "../src/find.ts";
import { MemoryStore } from "../src/memory-store.ts";
import type { Hit, Row } from "../src/store.ts";
import { cleanup, tempDir } from "./helpers/fixture.ts";
import { makeProject, type Project } from "./helpers/project.ts";

const vec = (...n: number[]) => Float32Array.from(n);

function row(tree: string, id: string, v: Float32Array, text: string): Row {
  return {
    key: `${tree}:${id}`,
    tree,
    id,
    address: `a/${id}`,
    source: "pick",
    path: `${id}.png`,
    sha256: id,
    text,
    imageVec: v,
    textVec: v,
  };
}

describe("rankings merged across stores by their own score", () => {
  const local = new MemoryStore();
  const remote = new MemoryStore();
  const words = vec(1, 0);
  before(async () => {
    // Ten unrelated local rows; thirty relevant remote ones.
    await local.upsert(
      Array.from({ length: 10 }, (_, i) => row("t", `door${i}`, vec(0.05, 1), "wooden door")),
    );
    await remote.upsert(
      Array.from({ length: 30 }, (_, i) => row("t", `rock${i}`, vec(1, 0.01 * i), "mossy rock")),
    );
  });
  const searched = () => [
    { store: local, filter: [] },
    { store: remote, filter: [] },
  ];

  it("lists the relevant remote rows before the unrelated local ones", async () => {
    const ranked = await rankAcross(searched(), { words: "mossy rock", limit: 20 }, { words });
    assert.ok(ranked.slice(0, 20).every((h) => h.row.id.startsWith("rock")));
  });

  it("merges one ranking's lists by score, ties keeping the earlier store first", () => {
    const hit = (id: string, score: number): Hit => ({ row: row("t", id, vec(1, 0), ""), score });
    const a = [hit("a1", 0.5), hit("a2", 0.1)];
    const b = [hit("b1", 0.9), hit("b2", 0.5)];
    assert.deepEqual(
      mergeByScore([a, b]).map((h) => h.row.id),
      ["b1", "a1", "b2", "a2"],
    );
    assert.equal(mergeByScore([a]), a);
  });

  it("answers a single store exactly as the fusion of its three lists", async () => {
    const q = { words: "mossy rock", limit: 20 };
    const filter = [{ field: "tree", op: "=" as const, value: "t" }];
    const lists = await Promise.all(
      rankingQueries("mossy rock", { words }, 100).map((r) => remote.query({ ...r, filter })),
    );
    assert.equal(lists.length, 3);
    const got = await rankAcross([{ store: remote, filter }], q, { words });
    assert.deepEqual(got, rrf(lists));
  });
});

describe("find over a shared store", () => {
  let p: Project;
  let remoteDir: string;
  before(async () => {
    p = await makeProject();
    remoteDir = join(await tempDir("remote"), "remote");
    for (let i = 0; i < 10; i++) {
      const base = join(p.root, "candidate", `door${i}`);
      await mkdir(join(p.root, "candidate"), { recursive: true });
      await writeFile(`${base}.png`, `wooden door number ${i}`);
      await writeFile(
        `${base}.card.json`,
        JSON.stringify({ kind: "sprite", title: `Door ${i}`, text: "A wooden door." }),
      );
    }
    for (let i = 0; i < 30; i++) {
      const base = join(p.root, "pick", `rock${i}`);
      await writeFile(`${base}.png`, `mossy rock number ${i}`);
      await writeFile(
        `${base}.card.json`,
        JSON.stringify({ kind: "tile", title: `Rock ${i}`, text: "A mossy rock." }),
      );
    }
  });
  after(() => cleanup(p.root, p.stateDir, remoteDir, join(remoteDir, "..")));

  it("puts the relevant remote picks first, not rank-for-rank with unrelated local rows", async () => {
    const ctx = p.context({
      store: { uri: pathToFileURL(remoteDir).href, options: {}, writer: true },
    });
    await searchSlot.index({}, ctx);
    const { hits } = await searchSlot.find({ words: "mossy rock", limit: 20 }, ctx);
    assert.equal(hits.length, 20);
    for (const h of hits) {
      assert.match(h.path, /rock\d+\.png$/, `${h.path} ranked among the relevant rows`);
    }
  });
});
