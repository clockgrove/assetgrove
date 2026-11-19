import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProfile } from "../src/profile.ts";
import { evaluateProjectRules, enforceProjectRules } from "../src/project-rules.ts";

test("project rule schema rejects executable and configuration fields", () => {
  for (const field of ["endpoint", "code", "credentials", "spend"]) {
    assert.throws(
      () =>
        validateProfile(
          {
            format: "assetgrove-target-profile/2",
            rules: [
              {
                id: "role",
                kind: "required",
                source: "spec",
                field: "fields.role",
                [field]: "unsafe",
              },
            ],
          },
          "fixture",
        ),
      /invalid/,
    );
  }
});

test("required spec rules enforce exact values and report unavailable evidence", () => {
  const profile = validateProfile(
    {
      format: "assetgrove-target-profile/2",
      rules: [
        { id: "role", kind: "required", source: "spec", field: "fields.role", values: ["actor"] },
        { id: "size", kind: "media", metric: "bytes", max: 10 },
      ],
    },
    "fixture",
  );
  const findings = evaluateProjectRules({
    rules: profile.rules,
    asset: "fern",
    spec: { fields: { role: "prop" } },
  });
  assert.deepEqual(findings, [
    { rule: "role", asset: "fern", severity: "error", evidence: "spec", status: "failed" },
    { rule: "size", asset: "fern", severity: "error", evidence: "media", status: "unavailable" },
  ]);
  assert.throws(() => enforceProjectRules(findings), /role: fern/);
});

test("warnings retain rule and asset and measured budgets fail only with evidence", () => {
  const profile = validateProfile(
    {
      format: "assetgrove-target-profile/2",
      rules: [
        {
          id: "labels",
          kind: "labels",
          required: ["actor"],
          allowed: ["actor"],
          severity: "warning",
        },
        { id: "width", kind: "media", metric: "width", max: 64 },
      ],
    },
    "fixture",
  );
  const findings = evaluateProjectRules({
    rules: profile.rules,
    asset: "fern",
    card: { tags: ["prop"] },
  });
  assert.equal(findings[0]?.status, "failed");
  assert.equal(findings[0]?.severity, "warning");
  assert.doesNotThrow(() => enforceProjectRules(findings));
  assert.throws(
    () =>
      enforceProjectRules(
        evaluateProjectRules({ rules: profile.rules, asset: "fern", media: { width: 65 } }),
      ),
    /width: fern/,
  );
});

test("planning refuses a required spec violation before provider or template access", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { BIBLE_PRESETS, serializeBible } = await import("../src/bible.ts");
  const { createPlan } = await import("../src/planning.ts");
  const root = await mkdtemp(join(tmpdir(), "project-rules-"));
  try {
    const biblePath = join(root, "BIBLE.md");
    const specPath = join(root, "spec.json");
    const profilePath = join(root, "profile.json");
    await writeFile(
      biblePath,
      serializeBible(
        { ...BIBLE_PRESETS["cozy-storybook"]!, referenceLicense: "NOASSERTION" },
        "# Synthetic fixture\n\n## Do's and Don'ts\nDo preserve silhouettes. Don't add text.\n",
      ),
    );
    await writeFile(specPath, JSON.stringify({ kind: "still", assetId: "fern" }));
    await writeFile(
      profilePath,
      JSON.stringify({
        format: "assetgrove-target-profile/2",
        rules: [{ id: "role", kind: "required", source: "spec", field: "fields.role" }],
      }),
    );
    await assert.rejects(
      createPlan({ biblePath, specPath, profilePath }),
      /project rule role: fern \(spec\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planning and forecast expose warnings and unavailable card/media evidence", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { BIBLE_PRESETS, serializeBible } = await import("../src/bible.ts");
  const { createPlan, planJobs } = await import("../src/planning.ts");
  const { createRaster, encodePng } = await import("../src/image/raster.ts");
  const root = await mkdtemp(join(tmpdir(), "project-rules-plan-"));
  try {
    const biblePath = join(root, "BIBLE.md");
    const specPath = join(root, "spec.json");
    const profilePath = join(root, "profile.json");
    const templatePath = join(root, "template.md");
    await writeFile(join(root, "reference.png"), encodePng(createRaster(2, 2)));
    const bible = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
    bible.referenceLicense = "NOASSERTION";
    bible.anchors.positive = [{ path: "reference.png", role: "subject", subject: "fern" }];
    bible.perspective = "reference.png";
    await writeFile(
      biblePath,
      serializeBible(bible, "## Do's and Don'ts\nDo preserve silhouettes. Don't add text.\n"),
    );
    await writeFile(
      templatePath,
      "# Prompt template v1\n{{constitution}}\n{{spec}}\n{{brief}}\n{{settings}}\n{{family}}\n",
    );
    await writeFile(
      specPath,
      JSON.stringify({ kind: "still", assetId: "fern", animationFamily: "idle" }),
    );
    const { syntheticProfile } = await import("./fixtures/synthetic.ts");
    await writeFile(
      profilePath,
      JSON.stringify({
        ...syntheticProfile(),
        format: "assetgrove-target-profile/2",
        rules: [
          {
            id: "role",
            kind: "required",
            source: "spec",
            field: "fields.role",
            severity: "warning",
          },
          { id: "title", kind: "required", source: "card", field: "title" },
          { id: "bytes", kind: "media", metric: "bytes", max: 1 },
        ],
      }),
    );
    const options = { biblePath, specPath, profilePath, templatePath };
    const expected = [
      { rule: "role", asset: "fern", severity: "warning", evidence: "spec", status: "failed" },
      { rule: "title", asset: "fern", severity: "error", evidence: "card", status: "unavailable" },
      { rule: "bytes", asset: "fern", severity: "error", evidence: "media", status: "unavailable" },
    ];
    assert.deepEqual((await planJobs(options)).ruleFindings, expected);
    assert.deepEqual((await createPlan(options)).ruleFindings, expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
