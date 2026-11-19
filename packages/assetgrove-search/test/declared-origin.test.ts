import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempProject } from "@clockgrove/assetgrove/testing";
import { createLibraryReader } from "../../../src/search/reader.ts";
import { connect } from "@lancedb/lancedb";
import { LanceStore, rowsTableName } from "../src/lance-store.ts";
import { SearchIndex } from "../src/find.ts";
import { ScriptedEmbedder } from "../src/scripted.ts";
import { writeLibrary } from "./helpers/core-library.ts";

test("declared origins persist through real Lance filters, evidence edits and rebuild", async (t) => {
  const project = tempProject();
  t.after(() => project.close());
  writeLibrary(project.dir);
  const path = join(project.dir, "assets", "lantern.md");
  const card = readFileSync(path, "utf8");
  const origin = {
    kind: "human-made",
    declaredKind: "human-made",
    evidence: "I drew this synthetic lantern by hand.",
    source: "https://example.invalid/lantern",
    license: "Only the supplied synthetic grant applies",
    digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation",
  };
  const writeOrigin = () =>
    writeFileSync(
      path,
      card.replace("\nresource:", `\norigin: ${JSON.stringify(origin)}\nresource:`),
    );
  writeOrigin();
  const reader = await createLibraryReader({
    dir: project.dir,
    stateDir: project.stateDir,
    settings: { folders: [], candidates: false },
  });
  const open = (name: string) =>
    SearchIndex.open({
      dir: join(project.stateDir, name),
      worktree: project.dir,
      library: reader,
      embedder: new ScriptedEmbedder(),
    });
  const index = await open("origin-index");
  t.after(() => index.close());
  const hit = (await index.find({ where: "origin=human-made" })).hits;
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.fields.originEvidence, origin.evidence);
  assert.equal(hit[0]!.fields.originSource, origin.source);
  assert.equal(hit[0]!.fields.originLicense, origin.license);
  assert.equal(hit[0]!.fields.digitalSourceType, origin.digitalSourceType);
  assert.equal((await index.find({ where: `originLicense=${origin.license}` })).hits.length, 1);
  assert.equal((await index.find({ where: "origin=third-party" })).hits.length, 0);
  assert.ok((await index.find({ where: "origin=unknown" })).hits.length > 0);
  const db = await connect(join(project.stateDir, "origin-index"));
  const table = await db.openTable(rowsTableName({ id: "scripted", revision: "1" }));
  await table.dropColumns([
    "origin",
    "declaredOrigin",
    "originEvidence",
    "originSource",
    "originLicense",
    "digitalSourceType",
  ]);
  const legacy = await LanceStore.open(join(project.stateDir, "origin-index"), {
    embedder: { id: "scripted", revision: "1", dimension: 8 },
  });
  assert.equal(
    (await legacy.query({ filter: [{ field: "origin", op: "=", value: "human-made" }], limit: 50 }))
      .length,
    0,
  );
  assert.ok(
    (await legacy.query({ filter: [{ field: "origin", op: "=", value: "unknown" }], limit: 50 }))
      .length > 0,
  );
  assert.ok(
    (
      await legacy.query({
        filter: [{ field: "originSource", op: "!=", value: "example" }],
        limit: 50,
      })
    ).length > 0,
  );
  origin.kind = "ai-generated";
  origin.declaredKind = "third-party";
  origin.evidence = "Original supplied source evidence, unchanged.";
  origin.digitalSourceType =
    "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia";
  writeOrigin();
  const updated = (await index.find({ where: "declaredOrigin=third-party" })).hits;
  assert.ok((await index.find({ where: "origin=unknown" })).hits.length > 0);
  assert.equal(updated.length, 1);
  assert.equal(updated[0]!.fields.origin, "ai-generated");
  assert.equal(updated[0]!.fields.declaredOrigin, "third-party");
  assert.equal(updated[0]!.fields.originEvidence, origin.evidence);
  assert.equal((await index.find({ where: "origin=human-made" })).hits.length, 0);
  const rebuilt = await open("origin-rebuilt");
  t.after(() => rebuilt.close());
  assert.deepEqual((await rebuilt.find({ where: "declaredOrigin=third-party" })).hits, updated);
});
