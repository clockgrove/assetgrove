import assert from "node:assert/strict";
import { test } from "node:test";
import { spendRequest, spendShown } from "../src/runs/execute.ts";
import type { WorkPlan } from "../src/runs/plan.ts";

const base = { command: "request_change", jobs: [], forecastUsd: 0.5, capUsd: 2 };
const regions = ["10,10,20,20 frame 2 : tail darker", "0,0,5,5 : fix eye"];

test("spendShown lists each region in details and summary", () => {
  const shown = spendShown("id", { ...base, options: { region: regions } });
  assert.deepEqual(shown.details["regions"], regions);
  assert.match(
    shown.summary,
    /; regions: 1\) 10,10,20,20 frame 2 : tail darker; 2\) 0,0,5,5 : fix eye$/,
  );
});

test("spendShown without regions has no regions key", () => {
  const shown = spendShown("id", { ...base, options: {} });
  assert.equal("regions" in shown.details, false);
  assert.equal(shown.summary.includes("regions"), false);
});

test("spendRequest shows the regions of its plan", () => {
  const plan = {
    digest: "d",
    inputs: [],
    options: { region: regions },
    jobs: [],
    forecastUsd: 0.5,
    capUsd: 2,
    policyTextSha256: "p",
  } as unknown as WorkPlan;
  const request = spendRequest("request_change", 1, plan);
  assert.deepEqual(request.details["regions"], regions);
});
