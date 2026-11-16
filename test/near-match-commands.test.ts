/**
 * Near matches through the plan step of plan, stage, apply and generate-sheet (issue #240, design
 * section 7.6): with a stub search slot listed, each command's `--dry-run` plan lists the pick the
 * slot returns in `nearMatches` with a sheet, and plan and apply hand the slot the same reference
 * images. The real slot has its own tests in the search package.
 */
import "./fixtures/env.ts";
import { SCRIPTED_LIMIT, approve, approveProfile, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { fixtureLibrary } from "./fixtures/library.ts";
import { bareGitTarget } from "./fixtures/git.ts";
import { shelterSpec, syntheticProfile, syntheticWorld } from "./fixtures/synthetic.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(root, "src", "cli.ts");
const script = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
const STUB = "assetgrove-near-stub";
approve(script);

const lib = fixtureLibrary();
const temporary: string[] = [lib.dir];
after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

const log = join(lib.dir, "near.log");
const pkg = join(lib.dir, "node_modules", STUB);
mkdirSync(pkg, { recursive: true });
writeFileSync(
  join(pkg, "package.json"),
  JSON.stringify({
    name: STUB,
    version: "1.0.0",
    type: "module",
    assetgrove: { api: 1, entry: "./index.js" },
  }),
);
writeFileSync(
  join(pkg, "index.js"),
  `import { appendFileSync } from "node:fs";
export default function extension() {
  return {
    api: 1,
    name: "near-stub",
    search: {
      async nearMatch(query, ctx) {
        appendFileSync(${JSON.stringify(log)}, JSON.stringify({ references: query.references.length }) + "\\n");
        const [i] = await ctx.library.list(["pick"]);
        return {
          hits: [{ address: i.address, rank: 1, score: 1, source: i.source, path: i.path, view: "",
            fields: { kind: i.kind, subject: i.subject }, sharedText: {} }],
          fresh: true, builtFrom: null,
        };
      },
      async find() { throw new Error("unused"); },
      async outliers() { return { members: 0, outliers: [] }; },
      async index() { return {}; },
      async status() { return {}; },
      async setup() { return {}; },
    },
  };
}
`,
);

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["AI_GATEWAY_API_KEY"];
  for (const name of REFUSED_VARIABLES) {
    delete env[name];
    delete env[name.toLowerCase()];
  }
  return env;
}

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd: lib.dir, env: childEnv(), maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        done({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

async function dryRun(args: string[]): Promise<Doc> {
  const run = await cli([...args, "--provider-script", script, "--dry-run", "--json"]);
  assert.equal(run.code, 0, `${args[0]}: ${run.stdout}${run.stderr}`);
  return JSON.parse(run.stdout) as Doc;
}

function listsThePick(name: string, d: Doc): void {
  assert.equal(d["nearMatches"]?.length, 1, `${name} nearMatches`);
  assert.match(d["nearMatches"][0].address, /^asset:\/\/test-grove\//, name);
  assert.ok(d["nearMatchSheet"] && existsSync(d["nearMatchSheet"]), `${name} sheet`);
  assert.equal(d["searchError"], undefined, name);
}

test("the plan step of plan, stage, apply and generate-sheet lists the near match the slot returns", async () => {
  writeSettings({
    providers: { scripted: { limit: { ...SCRIPTED_LIMIT } } },
    extensions: [STUB],
    search: {
      embedder: "scripted",
      model: "siglip2-base",
      candidates: true,
      nearMatch: true,
      folders: [],
    },
  });
  const world = await syntheticWorld();
  temporary.push(world.dir);
  const spec = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "bible.json");
  const profile = join(world.dir, "profile.json");
  writeFileSync(spec, JSON.stringify(shelterSpec));
  writeFileSync(bible, JSON.stringify(world.bible));
  writeFileSync(profile, JSON.stringify(world.profile));
  approveProfile(world.profile, { targetDir: world.targetDir });
  const files = ["--spec", spec, "--bible", bible, "--profile", profile];
  const runs = ["--runs", world.runsDir];

  const stage = await dryRun(["stage", ...files, ...runs]);
  listsThePick("stage", stage);
  const sheet = await dryRun(["generate-sheet", ...files, ...runs]);
  listsThePick("generate-sheet", sheet);

  // plan and apply: a still spec with a key-less bible from init, and the saved plan apply reads.
  const dir = join(world.dir, "plan");
  mkdirSync(dir);
  bareGitTarget(join(dir, "bible"));
  const init = await cli([
    ...["init", "--directory", join(dir, "bible"), "--world", "Synthetic Grove"],
    ...["--profile-preset", "sprite-32", "--style-preset", "flat-cartoon-kids", "--json"],
  ]);
  assert.equal(init.code, 0, init.stderr);
  const planBible = (JSON.parse(init.stdout).files as { path: string; role: string }[]).find(
    (f) => f.role === "bible",
  )!.path;
  const planSpec = join(dir, "still-spec.json");
  const planProfile = join(dir, "plan-profile.json");
  const out = join(dir, "plan.json");
  writeFileSync(
    planSpec,
    JSON.stringify({ kind: "still", assetId: "icon", subject: "icon", animationFamily: "still" }),
  );
  writeFileSync(planProfile, JSON.stringify(syntheticProfile()));
  const planFlags = [
    ...["--spec", planSpec, "--bible", planBible, "--profile", planProfile],
    ...["--out", out, "--runs", join(dir, "runs")],
  ];
  writeFileSync(log, "");
  const plan = await dryRun(["plan", ...planFlags]);
  listsThePick("plan", plan);
  // Saving the plan needs a compiler answer: a script of its own that answers like a passing model.
  const saver = join(dir, "saver.mjs");
  const synthetic = fileURLToPath(new URL("./fixtures/synthetic.ts", import.meta.url));
  const raster = fileURLToPath(new URL("../src/image/raster.ts", import.meta.url));
  writeFileSync(
    saver,
    `import { pathToFileURL } from 'node:url';
const { drawSubject } = await import(pathToFileURL(${JSON.stringify(synthetic)}));
const { encodePng } = await import(pathToFileURL(${JSON.stringify(raster)}));
const checks = ['transparency','frame-count','identity','perspective','style'].map(check => ({check, passed: true, reason: 'scripted match'}));
export default {
  image() { return {images:[{mediaType:'image/png',bytes:encodePng(drawSubject(96))}]}; },
  vision() { return {text: JSON.stringify({prompt:'A friendly round icon, flat cel shading.',negativePrompt:'No text.',violations:[],clamps:[],styleScore:1,passed:true,reason:'scripted match',checks})}; },
};`,
  );
  approve(saver);
  const saved = await cli(["plan", ...planFlags, "--provider-script", saver, "--json"]);
  assert.equal(saved.code, 0, saved.stderr);
  const apply = await dryRun(["apply", out, "--out", join(dir, "apply-runs")]);
  listsThePick("apply", apply);

  // Plan and apply agree on whether the request has references: the same count reaches the slot.
  const counts = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as { references: number }).references);
  assert.equal(counts[0], counts[counts.length - 1]);
  assert.equal(counts[0], counts[1]);
});
