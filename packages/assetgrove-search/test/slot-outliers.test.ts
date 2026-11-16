import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
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

  it("lists the planted asset and nothing on the uniform set", async () => {
    const ctx = p.context();
    const found = await searchSlot.outliers([...uniform, planted], ctx);
    assert.equal(found.members, 9);
    assert.deepEqual(
      found.outliers.map((o) => o.address),
      [planted],
    );
    assert.ok(found.outliers[0]!.z > 3);
    const none = await searchSlot.outliers(uniform, ctx);
    assert.equal(none.members, 8);
    assert.deepEqual(none.outliers, []);
  });

  it("finds pick vectors in the shared store", async () => {
    const ctx = p.context({
      store: { uri: pathToFileURL(remoteDir).href, options: {}, writer: true },
    });
    await searchSlot.index({}, ctx);
    const found = await searchSlot.outliers([...uniform, planted], ctx);
    assert.equal(found.members, 9);
    assert.deepEqual(
      found.outliers.map((o) => o.address),
      [planted],
    );
  });
});
