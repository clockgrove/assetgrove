/**
 * The set-level audit (issue #243, design section 8): a tree folder's members scored for style
 * and, where the subject has a lock, for identity; one spend confirmation, a repeat reused with no
 * call; each score's spread and the members beyond the set-consistency bar; advisory scores; search
 * outliers at no cost when the slot is loaded; nothing written into the target.
 */
import "./fixtures/env.ts";
import { approve, ledgerPath, writeSettings, SCRIPTED_LIMIT } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  SET_CONSISTENCY_BAR,
  judgeScores,
  parseSetConsistencyBar,
  spreadOf,
} from "../src/audit/bar.ts";
import { BIBLE_PRESETS, serializeBible } from "../src/bible.ts";
import { auditFiltering, parseChecks, summarize } from "../src/commands/audit.ts";
import type { AuditedMember } from "../src/commands/audit.ts";
import { decodePng, encodePng } from "../src/image/raster.ts";
import {
  DEFAULT_VISION_MODEL,
  MIN_AGREEMENT,
  MIN_CASES,
  MIN_REPEATS,
} from "../src/qa/stability.ts";
import { defaultRoutes } from "../src/routes.ts";
import { GAME, fixtureLibrary } from "./fixtures/library.ts";
import { drawSubject } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const lib = fixtureLibrary({ bulk: 6 });
const work = await mkdtemp(join(tmpdir(), "assetgrove-audit-"));
after(async () => {
  await rm(lib.dir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

const SET = `asset://${GAME}/by-tag/bulk/`;
const OFF = `asset://${GAME}/bulk-005`;

// The off-style member: a larger image, which the scripted style answer scores low.
const offBytes = encodePng(drawSubject(64, 2));
writeFileSync(join(lib.root, "bulk", "bulk-005.png"), offBytes);
const THRESHOLD = offBytes.length - 1;

// A bible with one positive anchor and a lock for the bulk set's subject.
const art = join(lib.dir, ".assetgrove", "art-direction");
writeFileSync(join(art, "anchor.png"), encodePng(drawSubject(16, 1)));
writeFileSync(join(art, "pebble.png"), encodePng(drawSubject(16)));
const bible = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
bible.referenceLicense = "NOASSERTION";
bible.world = "Synthetic";
bible.anchors = { positive: [{ path: "anchor.png", role: "prop" }], negative: [] };
bible.identities = {
  pebble: {
    version: "pebble-1",
    approved: true,
    turnaround: "pebble.png",
    signatureFeatures: ["round"],
    proportions: "small",
    palette: ["#808080"],
  },
};
writeFileSync(
  join(art, "BIBLE.md"),
  serializeBible(bible, "# Synthetic\n\n## Do's and Don'ts\nDo.\n"),
);

// A scripted provider that logs each call: style by image size, identity a fixed level 3 of 4.
const events = join(work, "events.jsonl");
const script = join(work, "audit-provider.mjs");
writeFileSync(
  script,
  `import { appendFileSync } from "node:fs";
const log = (kind, request) => appendFileSync(${JSON.stringify(events)}, JSON.stringify({ kind, operation: request.operation }) + "\\n");
export default {
  image() { throw new Error("no image generation"); },
  vision(request) {
    log("vision", request);
    const score = request.images[0].bytes.length > ${THRESHOLD} ? 0.4 : 0.75;
    return { text: "\`\`\`json\\n" + JSON.stringify({ styleScore: score, reason: "synthetic" }) + "\\n\`\`\`", costUsd: 0.001 };
  },
  decide(request) {
    log("decide", request);
    if (request.question.type === "boolean") return { answer: { type: "boolean", probability: 0 }, costUsd: 0.00001 };
    return { answer: { type: "score", score: 3 }, confidence: 0.7, costUsd: 0.0001 };
  },
};
`,
);
approve(script);

const calls = () =>
  existsSync(events)
    ? readFileSync(events, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { kind: string; operation?: string })
    : [];

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [join(root, "src/cli.ts"), ...args],
      { cwd: lib.dir, env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        done({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = (r: Result): Record<string, any> => JSON.parse(r.stdout);

/** Every file under `dir` with its sha256, so a test can tell nothing was written there. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

const runs = join(work, "runs");
const base = ["audit", SET, "--runs", runs, "--provider-script", script];

test("an audit plans one style call per member and one identity call per locked member, with no call", async () => {
  const before = calls().length;
  const dry = await cli([...base, "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stderr + dry.stdout);
  const d = doc(dry);
  const job = (op: string) => d.jobs.find((j: { operation: string }) => j.operation === op);
  assert.equal(job("vision").count, 6);
  assert.equal(job("identity").count, 6);
  assert.equal(existsSync(d.runDir), false);
  assert.equal(calls().length, before, "a dry run makes no call");
  const styleOnly = doc(await cli([...base, "--checks", "style", "--dry-run", "--json"]));
  assert.equal(
    styleOnly.jobs.find((j: { operation: string }) => j.operation === "identity"),
    undefined,
  );
  assert.notEqual(styleOnly.digest, d.digest);
});

test("an audit scores the set once, reports the spread and the members beyond the bar, writes nothing into the target, and a repeat pays nothing", async () => {
  const target = snapshot(lib.dir);
  const before = calls().length;
  const first = await cli([...base, "--json"]);
  assert.equal(first.code, 0, first.stderr + first.stdout);
  const d = doc(first);
  assert.equal(d.reused, false);
  const made = calls().slice(before);
  assert.equal(made.filter((c) => c.kind === "vision").length, 6);
  assert.equal(made.filter((c) => c.operation === "identity").length, 6);
  assert.deepEqual(snapshot(lib.dir), target, "nothing is written into the target");

  const audit = JSON.parse(await readFile(join(d.runDir, "audit.json"), "utf8"));
  assert.deepEqual(audit.members, d.members);
  assert.equal(audit.members.length, 6);
  const off = audit.members.find((m: AuditedMember) => m.address === OFF);
  assert.equal(off.style.score, 0.4);
  assert.equal(off.identity.score, 0.75);
  assert.equal(off.style.advisory, true);
  assert.equal(off.identity.advisory, true);
  assert.equal(audit.spread.style.range, 0.35);
  assert.equal(audit.spread.style.median, 0.75);
  assert.ok(audit.spread.style.stdDev > 0.1);
  assert.equal(audit.spread.identity.stdDev, 0);
  assert.deepEqual(audit.bar, SET_CONSISTENCY_BAR);
  assert.equal(audit.judgement.style.consistent, false);
  assert.equal(audit.judgement.identity.consistent, true);
  assert.deepEqual(audit.beyond, [{ address: OFF, checks: ["style"] }]);
  assert.deepEqual(
    audit.filtering.map((f: { check: string; state: string }) => [f.check, f.state]),
    [
      ["audit-style", "advisory"],
      ["audit-identity", "advisory"],
    ],
  );
  assert.equal(audit.outliers, null, "without search the audit runs unchanged");
  // The sheet orders the set weakest first, numbers only.
  assert.deepEqual(audit.sheet[0], { number: 1, address: OFF });
  assert.equal(audit.sheet.length, 6);
  const sheet = decodePng(new Uint8Array(readFileSync(join(d.runDir, "audit-sheet.png"))));
  assert.ok(sheet.width > 0 && sheet.height > 0);

  const ledger = existsSync(ledgerPath) ? await readFile(ledgerPath, "utf8") : null;
  const again = await cli([...base, "--json"]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(doc(again).reused, true);
  assert.equal(calls().length, before + made.length, "no provider call");
  assert.equal(
    existsSync(ledgerPath) ? await readFile(ledgerPath, "utf8") : null,
    ledger,
    "no ledger entry",
  );
});

test("with the search slot loaded the audit adds embedding outliers and no call", async () => {
  const pkg = join(lib.dir, "node_modules", "audit-search-stub");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "audit-search-stub",
      version: "1.0.0",
      type: "module",
      assetgrove: { api: 1, entry: "./index.js" },
    }),
  );
  writeFileSync(
    join(pkg, "index.js"),
    `export default function extension() {
  return {
    api: 1,
    name: "audit-search-stub",
    search: {
      async find() { return { hits: [], fresh: true, builtFrom: null }; },
      async outliers(addresses) {
        return { members: addresses.length, outliers: addresses.filter((a) => a.endsWith("bulk-005")).map((address) => ({ address, distance: 0.9, z: 5 })) };
      },
      async index() { return {}; },
      async status() { return {}; },
      async setup() { return {}; },
    },
  };
}
`,
  );
  writeSettings({
    providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } },
    extensions: ["audit-search-stub"],
  });
  try {
    const before = calls().length;
    const r = await cli([...base, "--checks", "style", "--json"]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const d = doc(r);
    assert.deepEqual(d.outliers, {
      members: 6,
      outliers: [{ address: OFF, distance: 0.9, z: 5 }],
    });
    assert.equal(
      calls()
        .slice(before)
        .filter((c) => c.kind === "vision").length,
      6,
      "outliers add no model call",
    );
    assert.match(r.stdout, /"members"/);
  } finally {
    writeSettings({});
  }
});

test("a folder that is not a set, or an unknown check, exits 2 before any call", async () => {
  const before = calls().length;
  const notFolder = await cli([
    ...["audit", `asset://${GAME}/bulk-000/card`, "--runs", runs],
    ...["--provider-script", script, "--json"],
  ]);
  assert.equal(notFolder.code, 2, notFolder.stdout);
  const badCheck = await cli([...base, "--checks", "style,colour", "--json"]);
  assert.equal(badCheck.code, 2, badCheck.stdout);
  assert.equal(calls().length, before);
  assert.deepEqual(parseChecks(["identity,style"]), ["style", "identity"]);
  assert.deepEqual(parseChecks(["identity"]), ["identity"]);
  assert.deepEqual(parseChecks(undefined), ["style", "identity"]);
});

test("the shipped bar is the one docs/decisions.md records; a document without one gives none", async () => {
  const decisions = await readFile(join(root, "docs", "decisions.md"), "utf8");
  assert.deepEqual(parseSetConsistencyBar(decisions), SET_CONSISTENCY_BAR);
  assert.deepEqual(SET_CONSISTENCY_BAR, { maxStdDev: 0.1, maxBelowMedian: 0.2, minSetSize: 5 });
  assert.equal(parseSetConsistencyBar("# Decisions\n"), undefined);
  const noBlock = decisions.replace(/"setConsistency": \{[^}]*\},\n\s*/, "");
  assert.notEqual(noBlock, decisions);
  assert.equal(parseSetConsistencyBar(noBlock), undefined);
});

test("the decisions' example: one 0.40 among eight 0.75s gives 0.12 and fails both rules", () => {
  const scores = [...Array.from({ length: 8 }, (_, i) => ({ address: `a${i}`, score: 0.75 }))];
  scores.push({ address: "off", score: 0.4 });
  const spread = spreadOf(scores.map((s) => s.score));
  assert.equal(spread.stdDev.toFixed(2), "0.12");
  assert.equal(spread.range, 0.35);
  const judged = judgeScores(scores, SET_CONSISTENCY_BAR);
  assert.equal(judged.judged, true);
  assert.equal(judged.consistent, false);
  assert.deepEqual(
    judged.beyond.map((b) => b.address),
    ["off"],
  );
  // Under the bar's set size, or with no bar, nothing is judged.
  assert.deepEqual(judgeScores(scores.slice(5), SET_CONSISTENCY_BAR).judged, false);
  const none = judgeScores(scores, undefined);
  assert.equal(none.judged, false);
  assert.deepEqual(none.beyond, []);
});

test("with no bar the audit judges nothing but still reports the spread", () => {
  const members: AuditedMember[] = ["a", "b", "c", "d", "e", "f"].map((address, i) => ({
    address,
    style: { score: i === 0 ? 0.1 : 0.8, reason: "", advisory: true },
  }));
  const judged = summarize(members, ["style"], [], undefined);
  assert.equal(judged.bar, null);
  assert.equal(judged.judgement.style!.judged, false);
  assert.deepEqual(judged.beyond, []);
  assert.equal(judged.spread.style!.range, 0.7);
  assert.equal(judged.sheet[0]!.address, "a");
  const barred = summarize(members, ["style"], [], SET_CONSISTENCY_BAR);
  assert.deepEqual(barred.beyond, [{ address: "a", checks: ["style"] }]);
});

test("a model-backed score is advisory unless the stability file has a qualifying entry for its model", () => {
  const routes = { vision: defaultRoutes.vision, identity: defaultRoutes.identity };
  const entry = (checkId: string, model: string) => ({
    checkId,
    version: "1",
    model,
    cases: MIN_CASES,
    repeats: MIN_REPEATS,
    agreement: MIN_AGREEMENT,
    measuredAt: "2026-11-15T00:00:00Z",
  });
  const none = auditFiltering(routes, []);
  assert.deepEqual(
    none.map((s) => s.state),
    ["advisory", "advisory"],
  );
  const measured = auditFiltering(routes, [
    entry("audit-style", DEFAULT_VISION_MODEL),
    entry("audit-identity", defaultRoutes.identity.model),
  ]);
  assert.deepEqual(
    measured.map((s) => s.state),
    ["filtering", "filtering"],
  );
  const short = auditFiltering(routes, [
    { ...entry("audit-style", DEFAULT_VISION_MODEL), cases: MIN_CASES - 1 },
  ]);
  assert.equal(short[0]!.state, "advisory");
});
