/** Several sources filter in the store, and `<`/`>` order values as versions (issue #374). */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { searchSlot } from "../src/extension.ts";
import type { SearchContext } from "../src/contract.ts";
import { cleanup, tempDir } from "./helpers/fixture.ts";
import { projectLibrary } from "./helpers/project.ts";

async function project(files: Record<string, { caption: string; card: object }>) {
  const root = await tempDir("project");
  const stateDir = await tempDir("state");
  for (const [path, f] of Object.entries(files)) {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.caption);
    await writeFile(abs.replace(/\.png$/, ".card.json"), JSON.stringify(f.card));
  }
  const ctx: SearchContext = {
    stateDir,
    worktree: root,
    game: "demo",
    settings: {
      embedder: "scripted",
      model: "siglip2-base",
      candidates: true,
      nearMatch: true,
      folders: [],
    },
    library: projectLibrary(root, { head: "head-1", clean: true }),
    env: {},
    log: () => undefined,
  };
  return { root, stateDir, ctx };
}

describe("several --source values", () => {
  let p: Awaited<ReturnType<typeof project>>;
  before(async () => {
    const files: Record<string, { caption: string; card: object }> = {};
    // 300 picks that all outrank the candidates for "rock".
    for (let i = 0; i < 300; i++) {
      files[`pick/rock-${i}.png`] = { caption: "rock", card: { text: "rock" } };
    }
    for (let i = 0; i < 3; i++) {
      files[`candidate/stone-${i}.png`] = {
        caption: "a mossy stone",
        card: { text: "a mossy stone" },
      };
    }
    p = await project(files);
  });
  after(() => cleanup(p.root, p.stateDir));

  it("draw every ranking's pool from the requested sources", async () => {
    const r = await searchSlot.find(
      { words: "rock", sources: ["candidate", "folder"], limit: 5 },
      p.ctx,
    );
    assert.deepEqual(r.hits.map((h) => h.address).sort(), [
      "asset://g/candidate/stone-0",
      "asset://g/candidate/stone-1",
      "asset://g/candidate/stone-2",
    ]);
    const both = await searchSlot.find(
      { words: "rock", sources: ["candidate", "pick"], limit: 400 },
      p.ctx,
    );
    assert.equal(both.hits.length, 303);
  });
});

describe("< and > on version values", () => {
  let p: Awaited<ReturnType<typeof project>>;
  const numbered = Array.from({ length: 10 }, (_, i) => String(i + 1));
  before(async () => {
    const files: Record<string, { caption: string; card: object }> = {};
    for (const b of numbered) {
      files[`pick/n-${b}.png`] = { caption: `crate ${b}`, card: { kind: "num", bible: b } };
    }
    for (const b of ["v2", "v3", "v10", "v11"]) {
      files[`pick/${b}.png`] = { caption: `barrel ${b}`, card: { kind: "v", bible: b } };
    }
    p = await project(files);
  });
  after(() => cleanup(p.root, p.stateDir));

  const bibles = async (where: string[]) =>
    (await searchSlot.find({ where, limit: 50 }, p.ctx)).hits
      .map((h) => h.fields["bible"] as string)
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

  it("bible<10 keeps every bible from 1 to 9", async () => {
    assert.deepEqual(await bibles(["kind=num", "bible<10"]), numbered.slice(0, 9));
    assert.deepEqual(await bibles(["kind=num", "bible>9"]), ["10"]);
  });

  it("bible<v3 does not count v10 and v11 as older", async () => {
    assert.deepEqual(await bibles(["kind=v", "bible<v3"]), ["v2"]);
    assert.deepEqual(await bibles(["kind=v", "bible>v3"]), ["v10", "v11"]);
  });

  it("a bound no value passes keeps no row", async () => {
    assert.deepEqual(await bibles(["kind=v", "bible<v1"]), []);
  });
});
