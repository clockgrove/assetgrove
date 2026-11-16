/**
 * #324: whether a brief overrides the style bible is judged by a model reading it against the
 * bible's protected fields, never by word patterns. Each sentence below runs on the scripted
 * provider with the scripted decision's answer for it.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { createPlan, planJobs } from "../src/planning.ts";
import type { CreatePlanOptions } from "../src/planning.ts";
import { InputError } from "../src/errors.ts";
import { failureOutcome } from "../src/commands/result.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import type { DecisionRequest } from "../src/gateway/provider.ts";
import { BRIEF_POLICY_OPERATION, briefPolicyAsked } from "../src/policy/brief.ts";
import type { BriefPolicyField, BriefPolicyTarget } from "../src/policy/brief.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** An all-ages bible whose content limits include "no war". */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "brief-policy-"));
  roots.push(root);
  const dir = join(root, ".assetgrove/art-direction");
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, ".assetgrove/prompts"), { recursive: true });
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.referenceLicense = "NOASSERTION";
  data.world = "Woodland";
  data.tone.audience = "all-ages";
  data.tone.contentLimits = ["no war", "no gore"];
  const biblePath = join(dir, "BIBLE.md");
  await writeFile(biblePath, serializeBible(data, "## Do's and Don'ts\nDo keep shapes soft.\n"));
  await writeFile(
    join(root, ".assetgrove/prompts/default.md"),
    "# Prompt template v1\n{{constitution}}\n{{spec}}\n{{brief}}\n{{settings}}\n{{family}}\n",
  );
  let n = 0;
  const write = async (name: string, value: object) => {
    const path = join(root, `${name}-${++n}.json`);
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const options = async (
    brief: object | undefined,
    rest: Partial<CreatePlanOptions> = {},
  ): Promise<CreatePlanOptions> => ({
    biblePath,
    specPath: await write("spec", { kind: "still", assetId: "den" }),
    runOptionsPath: await write("run-options", { candidates: 1 }),
    ...(brief && { briefPath: await write("brief", brief) }),
    ...rest,
  });
  return { data, options };
}

type Answers = Partial<Record<BriefPolicyField, number>>;

/**
 * A scripted provider: the compiler writes `compilerPrompt`; the brief-policy decision answers
 * from `brief` for the author's brief and `compiler` for the compiler's text (0 when absent).
 */
function provider(answers: { brief?: Answers; compiler?: Answers }, compilerPrompt?: string) {
  const asked: Array<{
    field: BriefPolicyField;
    target: BriefPolicyTarget;
    request: DecisionRequest;
  }> = [];
  const scripted = new ScriptedProvider({
    image: () => {
      throw new Error("planning generates no image");
    },
    vision: () => ({
      text: JSON.stringify({
        prompt: compilerPrompt ?? "a small original woodland den",
        negativePrompt: "no lettering",
        violations: [],
        clamps: [],
      }),
    }),
    briefPolicy: (request) => {
      const { field, target } = briefPolicyAsked(request.prompt)!;
      asked.push({ field, target, request });
      return { answer: { type: "boolean", probability: answers[target]?.[field] ?? 0 } };
    },
  });
  return { scripted, asked };
}

/** Each sentence of the issue that describes an asset, with the model's (scripted) answer: none. */
const DESCRIPTIONS = [
  "A field mouse with chunky proportions",
  "a small house drawn in the bible palette",
  "sunset over the pond with the warm palette",
  "The player can change outfits at this wardrobe; keep the palette calm",
  "An adult badger leading two cubs",
  "a mature oak tree",
  "blood orange tree",
  "a warm lantern beside the wardrobe",
];

test("plain descriptions that only mention protected words are accepted", async () => {
  const f = await fixture();
  for (const context of DESCRIPTIONS) {
    const { scripted, asked } = provider({});
    const created = await createPlan(await f.options({ context }, { provider: scripted }));
    assert.equal(created.compiler.mode, "llm", context);
    assert.ok(created.plan.prompts.generation.includes(context), context);
    // One decision per protected field on the brief and one on the compiler's text.
    const fields = ["palette", "audience", "proportions", "contentLimits"];
    assert.deepEqual(
      asked.filter((a) => a.target === "brief").map((a) => a.field),
      fields,
      context,
    );
    assert.deepEqual(
      created.briefPolicy.map((v) => [v.target, v.field, v.probability, v.objects]),
      [
        ...fields.map((field) => ["brief", field, 0, false]),
        ...fields.map((field) => ["compiler", field, 0, false]),
      ],
    );
    assert.ok(created.briefPolicy.every((v) => v.model.includes(":brief-policy:")));
  }
});

test("the model is given the brief's free text, the protected fields and the content limits", async () => {
  const f = await fixture();
  const { scripted, asked } = provider({});
  await createPlan(
    await f.options(
      { purpose: "inventory icon", context: "a mature oak tree", neighbouringAssets: ["lantern"] },
      { provider: scripted },
    ),
  );
  const { request } = asked.find((a) => a.target === "brief" && a.field === "contentLimits")!;
  assert.equal(request.operation, BRIEF_POLICY_OPERATION);
  assert.equal(request.question.type, "boolean");
  for (const part of [
    "purpose:\n<<<\ninventory icon\n>>>",
    "context:\n<<<\na mature oak tree\n>>>",
    "neighbouringAssets[0]:\n<<<\nlantern\n>>>",
    '"audience":"all-ages"',
    '"contentLimits":["no war","no gore"]',
    `"proportions":${JSON.stringify(f.data.axes.proportions)}`,
    '"palette":["#',
  ])
    assert.ok(request.prompt.includes(part), part);
});

test("a brief that asks to depart from the palette is refused, naming the field", async () => {
  const f = await fixture();
  const { scripted } = provider({ brief: { palette: 0.93 } });
  await assert.rejects(
    createPlan(
      await f.options({ context: "Paint her in crimson and navy instead" }, { provider: scripted }),
    ),
    (error) => {
      assert.ok(error instanceof InputError);
      assert.match(error.message, /protected field palette \(probability 0\.93\)/);
      assert.equal(failureOutcome(error).error?.code, "invalid_input");
      return true;
    },
  );
  // Refused before the compiler is called.
  assert.equal(scripted.calls.filter((c) => c.kind === "vision").length, 0);
});

test("compiler text the check objects to is dropped for the template, with the reason", async () => {
  const f = await fixture();
  // The compiler's own wording passes when the model reads it as no departure...
  const kept = provider({}, "use the palette swatch colours only");
  const accepted = await createPlan(await f.options(undefined, { provider: kept.scripted }));
  assert.equal(accepted.compiler.mode, "llm");
  assert.equal(accepted.compiler.output.prompt, "use the palette swatch colours only");
  // ...and when the model objects, the plan falls back to the template; it never fails.
  const objected = provider({ compiler: { palette: 0.8 } }, "paint it neon green and hot pink");
  const created = await createPlan(await f.options(undefined, { provider: objected.scripted }));
  assert.equal(created.compiler.mode, "template-fallback");
  assert.match(created.compiler.fallbackReason!, /palette \(brief-policy probability 0\.80\)/);
  assert.ok(!created.plan.prompts.generation.includes("neon green"));
  assert.ok(created.briefPolicy.some((v) => v.target === "compiler" && v.objects));
});

test("the constitution is appended after all model-written text", async () => {
  const f = await fixture();
  const { scripted } = provider({}, "a small original woodland den");
  const created = await createPlan(
    await f.options({ context: "a mature oak tree" }, { provider: scripted }),
  );
  const generation = created.plan.prompts.generation;
  const model = generation.indexOf("a small original woodland den");
  const constitution = generation.indexOf("Constitution (immutable;");
  assert.ok(model === 0 && constitution > model);
});

test("the free plan step forecasts the brief-policy calls and makes none", async () => {
  const f = await fixture();
  const { scripted, asked } = provider({});
  const forecast = await planJobs(
    await f.options({ context: "a mature oak tree" }, { provider: scripted }),
  );
  assert.equal(scripted.calls.length, 0);
  const job = forecast.jobs.find((j) => j.operation === BRIEF_POLICY_OPERATION)!;
  // Four fields, on the brief and on the compiler's text.
  assert.equal(job.count, 8);
  await createPlan(await f.options({ context: "a mature oak tree" }, { provider: scripted }));
  assert.equal(asked.length, job.count);
  // No brief text: the compiler's text only.
  const bare = await planJobs(await f.options(undefined, { provider: scripted }));
  assert.equal(bare.jobs.find((j) => j.operation === BRIEF_POLICY_OPERATION)?.count, 4);
});

test("a brief with free text and no provider fails closed; structural overrides stay exact", async () => {
  const f = await fixture();
  await assert.rejects(createPlan(await f.options({ context: "a mature oak tree" })), {
    name: "ProviderError",
  });
  const { scripted } = provider({});
  await assert.rejects(
    createPlan(await f.options({ palette: ["#ff0000"] }, { provider: scripted })),
    /unsupported brief field palette/,
  );
  await assert.rejects(
    createPlan(await f.options({ adjustments: { audience: "teen" } }, { provider: scripted })),
    /cannot adjust constitutional field audience/,
  );
  assert.equal(scripted.calls.length, 0);
});
