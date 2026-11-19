/**
 * A model-written card summary is card text (#432): after `card describe` writes one through core,
 * a word that appears only in that description is found by `find` (words), and an index rebuilt
 * from scratch answers the same. The scripted embedder and a provider script keep it offline.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { extensionContext, tempProject } from "@clockgrove/assetgrove/testing";
import searchExtension from "../src/extension.ts";
import { GAME, drawSubject, writeLibrary } from "./helpers/core-library.ts";
import { WORD } from "./fixtures/describe-script.ts";

const script = fileURLToPath(new URL("./fixtures/describe-script.ts", import.meta.url));
const project = tempProject();
const home = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-search-describe-")));
const runs = join(home, "runs");
after(async () => {
  project.close();
  await rm(home, { recursive: true, force: true });
});

const extensions = [searchExtension(extensionContext("search"))];
const { raster } = extensionContext("search-describe-test");
const git = (...args: string[]) => execFileSync("git", args, { cwd: project.dir, stdio: "ignore" });

writeLibrary(project.dir);
// A card with no description: the case `card describe` fills.
const card = join(project.dir, "assets", "kettle.md");
writeFileSync(join(project.dir, "assets", "kettle.png"), raster.encodePng(drawSubject(44, 3)));
writeFileSync(
  card,
  [
    "---",
    "type: Game Asset",
    "format: assetgrove-card/1",
    "title: Kettle",
    "resource: kettle.png",
    "sources:",
    "  - { id: review, resource: kettle.review.json }",
    "kind: still",
    "subject: kettle",
    "state: pending",
    "---",
    "",
  ].join("\n"),
);
// The library's root index and the kettle's review record, as a pick would have left them.
writeFileSync(
  join(project.dir, "assets", "index.md"),
  `---\nokf_version: 0.2\ntype: Asset Library\ngame: ${GAME}\n---\n\n# ${GAME}\n`,
);
writeFileSync(
  join(project.dir, "assets", "kettle.review.json"),
  [
    "{",
    '"@context": ["http://www.w3.org/ns/anno.jsonld",{"ag":"https://github.com/clockgrove/assetgrove/ns/review#"}],',
    `"id": "asset://${GAME}/kettle/review",`,
    '"type": "AnnotationCollection",',
    '"ag:format": "assetgrove-review/1",',
    '"ag:versions": [',
    `{"sha256":"${"a".repeat(64)}","at":"2026-11-18T00:00:00Z"}`,
    "],",
    '"first": { "type": "AnnotationPage", "items": [',
    "] }",
    "}",
    "",
  ].join("\n"),
);
git("add", "-A");
git("commit", "--quiet", "-m", "a card with no description");
project.writeSettings({ search: { embedder: "scripted" } }, { attended: true });

async function run(name: string, args: Record<string, unknown>) {
  const outcome = await project.run(
    name,
    { target: project.dir, ...args },
    { extensions, confirm: () => true },
  );
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.error ?? outcome.fields));
  return outcome;
}

type Hit = { address: string; score: number; sharedText: { description?: string } };

test("a word only in a model-written description is found by find, and a rebuilt index matches", async () => {
  const kettle = `asset://${GAME}/kettle`;
  assert.ok(!readFileSync(card, "utf8").includes(WORD));

  const described = await run("card describe", { address: card, providerScript: script, runs });
  assert.deepEqual(
    (described.fields["described"] as { asset: string }[]).map((d) => d.asset),
    ["kettle"],
  );
  const text = readFileSync(card, "utf8");
  assert.match(text, new RegExp(`description: .*${WORD}`));
  assert.match(text, /process:assetgrove-summary:vision:/);
  git("add", "-A");
  git("commit", "--quiet", "-m", "described");

  const found = (await run("find", { words: WORD })).fields["hits"] as Hit[];
  assert.equal(found[0]?.address, kettle);
  assert.match(String(found[0]?.sharedText.description), new RegExp(WORD));

  await run("search index", { rebuild: true });
  const again = (await run("find", { words: WORD })).fields["hits"] as Hit[];
  assert.deepEqual(
    again.map((h) => [h.address, h.score]),
    found.map((h) => [h.address, h.score]),
  );
});
