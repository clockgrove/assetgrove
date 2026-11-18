/**
 * Near matches before paid generation (issue #240, design section 7.6), with a stub search slot:
 * core lists up to three picks the slot ranks beside the plan, with a sheet, as candidates to look
 * at; references count by their bytes; the digest ignores them; a missing slot or
 * `nearMatch: false` leaves them absent; a failing search records `searchError`.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SearchSlot } from "../src/extension/api.ts";
import type { RunContext } from "../src/commands/types.ts";
import type { StyleBible } from "../src/types.ts";
import { buildWorkPlan, paidBy } from "../src/runs/plan.ts";
import { spendRequest } from "../src/runs/execute.ts";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { nearMatchesFor, subjectReferencePaths } from "../src/search/near-match.ts";
import { fixtureLibrary } from "./fixtures/library.ts";

const lib = fixtureLibrary();
const stateDir = mkdtempSync(join(tmpdir(), "assetgrove-near-"));
const cwd = process.cwd();
process.chdir(lib.dir);
after(async () => {
  process.chdir(cwd);
  await rm(lib.dir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

const seen: { kind: string; subject: string; brief?: string; references: number }[] = [];
const slot: SearchSlot = {
  async nearMatch(query, ctx) {
    seen.push({
      kind: query.kind,
      subject: query.subject,
      ...(query.brief !== undefined && { brief: query.brief }),
      references: query.references.length,
    });
    const rows = (await ctx.library.list(["pick"])).filter((i) => i.kind === query.kind);
    return {
      hits: rows.slice(0, query.limit).map((i, n) => ({
        address: i.address,
        rank: n + 1,
        score: 1,
        source: i.source,
        path: i.path,
        view: "",
        fields: { kind: i.kind, subject: i.subject },
        sharedText: { title: "Lantern" },
      })),
      fresh: true,
      builtFrom: null,
    };
  },
  async outliers() {
    return { members: 0, ranking: [] };
  },
  async find() {
    throw new Error("unused");
  },
  async index() {
    return {};
  },
  async status() {
    return {};
  },
};

function context(
  search: SearchSlot | undefined,
  nearMatch: boolean | undefined = true,
): RunContext {
  return {
    settings: {
      stateDir,
      ...(nearMatch !== undefined && {
        search: {
          embedder: "scripted",
          model: "siglip2-base",
          candidates: true,
          nearMatch,
          folders: [],
        },
      }),
    },
    extensions: { search, requireSearch: () => search },
    log: () => undefined,
    env: {},
  } as unknown as RunContext;
}

test("lists the picks of the kind, with a sheet", async () => {
  const same = await nearMatchesFor({ kind: "still", assetId: "lantern" }, [], context(slot));
  assert.deepEqual(
    same.nearMatches?.map((m) => [m.address, m.rank]),
    [
      ["asset://test-grove/big", 1],
      ["asset://test-grove/lantern", 2],
      ["asset://test-grove/fern", 3],
    ],
  );
  assert.ok(same.nearMatchSheet && existsSync(same.nearMatchSheet));
  assert.equal(same.searchError, undefined);
  const otherKind = await nearMatchesFor(
    { kind: "sprite-strip", assetId: "lantern" },
    [],
    context(slot),
  );
  assert.deepEqual(
    otherKind.nearMatches?.map((m) => [m.address, m.rank]),
    [["asset://test-grove/walk", 1]],
  );
});

test("lists at most three when the slot returns more", async () => {
  let returned = 0;
  const base = slot.nearMatch;
  assert.ok(base);
  const many: SearchSlot = {
    ...slot,
    async nearMatch(query, ctx) {
      const r = await base({ ...query, limit: 10 }, ctx);
      const hits = [...r.hits, ...r.hits].map((h, n) => ({ ...h, rank: n + 1 }));
      returned = hits.length;
      return { ...r, hits };
    },
  };
  const near = await nearMatchesFor({ kind: "still", assetId: "lantern" }, [], context(many));
  assert.ok(returned > 3);
  assert.deepEqual(
    near.nearMatches?.map((m) => m.rank),
    [1, 2, 3],
  );
});

test("a reference with an unusual extension is still used", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-near-refs-")));
  try {
    const odd = join(dir, "lantern.reference-image");
    copyFileSync(join(lib.dir, "assets", "lantern.png"), odd);
    const text = join(dir, "notes.png");
    writeFileSync(text, "not an image");
    seen.length = 0;
    await nearMatchesFor({ kind: "still", assetId: "lantern" }, [odd, odd, text], context(slot));
    assert.deepEqual(seen, [{ kind: "still", subject: "lantern", references: 1 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the request's references are its key pose, identity turnaround and subject-tagged bible references, not the anchors", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-near-bible-")));
  try {
    const dir = join(root, ".assetgrove/art-direction");
    mkdirSync(dir, { recursive: true });
    const png = join(lib.dir, "assets", "lantern.png");
    for (const name of ["anchor.png", "avoid.png", "turn.png"]) copyFileSync(png, join(dir, name));
    copyFileSync(png, join(root, "pose.png"));
    const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
    data.referenceLicense = "NOASSERTION";
    data.anchors.positive = [{ path: "anchor.png", role: "composition" }];
    data.anchors.negative = [{ path: "avoid.png", role: "unwanted-outline" }];
    data.identities["den"] = {
      version: "1",
      approved: true,
      turnaround: "turn.png",
      signatureFeatures: ["white muzzle"],
      proportions: "round",
      palette: ["#292433"],
    };
    const biblePath = join(dir, "BIBLE.md");
    writeFileSync(biblePath, serializeBible(data, "## Do's and Don'ts\nDo. Don't.\n"));
    const spec = (assetId: string) => ({
      value: { kind: "still", assetId, keyPose: "pose.png" },
      dir: root,
    });
    assert.deepEqual(await subjectReferencePaths(spec("den"), biblePath), [
      join(dir, "turn.png"),
      join(root, "pose.png"),
    ]);
    assert.deepEqual(await subjectReferencePaths(spec("lamp"), biblePath), [
      join(root, "pose.png"),
    ]);
    assert.deepEqual(
      await subjectReferencePaths({ value: { kind: "still", assetId: "den" }, dir: root }),
      [],
    );
    // The JSON style bible's references tagged with the subject (and its look, when they name one).
    const styleBible = {
      value: {
        references: [
          { path: "den.png", role: "prop", subject: "den" },
          { path: "den-night.png", role: "prop", subject: "den", look: "night" },
          { path: "lamp.png", role: "prop", subject: "lamp" },
          { path: "persp.png", role: "perspective", subject: "den" },
        ],
      } as unknown as StyleBible,
      dir,
    };
    assert.deepEqual(
      await subjectReferencePaths(
        { value: { kind: "still", assetId: "den" }, dir: root },
        undefined,
        styleBible,
      ),
      [join(dir, "den.png")],
    );
    assert.deepEqual(
      await subjectReferencePaths(
        { value: { kind: "still", assetId: "den", look: "night" }, dir: root },
        undefined,
        styleBible,
      ),
      [join(dir, "den.png"), join(dir, "den-night.png")],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the brief's words reach the slot as one text", async () => {
  seen.length = 0;
  await nearMatchesFor({ kind: "still", assetId: "lantern" }, [], context(slot), {
    purpose: "a lamp",
    appearsIn: "the cellar",
    mood: "calm",
    context: "",
  });
  assert.equal(seen[0]?.brief, "a lamp the cellar calm");
});

test("is absent with near matches off or the slot empty, and records a failing search", async () => {
  const spec = { kind: "still", assetId: "lantern" };
  assert.deepEqual(await nearMatchesFor(spec, [], context(slot, false)), {});
  assert.deepEqual(await nearMatchesFor(spec, [], context(undefined)), {});
  const failing: SearchSlot = {
    ...slot,
    async nearMatch() {
      throw new Error("index unreadable");
    },
  };
  const failed = await nearMatchesFor(spec, [], context(failing));
  assert.match(failed.searchError ?? "", /index unreadable/);
  assert.equal(failed.nearMatches, undefined);
});

test("the request digest is the same with and without near matches; the spend form names them", async () => {
  const near = await nearMatchesFor({ kind: "still", assetId: "lantern" }, [], context(slot));
  const providers = { routes: {}, providers: [] } as unknown as Parameters<typeof paidBy>[0] & {
    routes: Record<string, never>;
  };
  const parts = {
    inputs: [],
    jobs: [],
    capUsd: 1,
    paid: false,
    providers,
    candidates: 1,
  };
  const spec = { name: "plan", input: { type: "object", properties: {} } } as never;
  const without = await buildWorkPlan(spec, {}, parts);
  const withNear = await buildWorkPlan(spec, {}, { ...parts, near });
  assert.equal(withNear.digest, without.digest);
  assert.equal(without.nearMatches, undefined);
  assert.equal(withNear.nearMatches?.length, 3);
  const form = spendRequest("plan", 1, withNear);
  assert.match(form.summary, /1\. asset:\/\/[^ ]+ "Lantern"/);
  assert.ok(
    withNear.nearMatchSheet && form.summary.includes(`contact sheet: ${withNear.nearMatchSheet}`),
  );
  assert.doesNotMatch(form.summary, /near match/i);
  assert.deepEqual(
    form.details["nearMatches"],
    withNear.nearMatches?.map((m) => ({ rank: m.rank, address: m.address, title: "Lantern" })),
  );
  assert.equal(form.details["nearMatchSheet"], withNear.nearMatchSheet);
  assert.equal(form.id, spendRequest("plan", 1, without).id);
  const bare = spendRequest("plan", 1, without);
  assert.doesNotMatch(bare.summary, /contact sheet|picked assets/);
  assert.equal(bare.details["nearMatches"], undefined);
  assert.equal(bare.details["nearMatchSheet"], undefined);
});
