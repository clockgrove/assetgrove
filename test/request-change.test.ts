/**
 * `request-change` (issue #238, design section 3.4): regions on a picked asset's current version
 * become a run of candidates through a masked edit, a whole-image edit, fix-frame's path or another
 * 3D round; picking one appends the version with answers naming the requests.
 */
import { approve, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pickCommand } from "../src/commands/pick.ts";
import { requestChangeCommand } from "../src/commands/request-change.ts";
import { reviewCommand } from "../src/commands/review.ts";
import { stageCommand } from "../src/commands/stage.ts";
import { runCommand } from "../src/commands/runner.ts";
import type { RunContext } from "../src/commands/types.ts";
import type { ConfirmPort, ConfirmRequest } from "../src/confirm/prompt.ts";
import { writeToTarget } from "../src/handoff.ts";
import { EXTENSION_API } from "../src/extension/api.ts";
import { CORE_ENTRY, ExtensionRegistry, checkExtension } from "../src/extensions/registry.ts";
import type { Generator } from "../src/generators/generator.ts";
import { createRaster, decodePng, encodePng, getPixel, setPixel } from "../src/image/raster.ts";
import { BIBLE_PATH } from "../src/init.ts";
import { parseReview, versionStatus } from "../src/library/review.ts";
import { readRun } from "../src/loop.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { packageBlocklist } from "../src/policy/blocklist.ts";
import { providerSet } from "../src/providers/index.ts";
import { loadSettings } from "../src/settings.ts";
import type { AssetSpec, Provenance, StyleBible, TargetProfile } from "../src/types.ts";
import { libraryProfile } from "./fixtures/library.ts";
import { gitTarget } from "./fixtures/git.ts";
import { PALETTE, drawSubject, writeStyleBible } from "./fixtures/synthetic.ts";

const RASTER = new URL("../src/image/raster.ts", import.meta.url).href;

const provenance: Provenance = {
  digitalSourceType: DIGITAL_SOURCE_TYPES.generated,
  generator: "still",
  route: "scripted",
  models: ["model-a"],
  prompt: "a lamp",
  parameters: {},
  requestIds: [],
  referenceHashes: [],
  bibleVersion: "synthetic-1",
  license: "MIT",
  providerTerms: [],
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  costUsd: 0,
  calls: [],
};

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function flat(w: number, h: number, rgb = [90, 120, 160]) {
  const r = createRaster(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(r, x, y, [...rgb, 255]);
  return r;
}

/** A project with a picked asset `lamp` (version 1 from run r1) and the run that made it. */
async function project(spec: AssetSpec = { kind: "still", assetId: "lamp" }, media = flat(40, 40)) {
  const dir = gitTarget(await mkdtemp(join(tmpdir(), "assetgrove-request-change-")));
  const profile: TargetProfile = libraryProfile();
  await writeToTarget({
    profile,
    spec,
    bibleVersion: "synthetic-1",
    output: { bytes: encodePng(media), mediaType: "image/png", extension: "png", fields: {} },
    provenance,
    run: { runId: "r1", candidateId: "c1", pickedAt: "2026-01-01T00:00:02.000Z" },
    targetDir: dir,
  });
  const runs = join(dir, ".assetgrove/runs");
  await mkdir(join(runs, "r1"), { recursive: true });
  await writeFile(
    join(runs, "r1", "run.json"),
    JSON.stringify({
      runId: "r1",
      createdAt: "2026-01-01T00:00:00.000Z",
      spec,
      specDir: dir,
      profile,
      bibleVersion: "synthetic-1",
      candidates: [{ id: "c1", fields: {}, provenance, mediaType: "image/png", extension: "png" }],
    }),
  );
  const id = readdirSync(join(dir, "assets")).find((f) => f.endsWith(".review.json"))!;
  const card = join(dir, "assets", id.replace(/\.review\.json$/, ".md"));
  const review = join(dir, "assets", id);
  return { dir, card, review, runs };
}

/**
 * A provider script that logs each image call (prompt, mask hash, reference count) and answers
 * with the current version (reference 1) painted red in its top-left 10×10 corner, plus `outside`
 * painted pixels at the bottom right.
 */
async function script(
  dir: string,
  options: { mask?: boolean; outside?: number; template?: string } = {},
) {
  const path = join(dir, `script-${options.mask === false ? "plain" : "mask"}.mjs`);
  const events = `${path}.events`;
  const answer = `${path}.template.json`;
  await writeFile(
    path,
    `import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeImage, encodePng, setPixel } from ${JSON.stringify(RASTER)};
export default {
  paid: true,
  ${options.mask === false ? 'capabilities: ["image", "edit", "vision", "decide"],' : ""}
  image: (r) => {
    appendFileSync(${JSON.stringify(events)}, JSON.stringify({
      prompt: r.prompt,
      references: r.references.length,
      mask: r.mask ? createHash("sha256").update(r.mask.bytes).digest("hex") : null,
    }) + "\\n");
    const image = decodeImage(r.references[0].bytes);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) setPixel(image, x, y, [250, 10, 10, 255]);
    for (let i = 0; i < ${options.outside ?? 0}; i++) setPixel(image, image.width - 1 - (i % 20), image.height - 1 - Math.floor(i / 20), [0, 250, 0, 255]);
    return { images: [{ mediaType: "image/png", bytes: encodePng(image) }] };
  },
  vision: () => ({ text: "ok" }),
  decide: () => ({ answer: { type: "choice", choice: "area" }, costUsd: 0.001 }),
  promptPolicy: () => ({ answer: { type: "boolean", probability: 0 } }),
  ${options.template !== undefined ? `motionTemplate: () => ({ answer: { type: "choice", choice: JSON.parse(readFileSync(${JSON.stringify(answer)}, "utf8")) }, costUsd: 0.001 }),` : ""}
};`,
  );
  if (options.template !== undefined) await writeFile(answer, JSON.stringify(options.template));
  approve(path);
  const calls = async (): Promise<
    Array<{ prompt: string; references: number; mask: string | null }>
  > =>
    existsSync(events)
      ? (await readFile(events, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  return { path, calls };
}

const context = (prompt?: ConfirmPort): RunContext => ({
  settings: loadSettings(),
  log: () => {},
  ...(prompt && { prompt }),
});

async function inProject<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await body();
  } finally {
    process.chdir(before);
  }
}

const CHECKED_KIND = "edit-probe:tile";

function checkedContext(over: Partial<Generator>): RunContext {
  const extension = checkExtension(
    {
      api: EXTENSION_API,
      name: "edit-probe",
      kinds: [
        {
          kind: CHECKED_KIND,
          planCandidate: () => [],
          async generate() {
            throw new Error("request-change edits the picked version instead of generating anew");
          },
          ...over,
        },
      ],
    },
    "change check fixture",
  );
  return {
    ...context(),
    extensions: new ExtensionRegistry([
      CORE_ENTRY,
      { extension, info: { package: "edit-probe", version: "1.0.0", entry: "fixture" } },
    ]),
  };
}

for (const requiredRed of [250, 90]) {
  test(`an edited tile ${requiredRed === 250 ? "passing" : "failing"} its exact check ${requiredRed === 250 ? "is staged" : "is listed without staging"}`, async () => {
    const p = await project({ kind: CHECKED_KIND, assetId: "lamp" });
    const s = await script(p.dir);
    const biblePath = join(p.dir, BIBLE_PATH);
    const ctx = checkedContext({
      checks: [
        {
          name: "edit-tile-marker",
          mode: "exact",
          run: (input) => {
            assert.equal(input.spec.kind, CHECKED_KIND);
            assert.equal(input.profile.name, libraryProfile().name);
            assert.equal(input.bible.version, "synthetic-1");
            const [red] = getPixel(decodePng(input.output.bytes), 0, 0);
            return [
              {
                check: "edit-tile-marker",
                passed: red === requiredRed,
                reason: `expected red ${requiredRed}, edited pixel has red ${red}`,
                source: "deterministic",
              },
            ];
          },
        },
      ],
    });
    await inProject(p.dir, async () => {
      const args = {
        address: p.card,
        region: ["0,0,10,10 : make the corner red"],
        runs: p.runs,
        providerScript: s.path,
        candidates: 1,
      };
      const missing = await runCommand(requestChangeCommand, { ...args, dryRun: true }, ctx);
      assert.match(missing.error?.message ?? "", /style bible given with --bible/);
      assert.equal((await s.calls()).length, 0);
      await mkdir(dirname(biblePath), { recursive: true });
      await writeStyleBible(biblePath, {
        version: "synthetic-1",
        palette: ["#fa0a0a"],
        references: [],
      });
      const preview = await runCommand(requestChangeCommand, { ...args, dryRun: true }, ctx);
      assert.equal(preview.exitCode, 0, preview.error?.message);
      const inputs = preview.fields["inputs"] as Record<string, string>;
      assert.equal(inputs["bible"], sha(await readFile(biblePath)));
      assert.match(inputs["kindChecks"]!, /^[a-f0-9]{64}$/);
      const outcome = await runCommand(requestChangeCommand, args, ctx);
      const dir = outcome.fields["runDir"] as string;
      const run = await readRun(dir);
      assert.equal((await s.calls()).length, 1);
      if (requiredRed === 250) {
        assert.equal(outcome.exitCode, 0, outcome.error?.message);
        assert.equal(run.candidates[0]?.reasons[0]?.passed, true);
        assert.equal(run.filtered, 0);
        assert.ok(existsSync(join(dir, "c1.png")));
        return;
      }
      assert.equal(outcome.error?.code, "qa_found_nothing");
      assert.equal(run.candidates.length, 0);
      assert.equal(run.filtered, 1);
      assert.equal(run.rejections?.[0]?.candidate, 1);
      assert.equal(run.rejections[0]!.reasons[0]?.passed, false);
      assert.deepEqual(outcome.fields["rejections"], run.rejections);
      assert.match(outcome.human, /candidate 1 filtered: edit-tile-marker: .*red 250/);
      for (const file of ["c1.png", "c1.provenance.json", "contact.png", "compare.png"])
        assert.ok(!existsSync(join(dir, file)), `rejected c1 did not write ${file}`);
      const pick = await runCommand(pickCommand, { run: dir, candidate: "c1", target: p.dir }, ctx);
      assert.match(pick.error?.message ?? "", /is not a QA-passing candidate/);
    });
  });
}

for (const stable of [false, true]) {
  test(`a failing ${stable ? "qualified" : "unqualified"} model check of an edited candidate ${stable ? "filters" : "remains advisory"}`, async () => {
    const p = await project({ kind: CHECKED_KIND, assetId: "lamp" });
    const s = await script(p.dir);
    const bible = await writeStyleBible(join(p.dir, "BIBLE.md"), {
      version: "synthetic-1",
      palette: ["#fa0a0a"],
      references: [],
    });
    const { model, estimatedCostUsd } = (await providerSet(s.path, context())).routes.vision;
    const ctx = checkedContext({
      operations: { "edit-probe:inspect": "vision" },
      planCandidate: (_spec, _profile, routes) =>
        ["still", "vision", "edit-probe:inspect"].map((operation) => ({
          operation,
          model: routes[operation]!.model,
          estimatedCostUsd: 0,
        })),
      checks: [
        {
          name: "edit-tile-look",
          mode: "model",
          operation: "vision",
          source: "vision",
          async run({ output }, call) {
            assert.equal(
              await call.vision("edit-probe:inspect", "Inspect the tile shape.", []),
              "ok",
            );
            const text = await call.vision("vision", "Inspect the edited tile.", [
              { role: "edit", path: "edit", ...output, sha256: sha(output.bytes) },
            ]);
            assert.equal(text, "ok");
            return [
              {
                check: "edit-tile-look",
                passed: false,
                reason: "the model did not like the edited tile",
                source: "vision",
              },
            ];
          },
        },
      ],
      ...(stable && {
        stability: [
          {
            checkId: "edit-tile-look",
            version: "1",
            model,
            cases: 40,
            passCases: 20,
            failCases: 20,
            falsePasses: 1,
            falseFails: 2,
            repeats: 3,
            agreement: 0.95,
            measuredAt: "2026-11-14T00:00:00.000Z",
            measuredBy: "synthetic fixture",
            labelledSetSha256: "a".repeat(64),
          },
        ],
      }),
    });
    await inProject(p.dir, async () => {
      const args = {
        address: p.card,
        region: ["0,0,10,10 : make the corner red"],
        runs: p.runs,
        providerScript: s.path,
        candidates: 1,
        bible,
      };
      const preview = await runCommand(requestChangeCommand, { ...args, dryRun: true }, ctx);
      assert.equal(preview.exitCode, 0, preview.error?.message);
      const jobs = preview.fields["jobs"] as Array<{
        operation: string;
        count: number;
        estimatedCostUsd: number;
      }>;
      const visionJob = jobs.find((job) => job.operation === "vision");
      assert.equal(visionJob?.count, 1);
      assert.equal(visionJob?.estimatedCostUsd, estimatedCostUsd);
      assert.equal(jobs.find((job) => job.operation === "edit-probe:inspect")?.count, 1);
      assert.equal(jobs.find((job) => job.operation === "still")?.count, 1);
      assert.equal((await s.calls()).length, 0);
      const outcome = await runCommand(requestChangeCommand, args, ctx);
      const run = await readRun(outcome.fields["runDir"] as string);
      assert.equal(run.filtering?.[0]?.state, stable ? "filtering" : "advisory");
      if (stable) {
        assert.equal(outcome.error?.code, "qa_found_nothing");
        assert.equal(run.candidates.length, 0);
        assert.equal(run.rejections?.[0]?.reasons[0]?.shadow, undefined);
      } else {
        assert.equal(outcome.exitCode, 0, outcome.error?.message);
        const [candidate] = run.candidates;
        assert.equal(candidate?.reasons[0]?.shadow, true);
        assert.deepEqual(
          candidate?.provenance.calls.map((call) => call.operation),
          ["edit", "edit-probe:inspect", "vision"],
        );
        assert.equal(run.rejections, undefined);
      }
    });
  });
}

test("a model check cannot spend beyond its planned call count", async () => {
  const p = await project({ kind: CHECKED_KIND, assetId: "lamp" });
  const s = await script(p.dir);
  const bible = await writeStyleBible(join(p.dir, "BIBLE.md"), {
    version: "synthetic-1",
    palette: ["#fa0a0a"],
    references: [],
  });
  const ctx = checkedContext({
    planCandidate: (_spec, _profile, routes) => [{ ...routes.vision, operation: "vision" }],
    checks: [
      {
        name: "edit-tile-look",
        mode: "model",
        operation: "vision",
        async run(_input, call) {
          await call.vision("vision", "First inspection", []);
          await call.vision("vision", "Second inspection", []);
          return [];
        },
      },
    ],
  });
  await inProject(p.dir, async () => {
    const outcome = await runCommand(
      requestChangeCommand,
      {
        address: p.card,
        region: ["0,0,10,10 : make the corner red"],
        runs: p.runs,
        providerScript: s.path,
        candidates: 1,
        bible,
      },
      ctx,
    );
    assert.match(outcome.error?.message ?? "", /vision call was refused.*confirmed plan/);
    const dir = outcome.fields["runDir"] as string;
    const callsDir = join(dir, "calls");
    const records = await Promise.all(
      readdirSync(callsDir)
        .filter((file) => file.endsWith(".json"))
        .map(
          async (file) =>
            JSON.parse(await readFile(join(callsDir, file), "utf8")) as { operation: string },
        ),
    );
    assert.equal(records.filter(({ operation }) => operation === "vision").length, 1);
    assert.ok(!existsSync(join(dir, "c1.png")));
  });
});

test("changing source fields after a change check is confirmed refuses before annotation or edit", async () => {
  const p = await project({ kind: CHECKED_KIND, assetId: "lamp" });
  const s = await script(p.dir);
  const bible = await writeStyleBible(join(p.dir, "custom-bible.md"), {
    version: "synthetic-1",
    palette: ["#fa0a0a"],
    references: [],
  });
  const review = await readFile(p.review, "utf8");
  const sourceDir = join(p.runs, "r1");
  useAttended();
  const ctx = checkedContext({
    checks: [{ name: "edit-tile-size", mode: "exact", run: () => [] }],
  });
  const prompt: ConfirmPort = {
    method: "tty",
    async confirm(request) {
      assert.equal(request.kind, "spend");
      const source = await readRun(sourceDir);
      source.candidates[0]!.fields["tileSize"] = 24;
      await writeFile(join(sourceDir, "run.json"), JSON.stringify(source));
      return true;
    },
  };
  await inProject(p.dir, async () => {
    const outcome = await runCommand(
      requestChangeCommand,
      {
        address: p.card,
        region: ["0,0,10,10 : make the corner red"],
        runs: p.runs,
        providerScript: s.path,
        candidates: 1,
        bible,
      },
      { ...ctx, prompt },
    );
    assert.equal(outcome.error?.code, "plan_changed", outcome.error?.message);
    assert.equal((await s.calls()).length, 0);
    assert.equal(await readFile(p.review, "utf8"), review);
  });
});

test("a box region on a still with a mask-capable route makes masked edits; the run is recorded, compared and resumed", async () => {
  const p = await project();
  const s = await script(p.dir);
  const ref = join(p.dir, "ref.png");
  await writeFile(ref, encodePng(flat(8, 8, [10, 200, 10])));
  const args = {
    address: p.card,
    region: ["0,0,10,10 ref ref.png : the lamp glass redder"],
    runs: p.runs,
    providerScript: s.path,
  };
  await inProject(p.dir, async () => {
    const dry = await runCommand(requestChangeCommand, { ...args, dryRun: true }, context());
    assert.equal(dry.exitCode, 0, dry.error?.message);
    assert.equal((dry.fields["plan"] as { job: string }).job, "masked-edit");
    const jobs = dry.fields["jobs"] as Array<{ operation: string; count: number }>;
    assert.equal(jobs.find((j) => j.operation === "edit")!.count, 2);
    assert.equal(dry.fields["candidates"], 2);
    assert.equal((await s.calls()).length, 0, "the plan step makes no call");

    const done = await runCommand(requestChangeCommand, args, context());
    assert.equal(done.exitCode, 0, done.error?.message);
    const f = done.fields as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(f.job, "masked-edit");
    assert.equal(f.reused, false);
    const calls = await s.calls();
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.ok(call.mask, "the edit call carries a mask");
      assert.equal(call.references, 2, "the version and the region's reference");
      assert.match(call.prompt, /the lamp glass redder/);
    }
    // The box mask: opaque white inside the 10×10 box, transparent outside.
    assert.ok(existsSync(join(f.runDir, "compare.png")));
    assert.ok(existsSync(join(f.runDir, "contact.png")));
    assert.equal(f.candidates.length, 2);
    for (const c of f.candidates) {
      assert.equal(c.outsideChange, 0);
      assert.deepEqual(c.reasons, []);
    }
    // The request is an editing annotation; the version turns changes-requested.
    const record = parseReview(await readFile(p.review, "utf8"), p.review);
    const v1 = record.versions[0]!.sha256;
    assert.equal(versionStatus(record, v1), "changes-requested");
    const editing = record.annotations.filter((a) => a.motivation === "editing");
    assert.equal(editing.length, 1);
    assert.deepEqual(
      f.requests.map((r: { id: string }) => r.id),
      editing.map((a) => a.id),
    );
    const target = editing[0]!.target as Record<string, unknown>;
    assert.equal(target["ag:version"], v1);
    // The 10 px box on the 40×40 still is recorded in percent, so it fits a version of another size.
    assert.equal((target["selector"] as { value: string }).value, "xywh=percent:0,0,25,25");
    // The reference is copied beside the record under its sha256.
    const refSha = sha(await readFile(ref));
    const copied = join(p.dir, "assets", "lamp.review", `${refSha}.png`);
    assert.ok(existsSync(copied), copied);
    assert.match(JSON.stringify(editing[0]!.body), new RegExp(`lamp.review/${refSha}.png`));
    // The run's record names the request, so a pick answers it.
    const run = JSON.parse(await readFile(join(f.runDir, "run.json"), "utf8"));
    assert.deepEqual(run.changeRequest, {
      asset: "lamp",
      version: v1,
      answers: editing.map((a) => a.id),
    });

    // The same request again: the finished run, no call, no new annotation.
    const again = await runCommand(requestChangeCommand, args, context());
    assert.equal(again.exitCode, 0, again.error?.message);
    assert.equal(again.fields["reused"], true);
    assert.equal((await s.calls()).length, 2);
    const after = parseReview(await readFile(p.review, "utf8"), p.review);
    assert.equal(after.annotations.filter((a) => a.motivation === "editing").length, 1);
  });
});

test("a mask=PATH region sends that file; changing a region, note, mask or reference changes the digest", async () => {
  const p = await project();
  const s = await script(p.dir);
  const mask = flat(40, 40, [0, 0, 0]);
  for (let y = 0; y < 12; y++)
    for (let x = 0; x < 12; x++) setPixel(mask, x, y, [255, 255, 255, 255]);
  await writeFile(join(p.dir, "mask.png"), encodePng(mask));
  const mask2 = flat(40, 40, [0, 0, 0]);
  setPixel(mask2, 1, 1, [255, 255, 255, 255]);
  await writeFile(join(p.dir, "mask2.png"), encodePng(mask2));
  await writeFile(join(p.dir, "ref.png"), encodePng(flat(8, 8, [10, 200, 10])));
  await writeFile(join(p.dir, "ref2.png"), encodePng(flat(8, 8, [200, 10, 10])));
  const base = { address: p.card, runs: p.runs, providerScript: s.path, dryRun: true };
  await inProject(p.dir, async () => {
    const digest = async (region: string) => {
      const out = await runCommand(requestChangeCommand, { ...base, region: [region] }, context());
      assert.equal(out.exitCode, 0, out.error?.message);
      return out.fields["digest"] as string;
    };
    const digests = [
      await digest("mask=mask.png ref ref.png : redder"),
      await digest("mask=mask.png ref ref.png : bluer"),
      await digest("mask=mask2.png ref ref.png : redder"),
      await digest("mask=mask.png ref ref2.png : redder"),
      await digest("0,0,12,12 ref ref.png : redder"),
    ];
    assert.equal(new Set(digests).size, digests.length, "each change is another request");
    // The same file, changed on disk, is another request too.
    await writeFile(join(p.dir, "ref.png"), encodePng(flat(8, 8, [10, 10, 200])));
    assert.notEqual(await digest("mask=mask.png ref ref.png : redder"), digests[0]);

    const done = await runCommand(
      requestChangeCommand,
      { ...base, dryRun: false, region: ["mask=mask.png : redder"], candidates: 1 },
      context(),
    );
    assert.equal(done.exitCode, 0, done.error?.message);
    const [call] = await s.calls();
    assert.equal(call!.mask, sha(await readFile(join(p.dir, "mask.png"))), "the file itself");
    const record = parseReview(await readFile(p.review, "utf8"), p.review);
    const target = record.annotations.find((a) => a.motivation === "editing")!.target as Record<
      string,
      unknown
    >;
    const maskSha = sha(await readFile(join(p.dir, "mask.png")));
    assert.equal(target["ag:mask"], `lamp.review/${maskSha}.png`);
    assert.ok(existsSync(join(p.dir, "assets", "lamp.review", `${maskSha}.png`)));
  });
});

test("without the mask capability the job edits the whole image with the note; a change outside the region is advised", async () => {
  const p = await project();
  const s = await script(p.dir, { mask: false, outside: 200 });
  await inProject(p.dir, async () => {
    const done = await runCommand(
      requestChangeCommand,
      {
        address: p.card,
        region: ["0%,0%,25%,25% : warmer glow"],
        keepRest: true,
        candidates: 1,
        runs: p.runs,
        providerScript: s.path,
      },
      context(),
    );
    assert.equal(done.exitCode, 0, done.error?.message);
    const f = done.fields as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(f.job, "edit");
    const [call] = await s.calls();
    assert.equal(call!.mask, null, "no mask is sent");
    assert.match(call!.prompt, /warmer glow/);
    assert.match(call!.prompt, /Keep everything outside these areas/);
    const [candidate] = f.candidates;
    assert.ok(candidate.outsideChange > 0.05);
    assert.equal(candidate.reasons[0].check, "changed_outside_region");
    const record = parseReview(await readFile(p.review, "utf8"), p.review);
    const target = record.annotations.find((a) => a.motivation === "editing")!.target as Record<
      string,
      unknown
    >;
    assert.equal((target["selector"] as { value: string }).value, "xywh=percent:0,0,25,25");
  });
});

test("the spend form shows each region and note; a blocklisted note exits 9 before confirmation", async () => {
  const p = await project();
  const s = await script(p.dir);
  useAttended();
  const asked: ConfirmRequest[] = [];
  const port: ConfirmPort = {
    method: "tty",
    confirm: async (request) => {
      asked.push(request);
      return false;
    },
  };
  const regions = ["0,0,10,10 : glass redder", "20,20,10,10 : base darker"];
  await inProject(p.dir, async () => {
    const declined = await runCommand(
      requestChangeCommand,
      { address: p.card, region: regions, runs: p.runs, providerScript: s.path },
      context(port),
    );
    assert.notEqual(declined.exitCode, 0);
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.kind, "spend");
    assert.deepEqual(asked[0]!.details["regions"], regions);
    assert.match(asked[0]!.summary, /glass redder/);
    assert.match(asked[0]!.summary, /base darker/);
    assert.equal((await s.calls()).length, 0);

    const term = packageBlocklist().terms.find(
      (t) => t.kind === "artist" && t.term.includes(" "),
    )!.term;
    const refused = await runCommand(
      requestChangeCommand,
      {
        address: p.card,
        region: [`0,0,10,10 : in the style of ${term}`],
        runs: p.runs,
        providerScript: s.path,
      },
      context(port),
    );
    assert.equal(refused.exitCode, 9, refused.error?.message);
    assert.equal(refused.error?.code, "prompt_refused");
    assert.equal(asked.length, 1, "no confirmation was asked");
    assert.equal((await s.calls()).length, 0);
    // Nothing was recorded on the version.
    const record = parseReview(await readFile(p.review, "utf8"), p.review);
    assert.equal(record.annotations.filter((a) => a.motivation === "editing").length, 0);
  });
});

test("picking a candidate appends the version answering the request and logs it; one made on an older version exits 2 version_changed", async () => {
  const p = await project();
  const s = await script(p.dir);
  await inProject(p.dir, async () => {
    const request = async (note: string) => {
      const out = await runCommand(
        requestChangeCommand,
        {
          address: p.card,
          region: [`0,0,10,10 : ${note}`],
          candidates: 1,
          runs: p.runs,
          providerScript: s.path,
        },
        context(),
      );
      assert.equal(out.exitCode, 0, out.error?.message);
      return out.fields as { runDir: string; requests: Array<{ id: string }> };
    };
    const first = await request("glass redder");
    const second = await request("base darker");
    const picked = await runCommand(
      pickCommand,
      { run: first.runDir, candidate: "c1", target: p.dir },
      context(),
    );
    assert.equal(picked.exitCode, 0, picked.error?.message);
    const record = parseReview(await readFile(p.review, "utf8"), p.review);
    assert.equal(record.versions.length, 2);
    assert.deepEqual(
      record.versions[1]!.answers,
      first.requests.map((r) => r.id),
    );
    assert.equal(versionStatus(record, record.versions[1]!.sha256), "pending");
    const log = await readFile(join(p.dir, "assets", "log.md"), "utf8");
    assert.match(log, new RegExp(`answer .*answers ${first.requests[0]!.id}`));
    const moderating = record.annotations.find(
      (a) => (a as { "ag:action"?: string })["ag:action"] === "answer",
    )!;
    assert.equal(moderating.body, undefined, "the answer is recorded only in versions[].answers");

    // Re-picking the same candidate completes the pick again: no version_changed, no new version.
    const again = await runCommand(
      pickCommand,
      { run: first.runDir, candidate: "c1", target: p.dir },
      context(),
    );
    assert.equal(again.exitCode, 0, again.error?.message);
    assert.equal(parseReview(await readFile(p.review, "utf8"), p.review).versions.length, 2);

    const stale = await runCommand(
      pickCommand,
      { run: second.runDir, candidate: "c1", target: p.dir },
      context(),
    );
    assert.equal(stale.exitCode, 2, stale.error?.message);
    assert.equal(stale.error?.code, "version_changed");
    assert.equal(parseReview(await readFile(p.review, "utf8"), p.review).versions.length, 2);
  });
});

test("a frame region edits only that frame, through fix-frame's path", async () => {
  // Four 32 px frames, each a figure on a transparent background.
  const strip = createRaster(128, 32);
  for (let i = 0; i < 4; i++)
    for (let y = 12; y < 30; y++)
      for (let x = i * 32 + 10; x < i * 32 + 20; x++)
        setPixel(strip, x, y, [60 + i * 30, 90, 140, 255]);
  const p = await project(
    { kind: "sprite-strip", assetId: "walker", animationFamily: "walk" },
    strip,
  );
  const s = await script(p.dir);
  await inProject(p.dir, async () => {
    const done = await runCommand(
      requestChangeCommand,
      {
        address: p.card,
        region: ["0,0,16,16 frame 3 : raise the paw"],
        candidates: 1,
        runs: p.runs,
        providerScript: s.path,
      },
      context(),
    );
    assert.equal(done.exitCode, 0, done.error?.message);
    const f = done.fields as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(f.job, "fix-frame");
    assert.deepEqual(f.requests[0].frame, 3);
    const calls = await s.calls();
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.prompt, /frame 3 of 4/);
    assert.match(calls[0]!.prompt, /raise the paw/);
    const after = decodePng(await readFile(join(f.runDir, f.candidates[0].file)));
    assert.equal(after.width, 128);
    const frameOf = (r: { width: number; data: Uint8Array }, i: number) => {
      const rows: number[] = [];
      for (let y = 0; y < 32; y++)
        rows.push(...r.data.subarray((y * r.width + i * 32) * 4, (y * r.width + i * 32 + 32) * 4));
      return rows;
    };
    for (const i of [0, 1, 3])
      assert.deepEqual(frameOf(after, i), frameOf(strip, i), `frame ${i + 1}`);
    assert.notDeepEqual(frameOf(after, 2), frameOf(strip, 2), "frame 3 changed");
    assert.equal(typeof f.candidates[0].outsideChange, "number");
    assert.ok(existsSync(join(f.runDir, "compare.png")));
  });
});

test("a frame region's dry run confirms the fix-scale decision with the edit, one per candidate and frame", async () => {
  const strip = createRaster(128, 32);
  for (let i = 0; i < 4; i++)
    for (let y = 12; y < 30; y++)
      for (let x = i * 32 + 10; x < i * 32 + 20; x++)
        setPixel(strip, x, y, [60 + i * 30, 90, 140, 255]);
  const p = await project(
    { kind: "sprite-strip", assetId: "walker", animationFamily: "walk" },
    strip,
  );
  const s = await script(p.dir);
  await inProject(p.dir, async () => {
    const dry = await runCommand(
      requestChangeCommand,
      {
        address: p.card,
        region: ["0,0,16,16 frame 2 : lift the tail", "0,0,16,16 frame 3 : raise the paw"],
        candidates: 2,
        runs: p.runs,
        providerScript: s.path,
        dryRun: true,
      },
      context(),
    );
    assert.equal(dry.exitCode, 0, dry.error?.message);
    assert.equal((dry.fields["plan"] as { job: string }).job, "fix-frame");
    const jobs = dry.fields["jobs"] as Array<{
      operation: string;
      count: number;
      estimatedCostUsd: number;
    }>;
    // Two candidates, each fixing frames 2 and 3: four edits and up to four size decisions.
    assert.equal(jobs.find((j) => j.operation === "edit")?.count, 4);
    assert.equal(jobs.find((j) => j.operation === "fix-scale")?.count, 4);
    // The forecast a person confirms is the sum over these jobs, so it carries the size decisions.
    const forecast = dry.fields["forecastUsd"] as number;
    const scale = jobs.find((j) => j.operation === "fix-scale")!;
    assert.ok(scale.estimatedCostUsd > 0, "the size decision is priced");
    const sum = jobs.reduce((total, j) => total + j.count * j.estimatedCostUsd, 0);
    assert.ok(Math.abs(forecast - sum) < 1e-9, `forecast ${forecast} is the jobs' sum ${sum}`);
    assert.equal((await s.calls()).length, 0, "the plan step makes no call");
  });
});

test("a frame region of a family no template names makes one motion-template decision, recorded in every candidate's provenance", async () => {
  const strip = createRaster(128, 32);
  for (let i = 0; i < 4; i++)
    for (let y = 12; y < 30; y++)
      for (let x = i * 32 + 10; x < i * 32 + 20; x++)
        setPixel(strip, x, y, [60 + i * 30, 90, 140, 255]);
  const p = await project(
    { kind: "sprite-strip", assetId: "walker", animationFamily: "trot" },
    strip,
  );
  const s = await script(p.dir, { template: "walk" });
  await inProject(p.dir, async () => {
    const done = await runCommand(
      requestChangeCommand,
      {
        address: p.card,
        region: ["0,0,16,16 frame 3 : raise the paw"],
        candidates: 2,
        runs: p.runs,
        providerScript: s.path,
      },
      context(),
    );
    assert.equal(done.exitCode, 0, done.error?.message);
    const f = done.fields as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(f.job, "fix-frame");
    const run = JSON.parse(await readFile(join(f.runDir, "run.json"), "utf8"));
    assert.equal(run.candidates.length, 2);
    const decisions = run.candidates.map(
      (c: { provenance: { calls: Array<{ operation: string; requestId: string }> } }) =>
        c.provenance.calls.filter((call) => call.operation === "motion-template"),
    );
    // One decision for the run, the same call in each candidate's record.
    for (const d of decisions) assert.equal(d.length, 1);
    assert.equal(decisions[0][0].requestId, decisions[1][0].requestId);
    for (const c of run.candidates) {
      assert.deepEqual(
        c.provenance.calls.map((call: { operation: string }) => call.operation),
        ["motion-template", "edit", "fix-scale"],
      );
      assert.ok(c.provenance.requestIds.includes(decisions[0][0].requestId));
    }
  });
});

test("a frame region beyond the strip exits 2 before confirmation and records nothing", async () => {
  const strip = createRaster(128, 32);
  for (let i = 0; i < 4; i++)
    for (let y = 12; y < 30; y++)
      for (let x = i * 32 + 10; x < i * 32 + 20; x++) setPixel(strip, x, y, [90, 90, 140, 255]);
  const p = await project(
    { kind: "sprite-strip", assetId: "walker", animationFamily: "walk" },
    strip,
  );
  const s = await script(p.dir);
  useAttended();
  const asked: ConfirmRequest[] = [];
  const port: ConfirmPort = {
    method: "tty",
    confirm: async (request) => {
      asked.push(request);
      return true;
    },
  };
  const before = await readFile(p.review, "utf8");
  await inProject(p.dir, async () => {
    const done = await runCommand(
      requestChangeCommand,
      {
        address: p.card,
        region: ["0,0,16,16 frame 9 : raise the paw"],
        candidates: 1,
        runs: p.runs,
        providerScript: s.path,
      },
      context(port),
    );
    assert.equal(done.exitCode, 2);
    assert.match(done.error?.message ?? "", /frame 9 is not in the strip, which has 4 frames/);
    assert.equal(asked.length, 0, "no spend confirmation");
    assert.equal((await s.calls()).length, 0);
    assert.equal(await readFile(p.review, "utf8"), before, "no editing annotation");
    assert.equal(existsSync(join(p.dir, "assets", "walker.review")), false);
  });
});

test("a frame region on a spec with no subject checks the asset id its prompts name: a blocklisted id exits 9 before confirmation", async () => {
  // fix-frame's template decision and prompt name the subject, which is the asset id when the
  // spec has none, so the plan step checks it, free, rather than the final-prompt check after spend.
  const term = packageBlocklist().terms.find(
    (t) => t.kind === "character" && !t.ambiguous && /^[a-z0-9 ]+$/.test(t.term),
  )!.term;
  const assetId = `npc-${term.replace(/ /g, "-")}-baker`;
  const strip = createRaster(128, 32);
  for (let i = 0; i < 4; i++)
    for (let y = 12; y < 30; y++)
      for (let x = i * 32 + 10; x < i * 32 + 20; x++) setPixel(strip, x, y, [90, 90, 140, 255]);
  const p = await project({ kind: "sprite-strip", assetId, animationFamily: "walk" }, strip);
  const s = await script(p.dir);
  useAttended();
  const asked: ConfirmRequest[] = [];
  const port: ConfirmPort = {
    method: "tty",
    confirm: async (request) => {
      asked.push(request);
      return true;
    },
  };
  await inProject(p.dir, async () => {
    const done = await runCommand(
      requestChangeCommand,
      {
        address: p.card,
        region: ["0,0,16,16 frame 3 : raise the paw"],
        candidates: 1,
        runs: p.runs,
        providerScript: s.path,
      },
      context(port),
    );
    assert.equal(done.exitCode, 9, done.error?.message);
    assert.equal(done.error?.code, "prompt_refused");
    assert.equal(asked.length, 0, "no spend confirmation");
    assert.equal((await s.calls()).length, 0);
  });
});

test("a request on an assessed version reports the version's derived state", async () => {
  const p = await project();
  const s = await script(p.dir);
  await inProject(p.dir, async () => {
    const rejected = await runCommand(
      reviewCommand,
      { address: p.card, reject: "too dim" },
      context(),
    );
    assert.equal(rejected.exitCode, 0, rejected.error?.message);
    const done = await runCommand(
      requestChangeCommand,
      {
        address: p.card,
        region: ["0,0,10,10 : the glass redder"],
        candidates: 1,
        runs: p.runs,
        providerScript: s.path,
      },
      context(),
    );
    assert.equal(done.exitCode, 0, done.error?.message);
    const record = parseReview(await readFile(p.review, "utf8"), p.review);
    const status = versionStatus(record, record.versions[0]!.sha256);
    assert.equal(status, "rejected", "the latest assessment decides");
    assert.equal(done.fields["state"], status);
    assert.match(done.human ?? "", /\(rejected\)/);
  });
});

const SCRIPT_3D = fileURLToPath(new URL("./fixtures/model3d-script.ts", import.meta.url));

test("a view region on a 3D asset runs another round of the 3D kind with the note", async () => {
  approve(SCRIPT_3D);
  const dir = gitTarget(await mkdtemp(join(tmpdir(), "assetgrove-request-change-3d-")));
  await mkdir(join(dir, "refs"));
  const roles = ["turnaround-front", "turnaround-side", "turnaround-back"];
  for (const [i, role] of roles.entries())
    await writeFile(join(dir, "refs", `${role}.png`), encodePng(drawSubject(64, i * 4)));
  const bible = join(dir, "BIBLE.md");
  const view: StyleBible = {
    referenceLicense: "NOASSERTION",
    version: "2026-11-10",
    palette: PALETTE,
    references: roles.map((role) => ({
      path: `refs/${role}.png`,
      role,
      subject: "fern",
      view: { "turnaround-front": "front", "turnaround-side": "left", "turnaround-back": "back" }[
        role
      ],
    })),
    perspective: "refs/turnaround-front.png",
    subjects: { fern: { description: "a lean grey fox" } },
  };
  await writeStyleBible(bible, view);
  const profile = {
    format: "assetgrove-target-profile/1",
    name: "synthetic-grove-3d",
    license: "MIT",
    values: { creator: "Synthetic Grove" },
    frames: { width: 32, height: 32 },
    model3d: {
      format: "glb",
      budgets: { triangles: 40000, textureMaxPx: 2048, materials: 4, bones: 80, lods: 1 },
      forward: "+z",
      units: "m",
      turntable: { sizePx: 96 },
    },
    layout: {
      media: "characters/{{spec.assetId}}/{{spec.assetId}}.{{output.extension}}",
      manifest: "manifests/{{spec.assetId}}.json",
    },
    manifest: { assetId: "{{spec.assetId}}", review: { status: "pending" } },
    review: { path: "review.status", pending: "pending" },
    library: { root: "characters", game: "test-grove" },
  };
  await writeFile(join(dir, "profile.json"), JSON.stringify(profile));
  await writeFile(
    join(dir, "spec.json"),
    JSON.stringify({
      kind: "character-3d",
      assetId: "fern",
      subject: "fern",
      gait: "biped",
      clips: ["idle"],
      heightM: 0.5,
    }),
  );
  const runs = join(dir, ".assetgrove/runs");
  await inProject(dir, async () => {
    const staged = await runCommand(
      stageCommand,
      {
        spec: join(dir, "spec.json"),
        bible,
        profile: join(dir, "profile.json"),
        runs,
        candidates: 1,
        providerScript: SCRIPT_3D,
      },
      context(),
    );
    assert.equal(staged.exitCode, 0, staged.error?.message);
    const picked = await runCommand(
      pickCommand,
      { run: staged.fields["runDir"] as string, candidate: "c1", target: dir },
      context(),
    );
    assert.equal(picked.exitCode, 0, picked.error?.message);
    const card = join(dir, "characters/fern/fern.md");
    const args = {
      address: card,
      region: ["0,0,40,40 view 2 : darker ear tips"],
      candidates: 1,
      runs,
      providerScript: SCRIPT_3D,
    };
    // The round's prompt names the source spec's subject (the asset id when it has none), so the
    // plan step checks it: a blocklisted subject exits 9 before the spend is confirmed.
    const term = packageBlocklist().terms.find(
      (t) => t.kind === "character" && !t.ambiguous && /^[a-z0-9 ]+$/.test(t.term),
    )!.term;
    const sourceRunFile = join(staged.fields["runDir"] as string, "run.json");
    const kept = await readFile(sourceRunFile, "utf8");
    const named = JSON.parse(kept);
    named.spec.subject = term;
    await writeFile(sourceRunFile, JSON.stringify(named));
    const refused = await runCommand(requestChangeCommand, { ...args, bible }, context());
    assert.equal(refused.exitCode, 9, refused.error?.message);
    assert.equal(refused.error?.code, "prompt_refused");
    await writeFile(sourceRunFile, kept);
    const noBible = await runCommand(requestChangeCommand, args, context());
    assert.equal(noBible.exitCode, 2);
    assert.match(noBible.error!.message, /--bible/);
    const flat = await runCommand(
      requestChangeCommand,
      { ...args, region: ["0,0,40,40 : no view"], bible },
      context(),
    );
    assert.equal(flat.exitCode, 2, "a region on a 3D asset names its view");

    // A round on a bible whose side reference declares no view judges that view: the call is in
    // the confirmed forecast, and its answer lands in the sha256 cache under the state directory.
    const judged = join(dir, "bible-judged.md");
    await writeStyleBible(judged, {
      ...view,
      references: view.references.map(({ view: v, ...r }) =>
        r.role === "turnaround-side" ? r : { ...r, view: v },
      ),
    });
    const stateDir = await mkdtemp(join(tmpdir(), "assetgrove-request-change-state-"));
    const judging = (): RunContext => ({ ...context(), settings: { ...loadSettings(), stateDir } });
    const before = process.env["SCRIPT_REFERENCE_VIEWS"];
    process.env["SCRIPT_REFERENCE_VIEWS"] = JSON.stringify({ "turnaround-side": "left" });
    let done: Awaited<ReturnType<typeof runCommand>>;
    try {
      const dry = await runCommand(
        requestChangeCommand,
        { ...args, bible: judged, dryRun: true },
        judging(),
      );
      assert.equal(dry.exitCode, 0, dry.error?.message);
      const jobs = dry.fields["jobs"] as Array<{ operation: string; count: number }>;
      assert.equal(jobs.find((j) => j.operation === "reference-view")?.count, 1);
      done = await runCommand(requestChangeCommand, { ...args, bible: judged }, judging());
    } finally {
      if (before === undefined) delete process.env["SCRIPT_REFERENCE_VIEWS"];
      else process.env["SCRIPT_REFERENCE_VIEWS"] = before;
    }
    assert.equal(done.exitCode, 0, done.error?.message);
    assert.equal(readdirSync(join(stateDir, "reference-views")).length, 1);
    const f = done.fields as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(f.job, "3d-round");
    assert.equal(f.requests[0].view, 2);
    const run = JSON.parse(await readFile(join(f.runDir, "run.json"), "utf8"));
    assert.equal(run.candidates.length, 1);
    assert.match(run.candidates[0].provenance.prompt, /In view 2: darker ear tips/);
    assert.equal(run.changeRequest.answers[0], f.requests[0].id);
    assert.ok(existsSync(join(f.runDir, "compare.png")));
    assert.equal(typeof f.candidates[0].outsideChange, "number");
    const review = join(dir, "characters/fern/fern.review.json");
    const record = parseReview(await readFile(review, "utf8"), review);
    assert.equal(versionStatus(record, record.versions[0]!.sha256), "changes-requested");
  });
});
