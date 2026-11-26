import assert from "node:assert/strict";
import { test } from "node:test";
import { InputError } from "../src/errors.ts";
import { FormatError } from "../src/formats.ts";
import {
  CardFieldOwnedError,
  MACHINE_FIELDS,
  checkCardPaths,
  isCardText,
  machineFields,
  newCard,
  parseCard,
  rewriteMachineFields,
  setPersonFields,
  writeCard,
  type MachineInput,
} from "../src/library/card.ts";
import { appendAnnotation, appendVersion, emptyReview } from "../src/library/review.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "9f2c".repeat(16);

const CARD = `---
type: Game Asset
format: assetgrove-card/1
title: Porch lantern
description: A brass lantern for the porch, lit.
resource: lantern-porch.png
tags: [prop, light]
generated: { by: "assetgrove/0.2.0 via openai:gpt-image-2", at: "2026-11-20T21:04:00Z" }
verified:
  - { by: "process:assetgrove-qa", at: "2026-11-20T21:04:30Z" }
  - { by: "human:developer", at: "2026-11-20T21:10:00Z", method: elicitation }
sources:
  - { id: provenance, resource: lantern-porch.png.provenance.json }
  - { id: review, resource: lantern-porch.review.json }
  - { id: bible, resource: ../BIBLE.md }
kind: still
subject: lantern
state: approved
version: 2
bible: "3"
license: CC-BY-4.0
lock: { sha256: "${SHA_B}", bible: "3" }
x-studio: # note
  owner: art
---

Used beside the front door; the glow should match the window light.
`;

test("a parsed card writes back byte-identical", () => {
  for (const text of [
    CARD,
    CARD.replace(/\n/g, "\r\n"),
    CARD.replace(/\n$/, ""),
    CARD.replace("---\n\nUsed", "---\nUsed"),
  ]) {
    assert.equal(writeCard(parseCard(text, "c.md")), text);
  }
});

function input(operator?: string): MachineInput {
  let review = emptyReview("lantern-porch.review.json");
  review = appendVersion(review, { sha256: SHA_A, at: "2026-11-20T21:00:00Z" });
  review = appendVersion(review, {
    sha256: SHA_B,
    at: "2026-11-20T21:10:00Z",
    ...(operator
      ? { confirmation: { method: "headless", operator } }
      : { confirmation: { method: "elicitation" } }),
  });
  review = appendAnnotation(review, {
    type: "Annotation",
    motivation: "assessing",
    created: "2026-11-20T21:11:00Z",
    target: { source: "lantern-porch.png", "ag:version": SHA_B },
    "ag:action": "approve",
  });
  return {
    resource: "lantern-porch.png",
    provenance: {
      route: "openai:gpt-image-2",
      bibleVersion: "3",
      license: "CC-BY-4.0",
      finishedAt: "2026-11-20T21:04:00Z",
    },
    provenanceResource: "lantern-porch.png.provenance.json",
    review,
    reviewResource: "lantern-porch.review.json",
    bibleResource: "../BIBLE.md",
    kind: "still",
    subject: "lantern",
    assetgrove: "0.2.0",
  };
}

const entryText = (card: ReturnType<typeof parseCard>, key: string) =>
  card.entries.find((e) => e.key === key)?.text;

test("rewriting machine fields keeps person fields, unknown fields and the body", () => {
  const stale = CARD.replace("state: approved", "state: rejected")
    .replace("version: 2", "version: 9")
    .replace(/lock: .*\n/, "");
  const before = parseCard(stale, "c.md");
  const fields = machineFields(input());
  const after = rewriteMachineFields(before, fields, "c.md");
  for (const key of ["title", "description", "tags", "x-studio"]) {
    assert.equal(entryText(after, key)?.trimEnd(), entryText(before, key)?.trimEnd());
  }
  assert.equal(after.body, before.body);
  for (const key of MACHINE_FIELDS) assert.deepEqual(after.data[key], fields[key]);
  assert.equal(after.data["state"], "approved");
  assert.equal(after.data["version"], 2);
  const text = writeCard(after);
  assert.equal(writeCard(rewriteMachineFields(parseCard(text, "c.md"), fields, "c.md")), text);
});

test("form and tempo are machine fields on a music card only; elsewhere a person's", () => {
  const still = parseCard(
    CARD.replace("kind: still", "kind: still\nform: round\ntempo: 3"),
    "c.md",
  );
  const fields = machineFields(input());
  const kept = rewriteMachineFields(still, fields, "c.md");
  assert.equal(kept.data["form"], "round");
  assert.equal(kept.data["tempo"], 3);
  const edited = setPersonFields(still, { form: "square", tempo: "slow" }, undefined, "c.md");
  assert.equal(edited.data["form"], "square");
  assert.equal(edited.data["tempo"], "slow");

  const music = parseCard(
    CARD.replace("kind: still", "kind: music\nform: cue\ntempo: 120"),
    "c.md",
  );
  for (const key of ["form", "tempo"]) {
    assert.throws(
      () => setPersonFields(music, { [key]: "x" }, undefined, "c.md"),
      CardFieldOwnedError,
    );
  }
  const rebuilt = rewriteMachineFields(music, { ...fields, kind: "music", form: "track" }, "c.md");
  assert.equal(rebuilt.data["form"], "track");
  assert.equal(rebuilt.data["tempo"], undefined);
});

test("a card already matching its records keeps its bytes", () => {
  const fields = machineFields(input());
  const card = newCard({ title: "Porch lantern", tags: ["prop"], body: "Hi\n" }, fields);
  const text = writeCard(card);
  assert.equal(writeCard(rewriteMachineFields(parseCard(text, "c.md"), fields, "c.md")), text);
  assert.match(text, /^verified:\n {2}- \{ by:/m);
  assert.match(text, /^lock: \{ sha256: /m);
});

test("a headless pick renders its operator", () => {
  const fields = machineFields(input("ci-bot"));
  assert.deepEqual((fields["verified"] as { by: string }[])[1]?.by, "process:headless:ci-bot");
  const card = newCard({ title: "t" }, fields);
  assert.match(writeCard(card), /process:headless:ci-bot/);
});

test("a review with no version has no card", () => {
  const data = input();
  data.review = emptyReview("r");
  assert.throws(() => machineFields(data), InputError);
});

test("paths leaving the library root are refused; the bible source is not followed", () => {
  const ok = parseCard(CARD, "c.md");
  checkCardPaths(ok, "/lib", "/lib/a", "c.md");
  for (const bad of [
    CARD.replace("resource: lantern-porch.png\n", "resource: ../../outside.png\n"),
    CARD.replace("resource: lantern-porch.review.json", "resource: /etc/passwd"),
  ]) {
    assert.throws(
      () => checkCardPaths(parseCard(bad, "c.md"), "/lib", "/lib/a", "c.md"),
      InputError,
    );
  }
});

test("a missing or too-new format is refused", () => {
  for (const text of [
    CARD.replace("format: assetgrove-card/1\n", ""),
    CARD.replace("card/1", "card/2"),
  ]) {
    assert.throws(
      () => parseCard(text, "c.md"),
      (error) => error instanceof FormatError && error.code === "format_unsupported",
    );
  }
});

test("front matter that is not a card is refused", () => {
  for (const text of ["no front matter", "---\n- a\n---\n", "---\na: 1\na: 2\n---\n"]) {
    assert.throws(() => parseCard(text, "c.md"), InputError);
  }
});

test("isCardText accepts type Game Asset only, and false for other text or broken YAML", () => {
  assert.equal(isCardText(CARD), true);
  assert.equal(isCardText("---\ntitle: Game Asset naming rules\n---\nGame Asset\n"), false);
  assert.equal(isCardText("---\ntype: [unclosed\n---\nbody\n"), false);
  assert.equal(isCardText("type: Game Asset\n"), false);
});
