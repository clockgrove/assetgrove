/**
 * Near matches before paid generation (issue #240, design section 7.6), with a stub search slot:
 * core lists up to three picks of exactly the spec's kind and subject beside the plan, with a
 * sheet; the digest ignores them; a missing slot or `nearMatch: false` leaves them absent; a
 * failing search records `searchError`.
 */
import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SearchSlot } from "../src/extension/api.ts";
import type { RunContext } from "../src/commands/types.ts";
import { buildWorkPlan, paidBy } from "../src/runs/plan.ts";
import { spendRequest } from "../src/runs/execute.ts";
import { nearMatchesFor } from "../src/search/near-match.ts";
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

const seen: { kind: string; subject: string; references: number }[] = [];
const slot: SearchSlot = {
  async nearMatch(query, ctx) {
    seen.push({ kind: query.kind, subject: query.subject, references: query.references.length });
    const rows = (await ctx.library.list(["pick"])).filter(
      (i) => i.kind === query.kind && i.subject === query.subject,
    );
    return {
      hits: rows.slice(0, query.limit).map((i, n) => ({
        address: i.address,
        rank: n + 1,
        score: 1,
        source: i.source,
        path: i.path,
        view: "",
        fields: { kind: i.kind, subject: i.subject },
        sharedText: {},
      })),
      fresh: true,
      builtFrom: null,
    };
  },
  async outliers() {
    return { members: 0, outliers: [] };
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
  async setup() {
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

test("lists the pick of the same kind and subject, with a sheet, and never another kind or subject", async () => {
  const same = await nearMatchesFor({ kind: "still", assetId: "lantern" }, [], context(slot));
  assert.deepEqual(
    same.nearMatches?.map((m) => m.address),
    ["asset://test-grove/lantern"],
  );
  assert.ok(same.nearMatchSheet && existsSync(same.nearMatchSheet));
  assert.equal(same.searchError, undefined);
  const subject = await nearMatchesFor(
    { kind: "still", assetId: "x", subject: "lantern" },
    [],
    context(slot),
  );
  assert.equal(subject.nearMatches?.length, 1);
  const otherKind = await nearMatchesFor(
    { kind: "sprite-strip", assetId: "lantern" },
    [],
    context(slot),
  );
  assert.deepEqual(otherKind.nearMatches, []);
  const otherSubject = await nearMatchesFor({ kind: "still", assetId: "oak" }, [], context(slot));
  assert.deepEqual(otherSubject.nearMatches, []);
});

test("hands the slot the reference images only", async () => {
  seen.length = 0;
  await nearMatchesFor(
    { kind: "still", assetId: "lantern" },
    [join(lib.dir, "assets", "lantern.png"), join(lib.dir, "notes.txt")],
    context(slot),
  );
  assert.deepEqual(seen, [{ kind: "still", subject: "lantern", references: 1 }]);
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
  assert.equal(withNear.nearMatches?.length, 1);
  const form = spendRequest("plan", 1, withNear);
  assert.match(form.summary, /asset:\/\/test-grove\/lantern/);
  assert.equal(form.id, spendRequest("plan", 1, without).id);
  assert.doesNotMatch(spendRequest("plan", 1, without).summary, /near matches/);
});
