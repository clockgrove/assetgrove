import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { nearMatchesWith, searchSlot } from "../src/extension.ts";
import { IMAGE_THRESHOLD } from "../src/image-threshold.ts";
import { cleanup } from "./helpers/fixture.ts";
import { makeProject, type Project } from "./helpers/project.ts";

const EXTRA: Record<string, { caption: string; card: Record<string, unknown> }> = {
  "pick/oak.png": {
    caption: "green oak tree",
    card: { kind: "sprite", subject: "oak", title: "Oak" },
  },
  "pick/oak-night.png": {
    caption: "dark blue night forest of crows",
    card: { kind: "sprite", subject: "oak", title: "Oak at night" },
  },
  "pick/oak-tile.png": {
    caption: "green oak tree",
    card: { kind: "tile", subject: "oak", title: "Oak tile" },
  },
  "pick/elm.png": {
    caption: "green oak tree",
    card: { kind: "sprite", subject: "elm", title: "Elm" },
  },
};

describe("near matches", () => {
  let p: Project;
  before(async () => {
    p = await makeProject();
    for (const [path, f] of Object.entries(EXTRA)) {
      await writeFile(join(p.root, path), f.caption);
      await writeFile(join(p.root, path.replace(/\.png$/, ".card.json")), JSON.stringify(f.card));
    }
  });
  after(() => cleanup(p.root, p.stateDir));

  const query = (references: Uint8Array[] = []) => ({
    kind: "sprite",
    subject: "oak",
    references,
    limit: 3,
  });

  it("lists only picks of exactly the kind and subject, without the threshold", async () => {
    const r = await nearMatchesWith(0.99, query(), p.context());
    assert.deepEqual(r.hits.map((h) => h.address).sort(), [
      "asset://g/pick/oak",
      "asset://g/pick/oak-night",
    ]);
  });

  it("leaves out a same-kind, same-subject pick below the threshold when references exist", async () => {
    const ref = [Buffer.from("green oak tree")];
    const r = await nearMatchesWith(0.99, query(ref), p.context());
    assert.deepEqual(
      r.hits.map((h) => h.address),
      ["asset://g/pick/oak"],
    );
    const loose = await nearMatchesWith(-1, query(ref), p.context());
    assert.equal(loose.hits.length, 2);
  });

  it("lists nothing with references while the shipped threshold is unmeasured", async () => {
    const r = await nearMatchesWith(null, query([Buffer.from("green oak tree")]), p.context());
    assert.deepEqual(r.hits, []);
  });

  it("is a method of the slot", async () => {
    assert.equal(typeof searchSlot.nearMatch, "function");
  });
});

describe("the shipped image-similarity threshold", () => {
  it("equals the one docs/decisions.md records", async () => {
    const text = await readFile(new URL("../../../docs/decisions.md", import.meta.url), "utf8");
    const m = /Shipped image-similarity threshold: (not yet measured|[0-9.]+)\./.exec(text);
    assert.ok(m, "docs/decisions.md records the shipped threshold");
    assert.equal(m[1] === "not yet measured" ? null : Number(m[1]), IMAGE_THRESHOLD);
  });
});
