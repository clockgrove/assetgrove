import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { indexLibrary, RANKINGS, rankingsFor } from "../../../bench/search/bench.ts";
import {
  MIN_VISION_SIDE,
  ScriptedVision,
  writeCardTexts,
} from "../../../bench/search/card-text.ts";
import { buildFixtureManifest, fixtureSource } from "../../../bench/search/fixture.ts";
import type { ImageSource } from "../../../bench/search/fetch.ts";
import {
  checkManifest,
  droppedQueries,
  MIN_RELEVANT,
  relevantOf,
  RELEVANT_AT,
  wordsLabelProblems,
} from "../../../bench/search/manifest.ts";
import {
  gatewayJudge,
  structuredJudge,
  JUDGE_QUESTION,
  judgementSample,
  judgePromptRecord,
  judgeRelevance,
  markJudgementsChecked,
  poolCandidates,
  POOL_DEPTH,
  ScriptedJudge,
  type RelevanceJudge,
} from "../../../bench/search/relevance.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { ScriptedEmbedder } from "../src/scripted.ts";
import { cleanup, tempDir } from "./helpers/fixture.ts";

const pooledFixture = async () => {
  const manifest = buildFixtureManifest();
  const source = fixtureSource();
  await writeCardTexts({ manifest, source, provider: new ScriptedVision() });
  await poolCandidates({
    manifest,
    source,
    embedder: new ScriptedEmbedder(),
    store: new MemoryStore(),
  });
  return { manifest, source };
};

describe("relevance candidates", () => {
  it("are the union of the top results of every ranking the bench scores, and nothing else", async () => {
    const { manifest, source } = await pooledFixture();
    const embedder = new ScriptedEmbedder();
    const store = new MemoryStore();
    await indexLibrary(manifest, source, embedder, store);
    assert.deepEqual(RANKINGS, ["image-vector", "card-text-vector", "full-text", "fused"]);
    for (const q of manifest.writtenQueries) {
      const ranked: Record<string, string[]> = await rankingsFor(
        store,
        embedder,
        q.text,
        POOL_DEPTH,
      );
      const union: Set<string> = new Set(RANKINGS.flatMap((r) => ranked[r] ?? []));
      assert.deepEqual(new Set(q.candidates), union);
      // Bounded: each ranking adds at most POOL_DEPTH images.
      assert.ok(q.candidates!.length <= RANKINGS.length * POOL_DEPTH);
      assert.deepEqual(q.pooledBy, {
        embedder: "scripted",
        revision: embedder.revision,
        depth: POOL_DEPTH,
        rankings: [...RANKINGS],
      });
    }
    // A pooled query is not pooled again unless asked.
    assert.equal(await poolCandidates({ manifest, source, embedder, store: new MemoryStore() }), 0);
  });
});

describe("relevance judgements", () => {
  it("record the probability, model, prompt and date of each, and are skipped once made", async () => {
    const { manifest, source } = await pooledFixture();
    assert.match(wordsLabelProblems(manifest).join("\n"), /not judged/);
    const planned: number[] = [];
    const { judged, left } = await judgeRelevance({
      manifest,
      source,
      judge: new ScriptedJudge(),
      now: () => new Date("2026-02-03T04:05:06Z"),
      onPlan: (calls) => planned.push(calls),
    });
    const total = manifest.writtenQueries.reduce((n, q) => n + q.candidates!.length, 0);
    assert.equal(judged, total);
    assert.equal(left, 0);
    assert.deepEqual(planned, [total]);
    assert.deepEqual(wordsLabelProblems(manifest, { scriptedJudgements: true }), []);
    // Outside the offline fixture a scripted judgement is a word match: refused.
    assert.match(wordsLabelProblems(manifest).join("\n"), /judgements by scripted-judge/);
    assert.deepEqual(checkManifest(manifest), []);
    for (const q of manifest.writtenQueries)
      for (const j of q.judgements!) {
        assert.equal(j.model, "scripted-judge");
        assert.equal(j.date, "2026-02-03T04:05:06.000Z");
        assert.equal(manifest.prompts[j.prompt], judgePromptRecord());
        assert.ok(j.probability >= 0 && j.probability <= 1);
      }
    assert.match(judgePromptRecord(), /\{query\}/);
    assert.match(judgePromptRecord(), /Would a game developer searching for this query want/);
    // Relevance is the judged probability at RELEVANT_AT or more; under three relevant is dropped.
    const ground = manifest.writtenQueries.find((q) => q.id === "wq-1")!;
    assert.deepEqual(
      relevantOf(ground).sort(),
      ground
        .judgements!.filter((j) => j.probability >= RELEVANT_AT)
        .map((j) => j.image)
        .sort(),
    );
    assert.deepEqual(
      droppedQueries(manifest).map((q) => q.id),
      ["wq-4"],
    );
    // A second run finds everything judged and makes no call.
    let calls = 0;
    const counting: RelevanceJudge = {
      judge: async () => (calls++, { probability: 1, model: "m" }),
    };
    assert.deepEqual(await judgeRelevance({ manifest, source, judge: counting }), {
      judged: 0,
      left: 0,
    });
    assert.equal(calls, 0);
  });

  it("say how many calls they will make before the first, stop at the cap and save after each", async () => {
    const { manifest, source } = await pooledFixture();
    const events: string[] = [];
    const judge: RelevanceJudge = {
      judge: async () => (events.push("call"), { probability: 0.7, model: "m", requestId: "r" }),
    };
    const out = await judgeRelevance({
      manifest,
      source,
      judge,
      maxCalls: 3,
      onPlan: (calls) => events.push(`plan ${calls}`),
      onJudged: () => void events.push("save"),
    });
    assert.deepEqual(events, ["plan 3", "call", "save", "call", "save", "call", "save"]);
    assert.equal(out.judged, 3);
    assert.ok(out.left > 0);
    assert.equal(manifest.writtenQueries[0]!.judgements![0]!.requestId, "r");
    // The next run picks up where the cap stopped it.
    const next = await judgeRelevance({ manifest, source, judge, maxCalls: 2 });
    assert.equal(next.judged, 2);
    assert.equal(next.left, out.left - 2);
    // A cap that is not a non-negative integer is refused before any call.
    for (const bad of [-1, 1.5, Number.NaN])
      await assert.rejects(
        judgeRelevance({ manifest, source, judge, maxCalls: bad }),
        /non-negative integer/,
      );
    assert.equal(next.left, (await judgeRelevance({ manifest, source, judge, maxCalls: 0 })).left);
  });

  it("show the model the query, the question and a small sprite scaled up as forVision does", async () => {
    const { manifest } = await pooledFixture();
    const tiny = new Uint8Array(PNG.sync.write(new PNG({ width: 16, height: 16 })));
    const source: ImageSource = { bytes: async () => tiny };
    const seen: { width: number; prompt: string; type: string }[] = [];
    const judge: RelevanceJudge = {
      judge: async (r) => {
        seen.push({
          width: PNG.sync.read(Buffer.from(r.image)).width,
          prompt: r.prompt,
          type: r.question.type,
        });
        return { probability: 0, model: "m" };
      },
    };
    await judgeRelevance({ manifest, source, judge, maxCalls: 1 });
    assert.equal(seen[0]!.width, MIN_VISION_SIDE);
    assert.match(seen[0]!.prompt, /"ground tile"/);
    assert.equal(seen[0]!.type, JUDGE_QUESTION.type);
  });

  it("list a seeded sample for a spot-check and mark it as checked", async () => {
    const { manifest, source } = await pooledFixture();
    await judgeRelevance({ manifest, source, judge: new ScriptedJudge() });
    const sample = judgementSample(manifest, 5, "s");
    assert.equal(sample.length, 5);
    assert.deepEqual(sample, judgementSample(manifest, 5, "s"));
    assert.notDeepEqual(sample, judgementSample(manifest, 5, "other"));
    markJudgementsChecked(manifest, sample, "kirk", "2026-01-01");
    const checked = manifest.writtenQueries.flatMap((q) =>
      (q.judgements ?? []).filter((j) => j.spotCheck).map((j) => `${q.id}:${j.image}`),
    );
    assert.deepEqual(checked.sort(), [...sample].sort());
    assert.throws(() => markJudgementsChecked(manifest, ["wq-1:nope"], "k", "d"), /not a recorded/);
  });
});

describe("the relevance record", () => {
  it("names the cut, the minimum and the pool depth in docs/decisions.md with the code's values", async () => {
    const decisions = await readFile(
      new URL("../../../docs/decisions.md", import.meta.url),
      "utf8",
    );
    assert.ok(decisions.includes(`RELEVANT_AT = ${RELEVANT_AT}`));
    assert.ok(decisions.includes(`MIN_RELEVANT = ${MIN_RELEVANT}`));
    assert.ok(decisions.includes(`POOL_DEPTH = ${POOL_DEPTH}`));
    assert.match(decisions, /`words-shipped-p5` bar was set against the old labels/);
  });

  it("goes through the gateway only with a key: without one, the judge refuses before any request", async () => {
    const judge = gatewayJudge("perplexity/pplx-decider-v1.2", { apiKey: undefined });
    await assert.rejects(
      judge.judge({ image: new Uint8Array(), query: "q", prompt: "p", question: JUDGE_QUESTION }),
      /AI_GATEWAY_API_KEY is not set/,
    );
  });

  it("the structured judge refuses to be built without a key, so it makes no request", () => {
    assert.throws(
      () =>
        structuredJudge("anthropic/claude-sonnet-5-5", { keyEnv: "ASSETGROVE_TEST_NO_SUCH_KEY" }),
      /needs a key in ASSETGROVE_TEST_NO_SUCH_KEY/,
    );
  });
});

describe("the judge command", () => {
  const run = promisify(execFile);
  const script = fileURLToPath(
    new URL("../../../bench/search/judge-relevance.ts", import.meta.url),
  );

  it("makes no call without --provider gateway, and pools and judges offline on the scripted ones", async () => {
    const dir = await tempDir("judge-cli");
    try {
      const path = join(dir, "manifest.json");
      const m = buildFixtureManifest();
      await writeCardTexts({
        manifest: m,
        source: fixtureSource(),
        provider: new ScriptedVision(),
      });
      await writeFile(path, JSON.stringify(m));
      const cli = async (...args: string[]) =>
        (await run(process.execPath, [script, "--manifest", path, ...args])).stdout;

      assert.match(await cli(), /not pooled yet/);
      assert.match(await cli("--pool"), /pooled 4 queries with scripted/);
      const before = await readFile(path, "utf8");
      assert.match(
        await cli("--max-calls", "5"),
        /^5 judge calls would be made .*--provider gateway/m,
      );
      assert.equal(await readFile(path, "utf8"), before);

      const out = await cli("--provider", "scripted", "--max-calls", "5");
      assert.match(out, /^making 5 judge calls/m);
      assert.match(out, /stopped at the cap/);
      // A negative or non-numeric cap is refused before any call.
      const capped = await readFile(path, "utf8");
      for (const bad of ["--max-calls=-1", "--max-calls=lots"])
        await assert.rejects(cli("--provider", "scripted", bad), /non-negative integer/);
      assert.equal(await readFile(path, "utf8"), capped);
      const after = JSON.parse(await readFile(path, "utf8")) as typeof m;
      assert.equal(after.writtenQueries.flatMap((q) => q.judgements ?? []).length, 5);
      assert.match(await cli("--provider", "scripted"), /every candidate is judged/);

      const sample = (await cli("--sample", "2")).trim().split("\n");
      assert.equal(sample.length, 2);
      await cli("--mark", sample.map((l) => l.split("\t")[0]).join(","), "--by", "tester");
      const marked = JSON.parse(await readFile(path, "utf8")) as typeof m;
      assert.equal(
        marked.writtenQueries.flatMap((q) => q.judgements ?? []).filter((j) => j.spotCheck).length,
        2,
      );
    } finally {
      await cleanup(dir);
    }
  });
});
