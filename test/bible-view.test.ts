import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BIBLE_PRESETS, loadBible } from "../src/bible.ts";
import { styleBibleOf } from "../src/bible-view.ts";
import { JSON_BIBLE_NOTICE, loadStyleBible } from "../src/inputs.ts";
import { PALETTE, syntheticBibleMd, syntheticWorld } from "./fixtures/synthetic.ts";

async function world(t: { after: (fn: () => Promise<void>) => void }) {
  const w = await syntheticWorld();
  t.after(() => rm(w.dir, { recursive: true, force: true }));
  return w;
}

test("a BIBLE.md's style view: palette, subject references without the perspective sample, descriptions, mood and notes", async (t) => {
  const w = await world(t);
  const view = styleBibleOf(await loadBible(await syntheticBibleMd(w)));
  assert.equal(view.version, w.bible.version);
  assert.deepEqual(view.palette, PALETTE);
  assert.deepEqual(
    view.references.map((r) => [r.path, r.subject]),
    [
      ["refs/fern-sheet.png", "fern"],
      ["refs/fern-turnaround.png", "fern"],
      ["refs/den.png", "den"],
    ],
  );
  assert.equal(view.perspective, "refs/perspective.png");
  assert.deepEqual(view.subjects, w.bible.subjects);
  assert.deepEqual(view.mood, BIBLE_PRESETS["cozy-storybook"]?.tone.moodRange);
  assert.ok(view.notes?.includes("rendering: painterly"), String(view.notes));
  assert.ok(view.notes?.includes("audience: all-ages"), String(view.notes));
});

test("an axis a look overrides is the world's unless the look sets it, and the look gives its own", async (t) => {
  const w = await world(t);
  const path = await syntheticBibleMd(w, (bible) => {
    bible.looks = { character: { rendering: "naturalistic", texture: "fine fur" } };
  });
  const view = styleBibleOf(await loadBible(path));
  assert.ok(view.notes?.includes("rendering: painterly (unless the asset's look sets it)"));
  assert.ok(
    view.notes?.some(
      (n) => n.startsWith("texture: ") && n.endsWith("(unless the asset's look sets it)"),
    ),
  );
  assert.ok(view.notes?.some((n) => n.startsWith("shading: ") && !n.includes("unless")));
  assert.deepEqual(view.looks?.["character"]?.notes, [
    "rendering for this look: naturalistic",
    "texture for this look: fine fur",
  ]);
});

test("an identity lock adds its turnaround and references once, and describes a subject the bible does not", async (t) => {
  const w = await world(t);
  const path = await syntheticBibleMd(w, (bible) => {
    bible.identities = {
      fern: {
        version: "1",
        approved: true,
        turnaround: "refs/fern-turnaround.png",
        references: ["refs/den.png"],
        signatureFeatures: ["dark mask", "banded tail"],
        proportions: "short legs",
        palette: ["#26242c"],
      },
      moss: {
        version: "1",
        approved: true,
        turnaround: "refs/fern-sheet.png",
        signatureFeatures: ["round ears"],
        proportions: "small and round",
        palette: ["#26242c"],
      },
    };
  });
  const view = styleBibleOf(await loadBible(path));
  const fern = view.references.filter((r) => r.subject === "fern").map((r) => [r.path, r.role]);
  assert.deepEqual(fern, [
    ["refs/fern-sheet.png", "character sheet"],
    ["refs/fern-turnaround.png", "turnaround"],
    ["refs/den.png", "identity reference"],
  ]);
  assert.deepEqual(
    view.references.filter((r) => r.subject === "moss").map((r) => r.role),
    ["approved turnaround"],
  );
  assert.equal(view.subjects?.["moss"]?.description, "small and round; round ears");
  assert.equal(view.subjects?.["fern"]?.description, w.bible.subjects?.["fern"]?.description);
});

test("loadStyleBible reads a BIBLE.md as its style view, and a JSON bible with the deprecation notice", async (t) => {
  const w = await world(t);
  const notices: string[] = [];
  const log = (message: string) => notices.push(message);
  const md = await loadStyleBible(await syntheticBibleMd(w), { log });
  assert.equal(md.markdown, true);
  assert.deepEqual(md.value.palette, PALETTE);
  assert.equal(md.dir, w.bibleDir);
  assert.deepEqual(notices, []);
  const jsonPath = join(w.bibleDir, "bible.json");
  await writeFile(jsonPath, JSON.stringify(w.bible));
  const json = await loadStyleBible(jsonPath, { log });
  assert.equal(json.markdown, false);
  assert.deepEqual(notices, [JSON_BIBLE_NOTICE]);
});

test("a BIBLE.md's perspective and subjects are validated when it loads", async (t) => {
  const w = await world(t);
  // serializeBible validates as it writes, so a malformed field is refused before loading too.
  await assert.rejects(
    async () => syntheticBibleMd(w, (bible) => Object.assign(bible, { perspective: 7 })),
    /perspective/,
  );
  await assert.rejects(
    async () => syntheticBibleMd(w, (bible) => Object.assign(bible, { subjects: { fern: {} } })),
    /subjects\.fern\.description/,
  );
  const outside = await syntheticBibleMd(w, (bible) =>
    Object.assign(bible, { perspective: "../../outside.png" }),
  );
  await assert.rejects(loadBible(outside), /outside|project/i);
});
