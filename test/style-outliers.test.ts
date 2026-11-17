/**
 * Style outliers are judged, not cut by a z-score (#366). The search slot ranks every member of a
 * set by its image's mean distance to the rest, free and uncut (the package's own tests prove the
 * order); core then makes one `style-outlier` decision for each of the five most distant members,
 * shown the member's image, a contact sheet of up to eight typical members and the bible's style
 * text, and `find --outliers` lists the yes answers with the whole ranking. The decisions go
 * through core's Caller on the scripted provider: the script answers by the images' hue, so a
 * different subject or pose drawn in the same style is never an outlier.
 */
import "./fixtures/env.ts";
import { SCRIPTED_LIMIT, approve, ledgerPath, useAttended, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { createRaster, encodePng, setPixel } from "../src/image/raster.ts";
import { defaultRoutes } from "../src/routes.ts";
import {
  bibleStyleText,
  judgeStyleOutlier,
  selectMembers,
  styleOutlierWork,
} from "../src/search/style-outliers.ts";
import type { StyleAnswer } from "../src/search/style-outliers.ts";
import { GAME, fixtureLibrary } from "./fixtures/library.ts";
import { styleOutlier } from "./fixtures/style-outlier-script.ts";

const WARM = [220, 90, 40, 255];
const COOL = [40, 90, 220, 255];

/** A 32 px image: a shape (the subject) at an offset (the pose), filled in the style's hue. */
function drawn(
  hue: number[],
  shape: "lantern" | "barrel" | "tree" | "knight",
  pose = 0,
): Uint8Array {
  const r = createRaster(32, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) setPixel(r, x, y, [250, 250, 250, 255]);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const dx = x - 16 - pose;
      const dy = y - 16;
      const inside =
        shape === "lantern"
          ? Math.abs(dx) < 5 && Math.abs(dy) < 9
          : shape === "barrel"
            ? dx * dx + dy * dy < 81
            : shape === "tree"
              ? Math.abs(dx) < (dy + 12) / 2 && dy > -12 && dy < 10
              : Math.abs(dx) < 3 + (dy > 4 ? 4 : 0) && Math.abs(dy) < 12;
      if (inside) setPixel(r, x, y, hue);
    }
  return encodePng(r);
}

interface Set {
  ranking: { address: string; distance: number }[];
  images: Map<string, Uint8Array>;
}

/** A set already ranked: `first` most distant, then the rest. */
function ranked(first: [string, Uint8Array][], rest: [string, Uint8Array][]): Set {
  const all = [...first, ...rest];
  return {
    ranking: all.map(([address], i) => ({ address, distance: 0.9 - i * 0.01 })),
    images: new Map(all),
  };
}

async function judge(set: Set): Promise<{ answers: StyleAnswer[]; calls: number }> {
  let calls = 0;
  const provider = new ScriptedProvider({
    image: () => {
      throw new Error("no image calls");
    },
    vision: () => {
      throw new Error("no vision calls");
    },
    styleOutlier: (request) => {
      calls++;
      return styleOutlier(request);
    },
  });
  const caller = new Caller({
    provider,
    providerName: "scripted",
    budget: new Budget(1),
    routes: defaultRoutes,
  });
  const work = styleOutlierWork(set.ranking, (address) => {
    const bytes = set.images.get(address);
    return bytes && { bytes, path: `${address}.png` };
  });
  assert.deepEqual(work.notJudged, []);
  const answers: StyleAnswer[] = [];
  for (const { member, image } of work.pending)
    answers.push(
      await judgeStyleOutlier(caller, member, image, work.sheet!.sheet, work.sheet!.count, "pixel"),
    );
  return { answers, calls };
}

const yes = (answers: StyleAnswer[]) =>
  answers.filter((a) => a.differentStyle).map((a) => a.address);

test("the five most distant members are asked about beside up to eight typical ones", () => {
  const ranking = Array.from({ length: 26 }, (_, i) => ({
    address: `m${i}`,
    distance: 1 - i / 26,
  }));
  const { judged, typical } = selectMembers(ranking);
  assert.deepEqual(
    judged.map((m) => m.address),
    ["m0", "m1", "m2", "m3", "m4"],
  );
  assert.deepEqual(
    typical.map((m) => m.address),
    ["m25", "m24", "m23", "m22", "m21", "m20", "m19", "m18"],
  );
  // A small set: all but its least distant member is asked about; under three members, nothing.
  const four = selectMembers(ranking.slice(0, 4));
  assert.equal(four.judged.length, 3);
  assert.deepEqual(
    four.typical.map((m) => m.address),
    ["m3"],
  );
  assert.equal(selectMembers(ranking.slice(0, 6)).judged.length, 5);
  assert.equal(selectMembers(ranking.slice(0, 3)).judged.length, 2);
  assert.equal(selectMembers(ranking.slice(0, 2)).judged.length, 0);
});

test("six painterly assets among twenty pixel-art ones: the five most distant are judged drawn in another style", async () => {
  // The z-score over five nearest neighbours reported none of these (each has five painterly
  // neighbours); the ranking puts them first and the decision says yes.
  const painterly = Array.from(
    { length: 6 },
    (_, i) =>
      [`asset://g/painterly-${i}`, drawn(WARM, i % 2 ? "barrel" : "lantern", i)] as [
        string,
        Uint8Array,
      ],
  );
  const pixel = Array.from(
    { length: 20 },
    (_, i) =>
      [`asset://g/pixel-${i}`, drawn(COOL, i % 2 ? "barrel" : "lantern", i % 4)] as [
        string,
        Uint8Array,
      ],
  );
  const { answers, calls } = await judge(ranked(painterly, pixel));
  assert.equal(calls, 5, "one decision per member asked about");
  assert.deepEqual(
    yes(answers),
    painterly.slice(0, 5).map(([a]) => a),
  );
});

test("one alternate pose among near-identical frames is ranked, asked about and not an outlier", async () => {
  // The z-score flagged the pose at z of about 27.
  const frames = Array.from(
    { length: 12 },
    (_, i) => [`asset://g/walk-${i}`, drawn(COOL, "knight", i % 2)] as [string, Uint8Array],
  );
  const crouch: [string, Uint8Array] = ["asset://g/crouch", drawn(COOL, "knight", 8)];
  const set = ranked([crouch], frames);
  const { answers } = await judge(set);
  assert.equal(answers[0]!.address, "asset://g/crouch");
  assert.equal(answers[0]!.differentStyle, false);
  assert.deepEqual(yes(answers), []);
});

test("an in-style tree among lanterns and barrels is ranked first by its subject, and judged the same style", async () => {
  const props = Array.from(
    { length: 10 },
    (_, i) =>
      [`asset://g/prop-${i}`, drawn(COOL, i % 2 ? "barrel" : "lantern")] as [string, Uint8Array],
  );
  const tree: [string, Uint8Array] = ["asset://g/tree", drawn(COOL, "tree")];
  const { answers } = await judge(ranked([tree], props));
  assert.equal(answers[0]!.address, "asset://g/tree");
  assert.deepEqual(yes(answers), []);
});

test("a member with no image here is not judged", () => {
  const set = ranked(
    [["asset://g/pointer", new Uint8Array([1, 2, 3])]],
    Array.from(
      { length: 4 },
      (_, i) => [`asset://g/p-${i}`, drawn(COOL, "lantern")] as [string, Uint8Array],
    ),
  );
  const work = styleOutlierWork(set.ranking, (address) => {
    const bytes = set.images.get(address);
    return bytes && { bytes, path: address };
  });
  assert.deepEqual(work.notJudged, ["asset://g/pointer"]);
  assert.equal(work.pending.length, 3);
});

test("the bible's style text is its world, axes and Do's and Don'ts", () => {
  const lib = fixtureLibrary();
  try {
    const path = join(lib.dir, "bible.md");
    writeFileSync(
      path,
      "---\nversion: 1\nworld: a lantern-lit marsh\naxes:\n  rendering: pixel\n  outline: { weight: bold, colour: black }\n---\n# Bible\n\n## Do's and Don'ts\n\n- Do keep a 1 px outline.\n",
    );
    const text = bibleStyleText(path);
    assert.match(text, /World: a lantern-lit marsh/);
    assert.match(text, /rendering: pixel/);
    assert.match(text, /outline: \{"weight":"bold","colour":"black"\}/);
    assert.match(text, /Do keep a 1 px outline/);
    assert.equal(bibleStyleText(join(lib.dir, "missing.md")), "");
  } finally {
    rmSync(lib.dir, { recursive: true, force: true });
  }
});

// ---- find --outliers through the CLI: plan step, confirmation, spend ledger, the whole ranking.

const root = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./fixtures/style-outlier-script.ts", import.meta.url));
approve(script);
const STUB = "style-outlier-search-stub";
const lib = fixtureLibrary({ bulk: 8 });
after(() => rm(lib.dir, { recursive: true, force: true }));

// Repaint the bulk stills: bulk-005 warm (another style), the rest cool.
for (let i = 0; i < 8; i++) {
  const id = `bulk-${String(i).padStart(3, "0")}`;
  writeFileSync(
    join(lib.dir, "assets", "bulk", `${id}.png`),
    drawn(i === 5 ? WARM : COOL, "lantern", i % 3),
  );
}

// A stub slot whose ranking puts bulk-005 first, then the rest by address.
const pkg = join(lib.dir, "node_modules", STUB);
mkdirSync(pkg, { recursive: true });
writeFileSync(
  join(pkg, "package.json"),
  JSON.stringify({
    name: STUB,
    version: "1.0.0",
    type: "module",
    peerDependencies: { "@clockgrove/assetgrove": ">=0.2.0" },
    assetgrove: { api: 2, entry: "./index.js" },
  }),
);
writeFileSync(
  join(pkg, "index.js"),
  `export default function extension() {
  return {
    api: 2,
    name: "style-outlier-stub",
    search: {
      async find() { return { hits: [], fresh: true, builtFrom: null }; },
      async outliers(addresses) {
        // Members named in STUB_UNINDEXED have no indexed image: the slot leaves them out.
        const unindexed = (process.env.STUB_UNINDEXED ?? "").split(",").filter(Boolean);
        const ranked = addresses.filter((a) => !unindexed.some((id) => a.endsWith(id))).sort((a, b) =>
          a.endsWith("bulk-005") ? -1 : b.endsWith("bulk-005") ? 1 : a < b ? -1 : 1);
        return { members: ranked.length, ranking: ranked.map((address, i) => ({ address, distance: 0.5 - i / 100 })) };
      },
      async index() { return {}; },
      async status() { return {}; },
      async setup() { return {}; },
    },
  };
}
`,
);

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env["AI_GATEWAY_API_KEY"];
    const child = execFile(
      process.execPath,
      [join(root, "src", "cli.ts"), ...args],
      { cwd: lib.dir, env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

const styleCalls = () =>
  existsSync(ledgerPath)
    ? readFileSync(ledgerPath, "utf8")
        .split("\n")
        .filter((l) => l.includes('"op":"reserve"') && l.includes(":style-outlier:")).length
    : 0;

test("find --outliers is a paid request: it forecasts, asks, judges the most distant and prints the whole ranking", async () => {
  const set = `asset://${GAME}/by-tag/bulk/`;
  const base = ["find", "--outliers", set, "--target", lib.dir, "--provider-script", script];
  writeSettings({
    providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } },
    extensions: [STUB],
  });
  try {
    const before = styleCalls();
    const dry = await cli([...base, "--dry-run", "--json"]);
    assert.equal(dry.code, 0, dry.stdout + dry.stderr);
    const plan = JSON.parse(dry.stdout);
    assert.deepEqual(
      plan.jobs.map((j: { operation: string; count: number }) => [j.operation, j.count]),
      [["style-outlier", 5]],
      "the five most distant of eight members",
    );

    useAttended();
    const refused = await cli([...base, "--json"]);
    assert.equal(refused.code, 8, refused.stdout + refused.stderr);
    assert.equal(styleCalls(), before, "nothing is called before a person confirms");

    writeSettings({
      providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } },
      extensions: [STUB],
    });
    const run = await cli([...base, "--json"]);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.members, 8);
    assert.equal(result.ranking.length, 8, "every member, uncut");
    assert.deepEqual(
      result.outliers.map((o: { address: string }) => o.address),
      [`asset://${GAME}/bulk-005`],
    );
    assert.equal(result.ranking[0].differentStyle, true);
    assert.equal(
      result.ranking.filter((m: { differentStyle?: boolean }) => m.differentStyle === false).length,
      4,
    );
    assert.equal(result.typical.length, 3);
    assert.equal(styleCalls() - before, 5, "each decision reached the spend ledger");

    const human = await cli(base);
    assert.equal(human.code, 0, human.stderr);
    assert.match(
      human.stdout,
      /^1\. asset:\/\/\S+bulk-005 \(distance 0\.5000\): drawn in another style/m,
    );
    assert.match(human.stdout, /^8\. asset:\/\//m);
    assert.match(human.stdout, /1 drawn in another style among 8 ranked members/);
    assert.doesNotMatch(human.stdout, /not ranked/);
    assert.deepEqual(result.unranked, []);
  } finally {
    writeSettings({});
  }
});

test("find --outliers names the members with no indexed image, so unindexed additions never read as a pass", async () => {
  const set = `asset://${GAME}/by-tag/bulk/`;
  const base = ["find", "--outliers", set, "--target", lib.dir, "--provider-script", script];
  writeSettings({
    providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } },
    extensions: [STUB],
  });
  process.env["STUB_UNINDEXED"] = "bulk-005,bulk-006";
  try {
    const run = await cli([...base, "--json"]);
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.members, 6);
    assert.equal(result.ranking.length, 6);
    assert.deepEqual(result.unranked, [`asset://${GAME}/bulk-005`, `asset://${GAME}/bulk-006`]);
    assert.deepEqual(result.outliers, [], "the warm member is unindexed, so nothing is judged yes");

    const human = await cli(base);
    assert.equal(human.code, 0, human.stderr);
    assert.match(
      human.stdout,
      /^not ranked, no indexed image \(run search index\): \S+bulk-005, \S+bulk-006$/m,
    );
    assert.match(
      human.stdout,
      /0 drawn in another style among 6 ranked members of \S+ \(5 judged; 2 of 8 not ranked\)/,
    );
  } finally {
    delete process.env["STUB_UNINDEXED"];
    writeSettings({});
  }
});
