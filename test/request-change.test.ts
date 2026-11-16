/**
 * `request-change` (issue #238, design section 3.4): regions on a picked asset's current version
 * become a run of candidates through a masked edit, a whole-image edit, fix-frame's path or another
 * 3D round; picking one appends the version with answers naming the requests.
 */
import { approve, useAttended } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { pickCommand } from "../src/commands/pick.ts";
import { requestChangeCommand } from "../src/commands/request-change.ts";
import { runCommand } from "../src/commands/runner.ts";
import type { RunContext } from "../src/commands/types.ts";
import type { ConfirmPort, ConfirmRequest } from "../src/confirm/prompt.ts";
import { writeToTarget } from "../src/handoff.ts";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import { parseReview, versionStatus } from "../src/library/review.ts";
import { DIGITAL_SOURCE_TYPES } from "../src/metadata.ts";
import { packageBlocklist } from "../src/policy/blocklist.ts";
import { loadSettings } from "../src/settings.ts";
import type { AssetSpec, Provenance, TargetProfile } from "../src/types.ts";
import { libraryProfile } from "./fixtures/library.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-request-change-"));
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
  const card = join(dir, `assets/${spec.assetId}.md`);
  const review = join(dir, `assets/${spec.assetId}.review.json`);
  return { dir, card, review, runs };
}

/**
 * A provider script that logs each image call (prompt, mask hash, reference count) and answers
 * with the current version (reference 1) painted red in its top-left 10×10 corner, plus `outside`
 * painted pixels at the bottom right.
 */
async function script(dir: string, options: { mask?: boolean; outside?: number } = {}) {
  const path = join(dir, `script-${options.mask === false ? "plain" : "mask"}.mjs`);
  const events = `${path}.events`;
  await writeFile(
    path,
    `import { appendFileSync } from "node:fs";
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
  promptPolicy: () => ({ answer: { type: "boolean", probability: 0 } }),
};`,
  );
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
    assert.equal((target["selector"] as { value: string }).value, "xywh=pixel:0,0,10,10");
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
