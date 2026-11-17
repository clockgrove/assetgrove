import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../src/errors.ts";
import { ClipMapCache, clipPlan, resolveClipPlan } from "../src/model3d/clip-map.ts";
import type { CharacterSpec } from "../src/model3d/profile.ts";
import type { Route } from "../src/routes.ts";

const route = {
  model: "lib/model",
  estimatedCostUsd: 0.2,
  library: {
    biped: {
      walk: { clip: "preset:walk", loop: true },
      slash: { clip: "preset:slash", loop: false },
    },
    quadruped: {},
  },
} as unknown as Route;

function character(gait: string, clips: string[]): CharacterSpec {
  return { gait, clips } as unknown as CharacterSpec;
}

/** A caller whose decisions answer from `answers` (family to choice and probability). */
function fake(answers: Record<string, { choice: string; probability?: number }>) {
  const asked: string[] = [];
  const call = {
    route: () => route,
    async decide(operation: string, prompt: string) {
      assert.equal(operation, "clip-map");
      const family = /Requested animation: "([^"]*)"/.exec(prompt)?.[1] ?? "";
      asked.push(family);
      const a = answers[family] ?? { choice: "none" };
      return {
        result: { answer: { type: "choice", choice: a.choice } },
        record: {
          model: "decider",
          decision: a.probability !== undefined ? { value: a.probability } : {},
        },
      };
    },
  };
  return { call: call as never, asked };
}

test("exact keys are planned with no decision; others are decided once per run", async () => {
  const { call, asked } = fake({
    attack: { choice: "slash", probability: 0.8 },
    dance: { choice: "walk", probability: 0.2 },
    wave: { choice: "walk" },
    ghost: { choice: "none" },
  });
  const cache = new ClipMapCache();
  const spec = character("biped", ["walk", "attack", "dance", "wave", "ghost"]);
  const plan = await resolveClipPlan(call, spec, "clips3d", cache);
  assert.deepEqual(
    plan.planned.map((p) => [p.family, p.clip, p.loop]),
    [
      ["walk", "preset:walk", true],
      ["attack", "preset:slash", false],
    ],
  );
  assert.deepEqual(
    plan.mapped.map((m) => [m.family, m.key, m.probability]),
    [["attack", "slash", 0.8]],
  );
  assert.match(plan.missing[0]!.why, /chose walk with probability 0\.20, under 0\.5/);
  assert.match(plan.missing[1]!.why, /chose walk with no probability reported/);
  assert.match(
    plan.missing[2]!.why,
    /library has no close biped clip for "ghost"; .*answered none/,
  );
  assert.deepEqual(asked, ["attack", "dance", "wave", "ghost"]);
  await resolveClipPlan(call, spec, "clips3d", cache);
  assert.equal(asked.length, 4, "the second candidate reuses the run's decisions");
});

test("a gait with no library clips makes no decision", async () => {
  const { call, asked } = fake({});
  const plan = await resolveClipPlan(
    call,
    character("quadruped", ["idle"]),
    "clips3d",
    new ClipMapCache(),
  );
  assert.equal(asked.length, 0);
  assert.equal(plan.missing.length, 1);
  assert.deepEqual(clipPlan(character("quadruped", ["idle"]), route).planned, []);
});

test("an answer outside the options is a provider error", async () => {
  const { call } = fake({ attack: { choice: "teleport" } });
  await assert.rejects(
    resolveClipPlan(call, character("biped", ["attack"]), "clips3d", new ClipMapCache()),
    ProviderError,
  );
});
