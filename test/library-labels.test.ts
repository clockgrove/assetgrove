import "./fixtures/env.ts";
import { execFileSync } from "node:child_process";
import { stateDir } from "./fixtures/env.ts";
import { createLibraryReader } from "../src/search/reader.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { libraryLabelsCommand } from "../src/commands/labels.ts";
import { runFind } from "../src/commands/search.ts";
import { ExtensionRegistry } from "../src/extensions/registry.ts";
import { readLibrary, rebuildLibrary } from "../src/library/maintain.ts";
import { cardEditCommand } from "../src/commands/card.ts";
import { loadSettings } from "../src/settings.ts";
import { canonicalLabels, labelFilters, parseVocabulary } from "../src/library/labels.ts";
import {
  applySummary,
  parseCard,
  refreshFromReview,
  setPersonFields,
  writeCard,
} from "../src/library/card.ts";
import { matchingSummaryEntry, summaryEntry, summaryState } from "../src/library/summary.ts";
import { parseReview } from "../src/library/review.ts";
import { openProject, loadAssets } from "../src/tree/project.ts";
import { readTree } from "../src/tree/read.ts";
import { fixtureLibrary, GAME } from "./fixtures/library.ts";

const vocabulary = {
  format: "assetgrove-labels/1",
  labels: [
    { name: "object", aliases: ["prop", "props", "old-object"] },
    { name: "light", aliases: ["lamp"] },
  ],
};
const ctx = () => ({ settings: loadSettings(), log: () => {} });

test("label migration previews without writes, preserves unknowns and author attribution, and applies idempotently", async () => {
  const lib = fixtureLibrary();
  try {
    writeFileSync(join(lib.dir, ".assetgrove/labels.json"), JSON.stringify(vocabulary));
    const path = join(lib.root, "lantern.md");
    let card = parseCard(readFileSync(path, "utf8"), path);
    const summary = {
      description: "A brass lantern.",
      tags: ["prop", "props", "light", "unmapped"],
    };
    // A pre-vocabulary machine summary is a migration input.
    const entry = summaryEntry(summary, "vision", "synthetic/model", "2026-11-19T00:00:00Z");
    card = setPersonFields(card, summary, undefined, path);
    card = {
      ...card,
      entries: card.entries.map((e) =>
        e.key === "verified" ? { key: e.key, text: `verified: ${JSON.stringify([entry])}\n` } : e,
      ),
    };
    writeFileSync(path, writeCard(card));
    const humanPath = join(lib.root, "rock.md");
    const humanBase = parseCard(readFileSync(humanPath, "utf8"), humanPath);
    const original = { description: "A rock.", tags: ["object"] };
    const machine = applySummary(
      humanBase,
      original,
      summaryEntry(original, "vision", "synthetic/model", "2026-11-19T00:00:00Z"),
      humanPath,
    );
    writeFileSync(
      humanPath,
      writeCard(setPersonFields(machine, { tags: ["props"] }, undefined, humanPath)),
    );
    const before = readFileSync(path, "utf8");
    const preview = await libraryLabelsCommand.run({ target: lib.dir }, ctx());
    assert.equal(readFileSync(path, "utf8"), before);
    assert.ok((preview.fields.affected as { card: string }[]).some((c) => c.card === path));
    assert.ok((preview.fields.unknown as { value: string }[]).some((v) => v.value === "unmapped"));
    const applied = await libraryLabelsCommand.run({ target: lib.dir, apply: true }, ctx());
    assert.ok((applied.fields.files as string[]).includes(path));
    assert.equal(
      summaryState(parseCard(readFileSync(humanPath, "utf8"), humanPath).data).state,
      "person",
    );
    const migrated = parseCard(readFileSync(path, "utf8"), path);
    assert.deepEqual(migrated.data.tags, ["object", "light", "unmapped"]);
    assert.equal(migrated.body, parseCard(before, path).body);
    assert.equal(matchingSummaryEntry(migrated.data)?.by, entry.by);
    const review = parseReview(
      readFileSync(join(lib.root, "lantern.review.json"), "utf8"),
      "review",
    );
    assert.equal(summaryState(refreshFromReview(migrated, review, path).data).state, "machine");
    const project = await openProject(lib.dir, ctx().settings.stateDir);
    await rebuildLibrary(await readLibrary(project.profile, lib.dir));
    assert.equal(summaryState(parseCard(readFileSync(path, "utf8"), path).data).state, "machine");
    assert.equal(
      summaryState(parseCard(readFileSync(humanPath, "utf8"), humanPath).data).state,
      "person",
    );
    const again = await libraryLabelsCommand.run({ target: lib.dir, apply: true }, ctx());
    assert.deepEqual(again.fields.files, []);
    assert.deepEqual(again.fields.affected, []);
    await cardEditCommand.run({ address: path, label: ["props", "lamp", "unmapped"] }, ctx());
    const edited = parseCard(readFileSync(path, "utf8"), path);
    assert.deepEqual(edited.data.tags, ["object", "light", "unmapped"]);
    assert.equal(summaryState(edited.data).state, "person");
    assert.equal(summaryState(refreshFromReview(edited, review, path).data).state, "person");
    await assert.rejects(
      cardEditCommand.run({ address: path, label: ["invented"] }, ctx()),
      /unknown label/,
    );
  } finally {
    await rm(lib.dir, { recursive: true, force: true });
  }
});

test("browse, model summaries and filter aliases share canonical labels; collisions block writes", async () => {
  const lib = fixtureLibrary();
  try {
    const config = join(lib.dir, ".assetgrove/labels.json");
    writeFileSync(config, JSON.stringify(vocabulary));
    const project = await openProject(lib.dir, ctx().settings.stateDir);
    assert.deepEqual(loadAssets(project).get("lantern")?.tags, ["object", "light"]);
    const result = await readTree(project, `asset://${GAME}/by-tag/props/`);
    assert.ok(JSON.stringify(result).includes("lantern"));
    const path = join(lib.root, "rock.md");
    const card = parseCard(readFileSync(path, "utf8"), path);
    const summary = { description: "A rock.", tags: ["props", "unknown", "lamp"] };
    const described = applySummary(
      card,
      summary,
      summaryEntry(summary, "vision", "synthetic/model", "2026-11-19T00:00:00Z"),
      path,
    );
    assert.deepEqual(described.data.tags, ["object", "light"]);
    assert.equal(summaryState(described.data).state, "machine");
    const extensions = new ExtensionRegistry([
      {
        extension: {
          api: 2,
          name: "label-search",
          search: {
            async find(query, context) {
              assert.deepEqual(query.where, ["tag=object"]);
              const rows = await context.library.list(["pick"]);
              assert.deepEqual(rows.find((row) => row.id === "lantern")?.tags, ["object", "light"]);
              return { hits: [], fresh: true, builtFrom: null };
            },
            async outliers() {
              return { members: 0, ranking: [] };
            },
            async index() {
              return {};
            },
            async status() {
              return {};
            },
          },
        },
        info: { package: "synthetic-label-search", version: "1.0.0", entry: null },
      },
    ]);
    await runFind(
      { target: lib.dir, where: ["label=props"] },
      { ...ctx(), extensions },
      { sheet: false },
    );
    const parsed = parseVocabulary(JSON.stringify(vocabulary), config);
    assert.deepEqual(labelFilters(["label=props", "tag=lamp", "kind=still"], parsed), [
      "tag=object",
      "tag=light",
      "kind=still",
    ]);
    assert.deepEqual(canonicalLabels(["OLD-OBJECT", "props", "unknown"], parsed), [
      "object",
      "unknown",
    ]);
    writeFileSync(
      config,
      JSON.stringify({
        ...vocabulary,
        labels: [...vocabulary.labels, { name: "other", aliases: ["props"] }],
      }),
    );
    const before = readFileSync(path, "utf8");
    const preview = await libraryLabelsCommand.run({ target: lib.dir }, ctx());
    assert.equal((preview.fields.collisions as unknown[]).length, 1);
    await assert.rejects(
      libraryLabelsCommand.run({ target: lib.dir, apply: true }, ctx()),
      /collisions/,
    );
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    await rm(lib.dir, { recursive: true, force: true });
  }
});

test("vocabulary-only renames invalidate a shared index and dirty vocabulary prevents publication", async () => {
  const lib = fixtureLibrary();
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: lib.dir, encoding: "utf8" },
    ).trim();
  try {
    git("add", "-A");
    git("commit", "-qm", "fixture");
    const reader = await createLibraryReader({
      dir: lib.dir,
      stateDir,
      settings: { folders: [], candidates: false },
    });
    const built = await reader.head();
    assert.deepEqual((await reader.list(["pick"])).find((r) => r.id === "lantern")?.tags, [
      "prop",
      "light",
    ]);
    writeFileSync(join(lib.dir, ".assetgrove/labels.json"), JSON.stringify(vocabulary));
    assert.equal(await reader.clean(), false);
    git("add", "-A");
    git("commit", "-qm", "rename label");
    assert.equal(await reader.clean(), true);
    assert.equal(await reader.changedSince(built), true);
    const renamed = await createLibraryReader({
      dir: lib.dir,
      stateDir,
      settings: { folders: [], candidates: false },
    });
    assert.deepEqual((await renamed.list(["pick"])).find((r) => r.id === "lantern")?.tags, [
      "object",
      "light",
    ]);
    writeFileSync(
      join(lib.dir, ".assetgrove/labels.json"),
      JSON.stringify({ ...vocabulary, labels: [] }),
    );
    assert.equal(await renamed.clean(), false);
  } finally {
    await rm(lib.dir, { recursive: true, force: true });
  }
});
