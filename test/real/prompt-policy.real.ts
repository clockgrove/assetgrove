/**
 * Real check of the prompt policy against its red-team set (design section 16), run through the
 * product's spend controls under the shared budget of test/real/budget.ts. Each row goes through
 * the policy as a request does: the blocklist first, then, for a row it lets through, the model
 * check's decide call on the gateway's `prompt-policy` route. The check fails when the refusal
 * rate on must-refuse rows or the false-refusal rate on allowed rows misses the bars in the
 * fenced JSON block of docs/decisions.md ("Prompt-policy bars"). Skips without AI_GATEWAY_API_KEY.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { decidePromptPolicy } from "../../src/policy/model.ts";
import { checkPromptText } from "../../src/policy/text.ts";
import type { PolicyHit, PromptPart, PromptPartLabel } from "../../src/policy/text.ts";
import { defaultRoutes, PROMPT_POLICY_OPERATION } from "../../src/routes.ts";
import { realBudget, skipWithout } from "./budget.ts";

const skip = skipWithout("AI_GATEWAY_API_KEY");

interface Bars {
  minRefusalRate: number;
  maxFalseRefusalRate: number;
}

interface Row {
  id: string;
  prompt: string;
  part?: PromptPartLabel;
  expect: "refuse" | "allow";
}

/** The bars from the fenced JSON block of docs/decisions.md's "Prompt-policy bars" section. */
async function readBars(): Promise<Bars> {
  const text = await readFile(new URL("../../docs/decisions.md", import.meta.url), "utf8");
  const section = text.split(/^## /m).find((s) => s.startsWith("Prompt-policy bars"));
  const block = section && /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
  assert.ok(block, "docs/decisions.md has a Prompt-policy bars section with a JSON block");
  const bars = (JSON.parse(block) as { promptPolicy?: Bars }).promptPolicy;
  assert.ok(
    bars && typeof bars.minRefusalRate === "number" && typeof bars.maxFalseRefusalRate === "number",
    "the block sets promptPolicy.minRefusalRate and promptPolicy.maxFalseRefusalRate",
  );
  return bars;
}

async function readRows(): Promise<Row[]> {
  const text = await readFile(
    new URL("../fixtures/prompt-policy/red-team.jsonl", import.meta.url),
    "utf8",
  );
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);
}

test(
  "real gateway: the prompt policy meets its refusal and false-refusal bars on the red-team set",
  { skip },
  async () => {
    const bars = await readBars();
    const rows = await readRows();
    // The blocklist refuses unambiguous names for free, as it does before a request's confirmation;
    // every other row goes to the model with the hits the free check recorded.
    const partsOf = (r: Row): PromptPart[] => [{ label: r.part ?? "brief", text: r.prompt }];
    const records = new Map(rows.map((r) => [r.id, checkPromptText(partsOf(r))]));
    const toModel = rows.filter((r) => records.get(r.id)!.verdict === "allowed");
    const rb = realBudget();
    const gw = rb.provider("vercel-ai-gateway");
    const estimate = defaultRoutes[PROMPT_POLICY_OPERATION]!.estimatedCostUsd;
    const { caller } = rb.caller(gw, toModel.length * estimate, "real prompt-policy");
    const refused = new Map<string, boolean>();
    for (const r of rows) if (!toModel.includes(r)) refused.set(r.id, true);
    await rb.cleared("real prompt-policy", async () => {
      for (const r of toModel) {
        const verdict = await decidePromptPolicy(
          caller,
          partsOf(r),
          records.get(r.id)!.hits ?? ([] as PolicyHit[]),
        );
        refused.set(r.id, verdict.refused);
        console.log(`${r.id} ${r.expect}: ${verdict.probability.toFixed(3)}`);
      }
    });
    const rate = (expect: Row["expect"]) => {
      const of = rows.filter((r) => r.expect === expect);
      return of.filter((r) => refused.get(r.id)).length / of.length;
    };
    const refusalRate = rate("refuse");
    const falseRefusalRate = rate("allow");
    const missed = rows.filter((r) => r.expect === "refuse" && !refused.get(r.id)).map((r) => r.id);
    const wrong = rows.filter((r) => r.expect === "allow" && refused.get(r.id)).map((r) => r.id);
    console.log(
      JSON.stringify({ refusalRate, falseRefusalRate, bars, missed, falselyRefused: wrong }),
    );
    console.log(`budget left: $${rb.budgetLeftUsd().toFixed(4)}`);
    assert.ok(
      refusalRate >= bars.minRefusalRate,
      `refusal rate ${refusalRate.toFixed(3)} is under the bar ${bars.minRefusalRate}; missed: ${missed.join(", ")}`,
    );
    assert.ok(
      falseRefusalRate <= bars.maxFalseRefusalRate,
      `false-refusal rate ${falseRefusalRate.toFixed(3)} is over the bar ${bars.maxFalseRefusalRate}; refused: ${wrong.join(", ")}`,
    );
  },
);
