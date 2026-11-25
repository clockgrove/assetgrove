/**
 * The kind through core's real path: a temporary project, the pack's entry registered, `stage`
 * answered by a provider script. A failing exact contrast check filters the candidate; the model
 * check `icons:identifiable` answering no stays advisory, as no stability entry qualifies it.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bibleMarkdown, sampleProfile, tempProject } from "@clockgrove/assetgrove/testing";
import type { TempProject } from "@clockgrove/assetgrove/testing";
import entry from "../src/extension.ts";
import { fill, iconOutput } from "./helpers/icons.ts";

const route = { provider: "scripted", model: "scripted/icons", estimatedCostUsd: 0.01 };
let project: TempProject;

before(() => {
  project = tempProject();
});
after(() => project.close());

/** A provider script whose image is a dark 16px icon and whose identify answer is `probability`. */
function writeScript(probability: number): string {
  const icon = iconOutput(16, (r) => fill(r, 4, 12, [0x2b, 0x2b, 0x2b, 255]));
  const path = join(project.dir, `script-${probability}.mjs`);
  writeFileSync(
    path,
    `const bytes = Buffer.from(${JSON.stringify(Buffer.from(icon.bytes).toString("base64"))}, "base64");
export default {
  image: () => ({ images: [{ mediaType: "image/png", bytes }] }),
  vision: () => ({ text: "{}" }),
  decide: () => ({ answer: { type: "boolean", probability: ${probability} } }),
};
`,
  );
  return path;
}

function stage(backgrounds: string[], probability: number, extra: Record<string, unknown> = {}) {
  project.writeSettings({ roles: { image: route, decisions: route } }, { attended: true });
  const write = (name: string, content: string) => {
    const path = join(project.dir, name);
    writeFileSync(path, content);
    return path;
  };
  mkdirSync(join(project.dir, "runs"), { recursive: true });
  return project.run(
    "stage",
    {
      spec: write("spec.json", JSON.stringify({ kind: "icons:family", assetId: "save" })),
      bible: write("BIBLE.md", bibleMarkdown()),
      profile: write(
        "profile.json",
        JSON.stringify(sampleProfile({ kinds: { "icons:family": { size: 16, backgrounds } } })),
      ),
      runs: join(project.dir, "runs"),
      providerScript: writeScript(probability),
      candidates: 1,
      ...extra,
    },
    { extensions: [entry], confirm: () => true },
  );
}

test("a failing contrast on one background filters the candidate on a stage run", async () => {
  const outcome = await stage(["#ffffff", "#1d2b35"], 0.9);
  assert.equal(outcome.error?.code, "qa_found_nothing", outcome.human);
  assert.equal(outcome.fields["filtered"], 1);
  assert.equal(
    (outcome.fields["candidates"] as unknown[]).length,
    0,
    "the same icon passes on #ffffff alone (next test)",
  );
});

test("a candidate passing contrast is kept; identifiable answering no stays advisory", async () => {
  const outcome = await stage(["#ffffff"], 0.1);
  assert.equal(outcome.exitCode, 0, outcome.human);
  assert.equal(outcome.fields["filtered"], 0);
  assert.deepEqual(outcome.fields["filtering"], [
    { check: "icons:identifiable", state: "advisory", cause: "no-entry" },
  ]);
  const [kept] = outcome.fields["candidates"] as Array<{
    reasons: Array<{ check: string; passed: boolean; shadow?: true }>;
  }>;
  const identifiable = kept?.reasons.find((r) => r.check === "icons:identifiable");
  assert.equal(identifiable?.passed, false);
  assert.equal(identifiable?.shadow, true);
  assert.ok(kept?.reasons.some((r) => r.check === "icons:boundary-contrast" && r.passed));
});

test("a profile without the kind's block is refused at plan as invalid_input", async () => {
  project.writeSettings({ roles: { image: route, decisions: route } }, { attended: true });
  const path = (name: string, content: string) => {
    writeFileSync(join(project.dir, name), content);
    return join(project.dir, name);
  };
  const outcome = await project.run(
    "stage",
    {
      spec: path("spec.json", JSON.stringify({ kind: "icons:family", assetId: "save" })),
      bible: path("BIBLE.md", bibleMarkdown()),
      profile: path("bare.json", JSON.stringify(sampleProfile())),
      runs: join(project.dir, "runs"),
      providerScript: writeScript(0.9),
      dryRun: true,
    },
    { extensions: [entry], confirm: () => true },
  );
  assert.notEqual(outcome.exitCode, 0);
  assert.equal(outcome.error?.code, "invalid_input");
  assert.match(outcome.error?.message ?? "", /kinds\["icons:family"\]/);
});
