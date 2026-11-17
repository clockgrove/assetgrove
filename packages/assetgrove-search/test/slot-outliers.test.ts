import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readdir, writeFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { searchSlot } from "../src/extension.ts";
import { cleanup, tempDir } from "./helpers/fixture.ts";
import { makeProject, type Project } from "./helpers/project.ts";

const WORDS = ["moss", "ivy", "fern", "bark", "reed", "sedge", "clover", "thistle"];
const uniform = WORDS.map((w, i) => `asset://g/pick/tile-${i}-${w}`);
const planted = "asset://g/pick/planted";

describe("the slot's outliers over an indexed fixture set", () => {
  let p: Project;
  let remoteDir: string;
  before(async () => {
    p = await makeProject();
    remoteDir = join(await tempDir("remote"), "remote");
    for (const [i, w] of WORDS.entries()) {
      await writeFile(join(p.root, `pick/tile-${i}-${w}.png`), `flat green tile ${w}`);
    }
    await writeFile(join(p.root, "pick/planted.png"), "photoreal chrome spaceship render");
  });
  after(() => cleanup(p.root, p.stateDir, remoteDir, join(remoteDir, "..")));

  it("reads stored vectors only: an unindexed set ranks nothing and writes no index", async () => {
    const ctx = p.context();
    const listing = () =>
      readdir(join(p.stateDir, "search"), { recursive: true }).catch(() => [] as string[]);
    const before = await listing();
    const found = await searchSlot.outliers([...uniform, planted], ctx);
    assert.equal(found.members, 0);
    assert.deepEqual(found.ranking, []);
    const added = (await listing()).filter(
      (n) => String(n).includes(".lance") && !before.includes(n),
    );
    assert.deepEqual(added, [], "the ranking embedded and indexed nothing");
  });

  it("ranks every member, the planted asset first, uncut", async () => {
    const ctx = p.context();
    await searchSlot.index({}, ctx);
    const found = await searchSlot.outliers([...uniform, planted], ctx);
    assert.equal(found.members, 9);
    assert.equal(found.ranking.length, 9);
    assert.equal(found.ranking[0]!.address, planted);
    const none = await searchSlot.outliers(uniform, ctx);
    assert.equal(none.members, 8);
    assert.equal(none.ranking.length, 8);
  });

  it("finds pick vectors in the shared store", async () => {
    const ctx = p.context({
      store: { uri: pathToFileURL(remoteDir).href, options: {}, credentialsEnv: {}, writer: true },
    });
    await searchSlot.index({}, ctx);
    const found = await searchSlot.outliers([...uniform, planted], ctx);
    assert.equal(found.members, 9);
    assert.equal(found.ranking[0]!.address, planted);
  });
});
