import assert from "node:assert/strict";
import test from "node:test";

import type { DecisionAnswer, DecisionQuestion } from "../src/gateway/provider.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";

const facing: DecisionQuestion = {
  type: "choice",
  instructions: "Which way does it face?",
  options: { "0": "front", "90": "right", "180": "back", "270": "left", unclear: "cannot tell" },
};
const identity: DecisionQuestion = { type: "score", instructions: "Same?", levels: ["no", "yes"] };

function provider(answer: DecisionAnswer): ScriptedProvider {
  return new ScriptedProvider({
    image: () => {
      throw new Error("unused");
    },
    vision: () => {
      throw new Error("unused");
    },
    decide: () => ({ answer, costUsd: 0 }),
  });
}

function ask(p: ScriptedProvider, question: DecisionQuestion, operation: string) {
  return p.decide({ model: "m", prompt: "", images: [], question, operation });
}

test("a choice outside the options is refused naming the operation, type and options", async () => {
  const p = provider({ type: "choice", choice: "north" });
  await assert.rejects(ask(p, facing, "model3d-facing"), {
    message:
      'the provider script\'s decide() answered the model3d-facing choice question with a choice "north", not one of its options: 0, 90, 180, 270, unclear (docs/generation-knobs.md lists every decision a provider script answers)',
  });
});

test("a boolean answer to a score question is refused naming both types", async () => {
  const p = provider({ type: "boolean", probability: 1 });
  await assert.rejects(ask(p, identity, "identity"), {
    message:
      "the provider script's decide() answered the identity score question with a boolean answer, not a score answer (docs/generation-knobs.md lists every decision a provider script answers)",
  });
});

test("a boolean answer to a choice question is refused naming the options", async () => {
  const p = provider({ type: "boolean", probability: 1 });
  await assert.rejects(ask(p, facing, "model3d-facing"), {
    message:
      "the provider script's decide() answered the model3d-facing choice question with a boolean answer, not a choice answer; its options: 0, 90, 180, 270, unclear (docs/generation-knobs.md lists every decision a provider script answers)",
  });
});

test("a choice that is one of the options is returned", async () => {
  const p = provider({ type: "choice", choice: "90" });
  const result = await ask(p, facing, "model3d-facing");
  assert.deepEqual(result.answer, { type: "choice", choice: "90" });
});
