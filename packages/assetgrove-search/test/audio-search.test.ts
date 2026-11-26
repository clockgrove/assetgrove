import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempProject } from "@clockgrove/assetgrove/testing";
import { measureMediaBytes } from "../../../src/library/media-metadata.ts";
import { createLibraryReader } from "../../../src/search/reader.ts";
import { toneWav } from "../../../test/fixtures/wav.ts";
import { SearchIndex } from "../src/find.ts";
import { ScriptedEmbedder } from "../src/scripted.ts";
import { writeLibrary } from "./helpers/core-library.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const RATE = 8000;

test("measureMediaBytes reads a WAV's duration, rate and channels", () => {
  const bytes = toneWav({ sampleRate: RATE, channels: 2, length: RATE * 15 });
  assert.deepEqual(measureMediaBytes(bytes, hash(bytes)), {
    format: "assetgrove-media/1",
    sha256: hash(bytes),
    status: "available",
    mediaType: "audio/wav",
    durationS: 15,
    sampleRate: RATE,
    channels: 2,
  });
  const cut = bytes.subarray(0, 20);
  assert.deepEqual(measureMediaBytes(cut, hash(cut)), {
    format: "assetgrove-media/1",
    sha256: hash(cut),
    status: "unavailable",
    reason: "invalid_media",
  });
});

test("search finds audio by card text, kind, form, duration and tempo", async (t) => {
  const project = tempProject();
  t.after(() => project.close());
  writeLibrary(project.dir);
  const root = join(project.dir, "assets");
  const cards = [
    {
      id: "victory-sting",
      kind: "music",
      form: "cue",
      title: "Victory sting",
      seconds: 15,
    },
    { id: "door-slam", kind: "sfx", title: "Door slam", seconds: 1 },
    {
      id: "forest-theme",
      kind: "music",
      form: "track",
      tempo: 120,
      title: "Forest theme",
      seconds: 30,
    },
  ];
  for (const c of cards) {
    const bytes = toneWav({ sampleRate: RATE, length: RATE * c.seconds });
    writeFileSync(join(root, `${c.id}.wav`), bytes);
    writeFileSync(
      join(root, `${c.id}.md`),
      [
        "---",
        "type: Game Asset",
        "format: assetgrove-card/1",
        `title: ${c.title}`,
        `resource: ${c.id}.wav`,
        `kind: ${c.kind}`,
        ...(c.form ? [`form: ${c.form}`] : []),
        ...(c.tempo ? [`tempo: ${c.tempo}`] : []),
        `lock: { sha256: "${hash(bytes)}" }`,
        "---",
        "",
      ].join("\n"),
    );
  }
  const reader = await createLibraryReader({
    dir: project.dir,
    stateDir: project.stateDir,
    settings: { folders: [], candidates: false },
  });
  const index = await SearchIndex.open({
    dir: join(project.stateDir, "audio"),
    worktree: project.dir,
    library: reader,
    embedder: new ScriptedEmbedder(),
  });
  t.after(() => index.close());
  const ids = async (query: Parameters<typeof index.find>[0]) =>
    (await index.find(query)).hits.map((h) => h.address.split("/").at(-1)).sort();
  const audio = ["door-slam", "forest-theme", "victory-sting"];
  // Words rank every row the filters keep; the card whose text matches comes first.
  const first = async (query: Parameters<typeof index.find>[0]) =>
    (await index.find(query)).hits[0]?.address.split("/").at(-1);
  assert.equal(await first({ words: "victory", where: "kind=music" }), "victory-sting");
  assert.deepEqual(await ids({ where: "kind=music" }), ["forest-theme", "victory-sting"]);
  assert.deepEqual(await ids({ where: "form=cue" }), ["victory-sting"]);
  assert.equal(await first({ words: "cue" }), "victory-sting");
  assert.deepEqual(await ids({ where: ["kind=music", "durationS<20"] }), ["victory-sting"]);
  assert.deepEqual(await ids({ where: ["durationS>=15", "durationS<=15"] }), ["victory-sting"]);
  assert.deepEqual(await ids({ where: "durationS>10" }), ["forest-theme", "victory-sting"]);
  assert.deepEqual(await ids({ where: "tempo>=100" }), ["forest-theme"]);
  assert.deepEqual(await ids({ where: "tempo=120" }), ["forest-theme"]);
  const hit = (await index.find({ where: "form=cue" })).hits[0]!;
  assert.equal(hit.fields.durationS, 15);
  assert.equal(hit.fields.form, "cue");
  assert.equal(hit.fields.mediaType, "audio/wav");
  const all = (await index.find({ where: "durationS>0", limit: 50 })).hits;
  assert.deepEqual(all.map((h) => h.address.split("/").at(-1)).sort(), audio);
});
