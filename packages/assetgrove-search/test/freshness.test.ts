import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { appendFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { SearchIndex } from "../src/find.ts";
import { SearchError } from "../src/errors.ts";
import { treeKey } from "../src/library.ts";
import { ScriptedEmbedder } from "../src/scripted.ts";
import {
  cleanup,
  fixtureRepo,
  git,
  LIBRARY,
  openIndex,
  snapshot,
  tempDir,
  writeFixture,
} from "./helpers/fixture.ts";
import { folderLibrary } from "./helpers/library.ts";

const run = promisify(execFile);
const N = Object.keys(LIBRARY).length;
const addresses = async (index: SearchIndex, q: Parameters<SearchIndex["find"]>[0] = {}) =>
  (await index.find({ limit: 100, ...q })).hits.map((h) => h.address).sort();

describe("freshness", () => {
  it("embeds nothing for an unchanged tree and exactly the changed, added or deleted file", async () => {
    const repo = await fixtureRepo();
    const store = await tempDir("store");
    const { index, embedder } = await openIndex(store, repo);
    try {
      await index.find({ words: "lantern" });
      // Four still images and three turntable views; seven card texts, minus none shared.
      assert.equal(embedder.images, N - 1 + 3);
      assert.equal(embedder.texts, N + 1); // the card texts and the query

      embedder.reset();
      const before = await snapshot(store);
      const r = await index.find({ words: "lantern" });
      assert.equal(r.fresh, true);
      assert.equal(embedder.images, 0);
      assert.equal(embedder.texts, 1); // the query alone
      assert.deepEqual(await snapshot(store), before, "an unchanged tree writes nothing");

      // Changed: new bytes, same card.
      embedder.reset();
      await writeFile(join(repo, "tiles/stone-bridge.png"), "wooden bridge over a canyon at dusk");
      await index.find({ words: "canyon dusk" });
      assert.equal(embedder.images, 1);
      assert.equal(embedder.texts, 1); // the query; the card text is cached
      const [canyon] = await embedder.inner.embedImages([Buffer.from("canyon dusk")]);
      const byLook = await index.store.query({
        vector: { column: "imageVec", value: canyon! },
        limit: 1,
      });
      assert.equal(byLook[0]?.row.address, "asset://g/tiles/stone-bridge");

      // Touched, same bytes: nothing embedded.
      embedder.reset();
      await writeFile(join(repo, "tiles/stone-bridge.png"), "wooden bridge over a canyon at dusk");
      await index.find({});
      assert.equal(embedder.images + embedder.texts, 0);

      // Added.
      embedder.reset();
      await writeFixture(repo, {
        "sprites/anvil.png": { caption: "iron anvil", card: { kind: "sprite", text: "An anvil." } },
      });
      const hits = (await index.find({ words: "iron anvil", limit: 1 })).hits;
      assert.deepEqual([embedder.images, embedder.texts], [1, 2]);
      assert.equal(hits[0]?.address, "asset://g/sprites/anvil");

      // A card edit alone re-embeds only its text.
      embedder.reset();
      await writeFile(
        join(repo, "sprites/anvil.card.json"),
        JSON.stringify({ kind: "sprite", text: "A blacksmith's anvil." }),
      );
      await index.find({});
      assert.deepEqual([embedder.images, embedder.texts], [0, 1]);

      // Deleted: its rows are gone, nothing embedded.
      embedder.reset();
      await unlink(join(repo, "sprites/anvil.png"));
      await unlink(join(repo, "models/lantern-turntable.png"));
      const left = await addresses(index);
      assert.equal(left.length, N - 1);
      assert.ok(!left.includes("asset://g/sprites/anvil"));
      assert.ok(!left.includes("asset://g/models/lantern-turntable"));
      assert.equal(embedder.images + embedder.texts, 0);
      const raw = await index.store.query({
        filter: [{ field: "path", op: "=", value: "models/lantern-turntable.png" }],
        limit: 10,
      });
      assert.deepEqual(raw, [], "every view's row is removed");
      assert.equal((await index.store.sources(index.tree)).length, N - 1);
    } finally {
      index.close();
      await cleanup(repo, store);
    }
  });

  it("embeds nothing on switching to a branch whose files were seen before", async () => {
    const repo = await fixtureRepo();
    const store = await tempDir("store");
    const { index, embedder } = await openIndex(store, repo);
    try {
      await index.find({});
      git(repo, "checkout", "-q", "-b", "feature");
      await writeFile(join(repo, "sprites/crystal-cave.png"), "green crystal shard on moss");
      await rm(join(repo, "tiles"), { recursive: true });
      await writeFixture(repo, {
        "sprites/well.png": { caption: "village well", card: { kind: "sprite", text: "A well." } },
      });
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "feature");
      embedder.reset();
      const onFeature = await addresses(index);
      assert.ok(embedder.images > 0, "the feature branch has new content");
      assert.ok(onFeature.includes("asset://g/sprites/well"));
      assert.ok(!onFeature.includes("asset://g/tiles/stone-bridge"));

      embedder.reset();
      git(repo, "checkout", "-q", "main");
      const onMain = await addresses(index);
      assert.deepEqual([embedder.images, embedder.texts], [0, 0]);
      assert.ok(onMain.includes("asset://g/tiles/stone-bridge"));
      assert.ok(!onMain.includes("asset://g/sprites/well"));
      const main = await index.find({});
      assert.equal(main.builtFrom?.head, git(repo, "rev-parse", "HEAD").trim());

      embedder.reset();
      git(repo, "checkout", "-q", "feature");
      assert.deepEqual(await addresses(index), onFeature);
      assert.deepEqual([embedder.images, embedder.texts], [0, 0]);
    } finally {
      index.close();
      await cleanup(repo, store);
    }
  });

  it("keeps separate rows for two work trees of one repository", async () => {
    const repo = await fixtureRepo();
    const store = await tempDir("store");
    const second = join(await tempDir("wt"), "second");
    git(repo, "worktree", "add", "-q", "-b", "other", second);
    await writeFixture(second, {
      "sprites/well.png": { caption: "village well", card: { kind: "sprite", text: "A well." } },
    });
    await unlink(join(second, "sprites/quoted.png"));
    const a = await openIndex(store, repo);
    const b = await openIndex(store, second);
    try {
      assert.notEqual(a.index.tree, b.index.tree);
      assert.equal(a.index.tree, treeKey(repo));
      const inA = await addresses(a.index);
      const inB = await addresses(b.index);
      assert.ok(
        inA.includes("asset://g/sprites/quoted") && !inA.includes("asset://g/sprites/well"),
      );
      assert.ok(
        inB.includes("asset://g/sprites/well") && !inB.includes("asset://g/sprites/quoted"),
      );
      // The second tree's shared files came from the content cache.
      assert.equal(b.embedder.images, 1);
      // Removing a file in one tree leaves the other's row.
      await unlink(join(second, "tiles/stone-bridge.png"));
      assert.ok(!(await addresses(b.index)).includes("asset://g/tiles/stone-bridge"));
      assert.ok((await addresses(a.index)).includes("asset://g/tiles/stone-bridge"));
      // Every tree in the store.
      const everywhere = await a.index.find({ allTrees: true, limit: 100 });
      assert.equal(everywhere.hits.length, N + (N - 1)); // one tree lost quoted, gained well, lost bridge
    } finally {
      a.index.close();
      b.index.close();
      await cleanup(repo, store, join(second, ".."));
    }
  });
});

describe("the write lock", () => {
  it("answers at once with fresh false and writes nothing while another process holds it", async () => {
    const repo = await fixtureRepo();
    const store = await tempDir("store");
    const { index, embedder } = await openIndex(store, repo);
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      const first = await index.find({ words: "lantern" });
      await writeFile(join(store, "write.lock"), `${holder.pid}\n`);
      await writeFile(join(repo, "tiles/stone-bridge.png"), "a changed bridge");
      await appendFile(join(repo, "sprites/quoted.png"), " changed");
      embedder.reset();
      const before = await snapshot(store);
      const started = performance.now();
      const r = await index.find({ words: "lantern" });
      const ms = performance.now() - started;
      assert.equal(r.fresh, false);
      assert.deepEqual(r.hits, first.hits, "answers from the current table");
      assert.equal(embedder.images, 0);
      assert.equal(embedder.texts, 1, "only the query is embedded");
      assert.deepEqual(await snapshot(store), before, "nothing is written");
      assert.ok(ms < 2000, `returned in ${ms} ms`);

      // A writer waits its turn and gives up at its timeout.
      const waiting = await SearchIndex.open({
        dir: store,
        embedder,
        library: folderLibrary(repo),
        worktree: repo,
        lockTimeoutMs: 200,
      });
      await assert.rejects(
        waiting.index(),
        (e) => e instanceof SearchError && e.code === "store_locked",
      );
      waiting.close();

      // Once released, the next query is fresh again.
      holder.kill();
      await new Promise((resolve) => holder.once("exit", resolve));
      const after = await index.find({ words: "lantern" });
      assert.equal(after.fresh, true);
      assert.equal(embedder.images, 2);
    } finally {
      holder.kill();
      index.close();
      await cleanup(repo, store);
    }
  });

  it("a query against a store another process holds before its first build answers empty", async () => {
    const repo = await fixtureRepo();
    const store = await tempDir("store");
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      await writeFile(join(store, "write.lock"), `${holder.pid}\n`);
      const { index } = await openIndex(store, repo);
      const r = await index.find({ words: "lantern" });
      assert.deepEqual([r.fresh, r.hits, r.builtFrom], [false, [], undefined]);
      const files = (await snapshot(store)).map((l) => l.split(" ")[0]);
      assert.deepEqual(files, ["write.lock"], "no table is created");
      index.close();
    } finally {
      holder.kill();
      await cleanup(repo, store);
    }
  });

  it("two writer processes in turn both finish with every row present", async () => {
    const one = await fixtureRepo();
    const two = await fixtureRepo({
      "a/well.png": { caption: "village well", card: { kind: "sprite" } },
      "a/cart.png": { caption: "hay cart", card: { kind: "sprite" } },
    });
    const store = await tempDir("store");
    try {
      const writer = join(import.meta.dirname, "fixtures/writer.ts");
      const results = await Promise.all(
        [one, two, one].map((tree) => run(process.execPath, [writer, store, tree])),
      );
      const written = results.map((r) => JSON.parse(r.stdout).written as number);
      // Whichever of the two writers of `one` ran second found nothing left to do.
      assert.deepEqual(
        [...written].sort((x, y) => x - y),
        [0, 2, N],
      );
      const a = await SearchIndex.open({
        dir: store,
        embedder: new ScriptedEmbedder(),
        library: folderLibrary(one),
        worktree: one,
      });
      const b = await SearchIndex.open({
        dir: store,
        embedder: new ScriptedEmbedder(),
        library: folderLibrary(two),
        worktree: two,
      });
      assert.equal(
        (await a.store.query({ filter: [{ field: "tree", op: "=", value: a.tree }], limit: 100 }))
          .length,
        N - 1 + 3,
      );
      assert.equal(
        (await b.store.query({ filter: [{ field: "tree", op: "=", value: b.tree }], limit: 100 }))
          .length,
        2,
      );
      assert.equal((await a.find({ allTrees: true, limit: 100 })).hits.length, N + 2);
      a.close();
      b.close();
    } finally {
      await cleanup(one, two, store);
    }
  });
});

describe("rebuild and platform", () => {
  it("rebuilds a deleted store folder with identical results", async () => {
    const repo = await fixtureRepo();
    const store = await tempDir("store");
    const { index } = await openIndex(store, repo);
    try {
      const queries = [
        { words: "red lantern" },
        { words: "stone bridge river", where: "state=approved" },
        { words: "crystal" },
        { where: ["kind=sprite", "tag=light"] },
        { where: "bible!=caves" },
      ];
      const first = [];
      for (const q of queries) first.push((await index.find(q)).hits);
      await rm(store, { recursive: true, force: true });
      const progress: number[] = [];
      const rebuilt = await SearchIndex.open({
        dir: store,
        embedder: new ScriptedEmbedder(),
        library: folderLibrary(repo),
        worktree: repo,
        onProgress: (done) => progress.push(done),
      });
      // The open index and a newly opened one both see the rebuilt store.
      for (const [i, q] of queries.entries()) {
        const r = await (i === 0 ? rebuilt : index).find(q);
        assert.equal(r.fresh, true);
        assert.deepEqual(r.hits, first[i], JSON.stringify(q));
      }
      assert.deepEqual(progress, [N]);
      rebuilt.close();

      // A table folder that lost its `_versions` is rebuilt too.
      const tables = (await snapshot(store)).filter((l) =>
        /^rows_[^/]*\.lance\/_versions /.test(l),
      );
      assert.equal(tables.length, 1);
      await rm(join(store, tables[0]!.split(" ")[0]!), { recursive: true });
      assert.deepEqual((await index.find(queries[0]!)).hits, first[0]);
    } finally {
      index.close();
      await cleanup(repo, store);
    }
  });

  it("refuses on darwin-x64 with extension_unavailable, reason platform, before importing LanceDB", async () => {
    let imported = false;
    await assert.rejects(
      SearchIndex.open({
        dir: "/nonexistent",
        embedder: new ScriptedEmbedder(),
        library: folderLibrary("."),
        worktree: ".",
        platform: { platform: "darwin", arch: "x64" },
        importLance: async () => {
          imported = true;
          throw new Error("imported");
        },
      }),
      (e) =>
        e instanceof SearchError &&
        e.code === "extension_unavailable" &&
        e.details.reason === "platform",
    );
    assert.equal(imported, false);
  });
});
