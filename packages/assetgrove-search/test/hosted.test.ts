/**
 * Hosted embeddings through core's commands (issue #242, design section 7.7): with
 * `search.embedder: "route"` and the `embeddings` role on a scripted provider that is paid and
 * embeds, `search index` and `find` with words are paid requests (one plan step, one spend
 * confirmation, every call reserved in the spend ledger), a repeat pays nothing twice, reads make
 * no provider call, a route without `embed` exits 2 before any reservation, and an index built by
 * another embedder exits 2 `embedder_changed` until `search index --rebuild`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  extensionContext,
  sampleBible,
  samplePng,
  sampleProfile,
  tempProject,
} from "@clockgrove/assetgrove/testing";
import type { ConfirmRequest, McpSession, Outcome } from "@clockgrove/assetgrove/testing";
import searchExtension from "../src/extension.ts";
import { GAME, drawSubject, writeLibrary } from "./helpers/core-library.ts";

const script = fileURLToPath(new URL("./fixtures/embed-script.ts", import.meta.url));
const calls = ((globalThis as { embedCalls?: { image: number; text: number } }).embedCalls ??= {
  image: 0,
  text: 0,
});

const project = tempProject();
const home = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-search-hosted-")));
const runs = join(home, "runs");
const ledgerPath = join(project.stateDir, "spend.jsonl");
const stateDir = project.stateDir;
const lib = { dir: project.dir };
const { raster } = extensionContext("search-hosted-test");
writeLibrary(project.dir);
after(async () => {
  project.close();
  await rm(home, { recursive: true, force: true });
});

const extensions = [searchExtension(extensionContext("search"))];

/** The installed package name the tree test lists in settings. */
const SHIM = "assetgrove-search-hosted-shim";

/** Attended settings: a person is asked, so a test's confirmation port answers. */
function writeSettings(settings: Record<string, unknown>): void {
  project.writeSettings(settings, { attended: true });
}

/** Hosted settings with the embeddings role on `provider` (the scripted one by default). */
function hosted(model = "scripted/embed-a", provider = "scripted", listed = false): void {
  writeSettings({
    search: { embedder: "route" },
    ...(listed && { extensions: [SHIM] }),
    providers: {
      scripted: { limit: { kind: "prepaid", usd: 100 } },
      anthropic: {},
    },
    roles: {
      embeddings: { provider, model, estimatedCostUsd: 0.002 },
      decisions: { provider: "scripted", model: "scripted/decide" },
    },
  });
}

/**
 * Runs a command in process with a TTY port that says yes. Each spend confirmation is recorded
 * in `asked`; the first run of the provider script is approved the same way, unrecorded.
 */
async function run(
  name: string,
  args: Record<string, unknown>,
  asked: ConfirmRequest[] = [],
  env?: NodeJS.ProcessEnv,
): Promise<Outcome> {
  return project.run(
    name,
    { target: lib.dir, providerScript: script, runs, ...args },
    {
      extensions,
      confirm: (request) => {
        if (request.kind === "spend") asked.push(request);
        return true;
      },
      ...(env && { env }),
    },
  );
}

/** A bible and a target profile written by `init` into a repository of their own. */
async function initFiles(): Promise<{ bible: string; profile: string; flows: unknown[] }> {
  const target = realpathSync(mkdtempSync(join(home, "init-")));
  execFileSync("git", ["init", "-q", target]);
  const init = await project.run(
    "init",
    {
      directory: target,
      world: "Synthetic Grove",
      profilePreset: "sprite-32",
      stylePreset: "flat-cartoon-kids",
    },
    { extensions },
  );
  assert.equal(init.exitCode, 0, JSON.stringify(init.error));
  const files = init.fields["files"] as { path: string; role: string }[];
  const pathOf = (role: string) => files.find((f) => f.role === role)!.path;
  return {
    bible: pathOf("bible"),
    profile: pathOf("profile"),
    flows: init.fields["providers"] as unknown[],
  };
}

/**
 * The plan step of `stage` over a sprite-strip spec for the walk, as core's near matches see it:
 * the outcome's `nearMatches` and `searchError`, with `keyPose` the reference image (a sample picture when absent).
 */
async function planStep(keyPose?: string): Promise<Outcome> {
  const dir = mkdtempSync(join(home, "stage-"));
  const [spec, bible, profile] = ["spec", "bible", "profile"].map((n) =>
    join(dir, `${n}.json`),
  ) as [string, string, string];
  writeFileSync(
    spec,
    JSON.stringify({
      kind: "sprite-strip",
      assetId: "walk",
      animationFamily: "walk",
      frames: { count: 2 },
      anchor: { x: 4, y: 7 },
      keyPose: keyPose ?? "pose.png",
    }),
  );
  writeFileSync(join(dir, "pose.png"), samplePng());
  writeFileSync(bible, JSON.stringify(sampleBible()));
  writeFileSync(profile, JSON.stringify(sampleProfile()));
  // The stage command finds the library from the working directory.
  const cwd = process.cwd();
  process.chdir(lib.dir);
  try {
    return await project.run(
      "stage",
      { spec, bible, profile, providerScript: script, runs, dryRun: true },
      { extensions },
    );
  } finally {
    process.chdir(cwd);
  }
}

interface ListedTool {
  name: string;
  _meta?: Record<string, unknown>;
  annotations?: { openWorldHint?: boolean };
}

/** The tools an MCP server lists under the settings written now (the server reads them at start). */
async function listTools(): Promise<ListedTool[]> {
  const mcp = await project.mcp({ extensions, providerScript: script });
  try {
    return ((await mcp.request("tools/list", {}))["result"] as { tools: ListedTool[] }).tools;
  } finally {
    await mcp.close();
  }
}

const needsPerson = (tool: ListedTool | undefined): unknown =>
  tool?._meta?.["anthropic/requiresUserInteraction"];

/** The ledger lines of `embed` calls. */
function embedEntries(): string[] {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((line) => line.includes(":embed:"));
}

const total = () => calls.image + calls.text;

test("search index forecasts one call per unembedded image, asks once, reserves each call, and a repeat pays nothing", async () => {
  hosted();
  const dry = await run("search index", { dryRun: true });
  assert.equal(dry.exitCode, 0, JSON.stringify(dry.error));
  const embed = (dry.fields["plan"] as { embed: { images: number; texts: number } }).embed;
  const jobs = dry.fields["jobs"] as Array<{ operation: string; count: number }>;
  assert.ok(embed.images > 0);
  assert.deepEqual(
    jobs.map((j) => [j.operation, j.count]),
    [["embed", embed.images + embed.texts]],
  );
  assert.equal(total(), 0, "the plan step calls nothing");
  assert.deepEqual(embedEntries(), [], "the plan step reserves nothing");

  const asked: ConfirmRequest[] = [];
  const indexed = await run("search index", {}, asked);
  assert.equal(indexed.exitCode, 0, JSON.stringify(indexed.error));
  assert.equal(asked.length, 1, "one spend confirmation covers the request");
  assert.equal(asked[0]!.kind, "spend");
  assert.equal(calls.image, embed.images, "one call per unembedded image");
  assert.equal(calls.text, embed.texts);
  // Exactly one reservation per call, each for its own call key: none missing, none twice.
  const reserves = embedEntries()
    .map((line) => JSON.parse(line) as { op: string; callKey: string })
    .filter((e) => e.op === "reserve");
  assert.equal(reserves.length, embed.images + embed.texts, "each call reserved once");
  assert.equal(new Set(reserves.map((e) => e.callKey)).size, reserves.length);
  const ledger = embedEntries().length;

  const before = total();
  const again: ConfirmRequest[] = [];
  const repeat = await run("search index", {}, again);
  assert.equal(repeat.exitCode, 0, JSON.stringify(repeat.error));
  assert.equal(total(), before, "a repeat pays nothing twice");
  assert.equal(again.length, 0, "nothing to pay, nothing to confirm");
  assert.equal(embedEntries().length, ledger);
});

test("reads with a hosted embedder use stored vectors only; find with words is a paid request", async () => {
  hosted();
  const indexed = await run("search index", {});
  assert.equal(indexed.exitCode, 0, JSON.stringify(indexed.error));
  const before = total();
  const ledger = embedEntries().length;

  const asked: ConfirmRequest[] = [];
  const lantern = `asset://${GAME}/lantern`;
  for (const args of [{ where: ["kind=still"] }, { like: lantern }]) {
    const found = await run("find", args, asked);
    assert.equal(found.exitCode, 0, JSON.stringify(found.error));
    assert.ok((found.fields["hits"] as unknown[]).length > 0, JSON.stringify(args));
  }
  // A plan step's near matches: by stored vectors only, with and without a reference image.
  const walkHit = (
    (await run("find", { where: ["subject=fox"] })).fields["hits"] as { path: string }[]
  )[0]!;
  const reference = join(lib.dir, walkHit.path);
  for (const keyPose of [undefined, reference]) {
    const outcome = await planStep(keyPose);
    assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.error));
    assert.equal(outcome.fields["searchError"], undefined, String(keyPose));
    const near = (outcome.fields["nearMatches"] ?? []) as { address: string }[];
    assert.ok(near.length > 0, String(keyPose));
    assert.equal(near[0]!.address, `asset://${GAME}/walk`);
  }
  assert.equal(total(), before, "no provider call from a read or a plan step");
  assert.equal(asked.length, 0);
  assert.equal(embedEntries().length, ledger);

  const words = await run("find", { words: "lantern" }, asked);
  assert.equal(words.exitCode, 0, JSON.stringify(words.error));
  assert.equal(asked.length, 1, "find with words asks its own confirmation");
  assert.equal(total(), before + 1, "one query embedding");
  assert.equal(embedEntries().length, ledger + 1);
});

test("the tree's find, like and where paths over MCP with a hosted embedder make no provider call: stored vectors only, words refused", async () => {
  // The server loads the package from the project, as settings list it: an installed shim whose
  // entry re-exports this package's extension (Git tracks the package's own files, which an
  // extension entry may not be).
  const shim = join(home, "shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(
    join(shim, "package.json"),
    JSON.stringify({
      name: SHIM,
      version: "1.0.0",
      type: "module",
      assetgrove: { api: 2, entry: "./index.js" },
      peerDependencies: { "@clockgrove/assetgrove": "^0.2.0" },
    }),
  );
  writeFileSync(
    join(shim, "index.js"),
    `export { default } from ${JSON.stringify(new URL("../src/extension.ts", import.meta.url).href)};\n`,
  );
  project.install(shim, SHIM);
  hosted("scripted/embed-a", "scripted", true);
  const indexed = await run("search index", {});
  assert.equal(indexed.exitCode, 0, JSON.stringify(indexed.error));
  const before = total();
  const ledger = embedEntries().length;

  const cwd = process.cwd();
  process.chdir(lib.dir);
  const mcp: McpSession = await project.mcp({ extensions, providerScript: script });
  const read = (uri: string) => mcp.request("resources/read", { uri });
  try {
    // The server passes its settings to the mark: with a hosted embedder, find and search_index
    // are paid tools that need the person and reach the provider.
    const tools = await listTools();
    for (const name of ["find", "search_index"]) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} is listed`);
      assert.equal(needsPerson(tool), true, name);
      assert.equal(tool.annotations?.openWorldHint, true, name);
    }
    for (const path of ["like/lantern", `where/${encodeURIComponent("kind=still")}`]) {
      const answer = await read(`asset://${GAME}/${path}`);
      assert.equal(answer["error"], undefined, `${path}: ${JSON.stringify(answer["error"])}`);
      const contents = (answer["result"] as { contents: { text: string }[] }).contents;
      const document = JSON.parse(contents[0]!.text) as { hits: unknown[] };
      assert.ok(document.hits.length > 0, path);
    }
    // Words need a query embedding: the tree refuses them and points at the find tool.
    const words = await read(`asset://${GAME}/find/lantern`);
    const refused = words["error"] as { message: string; data: { code: string; exitCode: number } };
    assert.equal(refused.data.code, "invalid_input", JSON.stringify(words));
    assert.equal(refused.data.exitCode, 2);
    assert.match(refused.message, /find tool/);
  } finally {
    await mcp.close();
    process.chdir(cwd);
  }
  assert.equal(total(), before, "no provider call from a tree read");
  assert.equal(embedEntries().length, ledger, "no reservation from a tree read");
});

test("a route whose adapter lacks embed exits 2 route_unavailable before any reservation; init's data flows list the embedding provider", async () => {
  hosted("claude-embed", "anthropic");
  const before = total();
  const ledger = embedEntries().length;
  const asked: ConfirmRequest[] = [];
  for (const [name, args] of [
    ["search index", {}],
    ["find", { words: "lantern" }],
  ] as const) {
    const refused = await run(name, args, asked);
    assert.equal(refused.exitCode, 2, name);
    assert.equal(refused.error?.code, "route_unavailable", name);
    assert.match(refused.error!.message, /embed capability/);
  }
  assert.equal(asked.length, 0);
  assert.equal(total(), before);
  assert.equal(embedEntries().length, ledger);

  hosted();
  const flows = (await initFiles()).flows as { operation: string; providerId: string }[];
  assert.equal(flows.find((f) => f.operation === "embed")?.providerId, "scripted");
});

test("a hosted find without words brings the index up to date first: it forecasts the new image, asks once, and a repeat pays nothing", async () => {
  hosted();
  assert.equal((await run("search index", {})).exitCode, 0);
  const folder = realpathSync(mkdtempSync(join(home, "folder-")));
  writeFileSync(join(folder, "moon.png"), raster.encodePng(drawSubject(40, 11)));
  const settings = JSON.parse(readFileSync(project.settingsPath, "utf8")) as {
    search: Record<string, unknown>;
  };
  writeSettings({ ...settings, search: { ...settings.search, folders: [folder] } });

  const dry = await run("find", { where: ["source=folder"], dryRun: true });
  assert.equal(dry.exitCode, 0, JSON.stringify(dry.error));
  const embed = (
    dry.fields["plan"] as { embed: { images: number; texts: number; queries: number } }
  ).embed;
  assert.equal(embed.images, 1, "the new folder image is forecast");
  assert.equal(embed.queries, 0);

  const reserves = () =>
    embedEntries()
      .map((line) => JSON.parse(line) as { op: string; callKey: string })
      .filter((e) => e.op === "reserve");
  const before = { image: calls.image, text: calls.text, reserves: reserves().length };
  const asked: ConfirmRequest[] = [];
  const found = await run("find", { where: ["source=folder"] }, asked);
  assert.equal(found.exitCode, 0, JSON.stringify(found.error));
  assert.equal(asked.length, 1, "one spend confirmation");
  assert.equal(found.fields["fresh"], true);
  assert.equal(calls.image, before.image + 1);
  assert.equal(calls.text, before.text + embed.texts);
  // Exactly one reservation per call the confirmation covered.
  const added = reserves().slice(before.reserves);
  assert.equal(added.length, embed.images + embed.texts, "each call reserved once");
  assert.equal(new Set(added.map((e) => e.callKey)).size, added.length);
  assert.ok(
    (found.fields["hits"] as { path: string }[]).some((h) => h.path.endsWith("moon.png")),
    "the new image is found",
  );

  const again: ConfirmRequest[] = [];
  const repeat = await run("find", { where: ["source=folder"] }, again);
  assert.equal(repeat.exitCode, 0, JSON.stringify(repeat.error));
  assert.equal(again.length, 0, "nothing to pay, nothing to confirm");
  assert.equal(calls.image, before.image + 1);
  hosted();
});

test("an index built by another embedder exits 2 embedder_changed until search index --rebuild", async () => {
  hosted("scripted/embed-a");
  assert.equal((await run("search index", {})).exitCode, 0);

  hosted("scripted/embed-b");
  // A plan step's near matches record the refusal as their searchError (design 7.6) and go on.
  const planned = await planStep();
  assert.equal(planned.exitCode, 0, JSON.stringify(planned.error));
  assert.match(String(planned.fields["searchError"]), /embedder_changed|search index --rebuild/);
  const asked: ConfirmRequest[] = [];
  for (const [name, args] of [
    ["search index", {}],
    ["find", { where: ["kind=still"] }],
    ["find", { words: "lantern" }],
  ] as const) {
    const refused = await run(name, args, asked);
    assert.equal(refused.exitCode, 2, name);
    assert.equal(refused.error?.code, "embedder_changed", name);
    assert.match(refused.error!.message, /search index --rebuild/);
  }
  assert.equal(asked.length, 0, "refused before any confirmation");

  const rebuilt = await run("search index", { rebuild: true }, asked);
  assert.equal(rebuilt.exitCode, 0, JSON.stringify(rebuilt.error));
  assert.equal(asked.length, 1);
  const found = await run("find", { where: ["kind=still"] });
  assert.equal(found.exitCode, 0, JSON.stringify(found.error));
  assert.ok((found.fields["hits"] as unknown[]).length > 0);
});

test("a finished search index or find is run again, not replayed: rebuilds alternate, a deleted index is rebuilt, and a repeated find pays nothing twice", async () => {
  hosted("scripted/embed-a");
  const first = await run("search index", { rebuild: true });
  assert.equal(first.exitCode, 0, JSON.stringify(first.error));
  // a, b, a, b: the third and fourth have the digests of the first and second.
  for (const model of ["scripted/embed-b", "scripted/embed-a", "scripted/embed-b"]) {
    hosted(model);
    const rebuilt = await run("search index", { rebuild: true });
    assert.equal(rebuilt.exitCode, 0, `${model}: ${JSON.stringify(rebuilt.error)}`);
    assert.equal(rebuilt.fields["reused"], false, model);
    const found = await run("find", { where: ["kind=still"] });
    assert.equal(found.exitCode, 0, `${model}: ${JSON.stringify(found.error)}`);
    assert.ok((found.fields["hits"] as unknown[]).length > 0, model);
  }

  // The index is a projection: deleted, the same request builds it again.
  await rm(join(stateDir, "search"), { recursive: true, force: true });
  const again = await run("search index", { rebuild: true });
  assert.equal(again.exitCode, 0, JSON.stringify(again.error));
  assert.equal(again.fields["reused"], false);
  const found = await run("find", { where: ["kind=still"] });
  assert.equal(found.exitCode, 0, JSON.stringify(found.error));
  assert.ok((found.fields["hits"] as unknown[]).length > 0);

  // A find with words answers from the index as it is now; its journal pays nothing twice.
  const words = await run("find", { words: "lantern" });
  assert.equal(words.exitCode, 0, JSON.stringify(words.error));
  const before = total();
  const ledger = embedEntries().length;
  const repeat = await run("find", { words: "lantern" });
  assert.equal(repeat.exitCode, 0, JSON.stringify(repeat.error));
  assert.equal(repeat.fields["reused"], false);
  assert.deepEqual(repeat.fields["hits"], words.fields["hits"]);
  assert.equal(total(), before, "the journal answers the query again");
  assert.equal(embedEntries().length, ledger);
});

test("with the local model find and search index embed nothing and take no tracked-key guard; only find --outliers pays", async () => {
  const name = ["AI", "GATEWAY", "API", "KEY"].join("_");
  const value = `agk-test-${"0123456789abcdef".split("").reverse().join("")}-synthetic`;
  const repo = realpathSync(mkdtempSync(join(home, "repo-")));
  execFileSync("git", ["init", "-q", repo]);
  await writeFile(join(repo, "notes.txt"), `the gateway key is ${value}\n`);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  const env = { ...process.env, [name]: value };
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    writeSettings({ search: { embedder: "scripted" } });
    for (const [command, args] of [
      ["find", { words: "lantern" }],
      ["search index", {}],
    ] as const) {
      const outcome = await run(command, args, [], env);
      assert.notEqual(outcome.error?.code, "key_tracked", command);
    }
    // The server marks a tool at start from its settings. find --outliers asks style-outlier
    // decisions under every embedder (#366): it takes the guard, and the find tool is marked as
    // asking a spend confirmation, except under headless settings, so in Claude Code a paid
    // --outliers goes to the person in every permission mode (docs/PRD.md).
    const local = await listTools();
    assert.equal(local.find((t) => t.name === "search_index")?.annotations?.openWorldHint, false);
    assert.equal(needsPerson(local.find((t) => t.name === "search_index")), undefined);
    const judged = await run("find", { outliers: `asset://${GAME}/` }, [], env);
    assert.equal(judged.error?.code, "key_tracked");
    assert.equal(local.find((t) => t.name === "find")?.annotations?.openWorldHint, true);
    assert.equal(needsPerson(local.find((t) => t.name === "find")), true);
    project.writeSettings({ search: { embedder: "scripted" } });
    assert.equal(needsPerson((await listTools()).find((t) => t.name === "find")), undefined);

    hosted();
    const refused = await run("find", { words: "lantern" }, [], env);
    assert.equal(refused.error?.code, "key_tracked");
    // A hosted find without words still brings the index up to date, which can embed: it takes
    // the guard too, as does --outliers, which asks style-outlier decisions.
    const where = await run("find", { where: ["kind=still"] }, [], env);
    assert.equal(where.error?.code, "key_tracked");
    const hostedJudged = await run("find", { outliers: `asset://${GAME}/` }, [], env);
    assert.equal(hostedJudged.error?.code, "key_tracked");
    // A hosted embedder asks a spend confirmation, so the server marks both tools at start,
    // except under headless settings.
    const paid = await listTools();
    for (const command of ["find", "search_index"]) {
      assert.equal(paid.find((t) => t.name === command)?.annotations?.openWorldHint, true, command);
      assert.equal(needsPerson(paid.find((t) => t.name === command)), true, command);
    }
    project.writeSettings({
      search: { embedder: "route" },
      providers: { scripted: { limit: { kind: "prepaid", usd: 100 } }, anthropic: {} },
      roles: { embeddings: { provider: "scripted", model: "scripted/embed-a" } },
    });
    for (const tool of (await listTools()).filter((t) => ["find", "search_index"].includes(t.name)))
      assert.equal(needsPerson(tool), undefined, tool.name);
  } finally {
    process.chdir(cwd);
  }
});

test("a hosted find with words or like of the wrong type exits 2 invalid_input, as with the local model", async () => {
  for (const args of [{ words: 5 }, { like: 7 }]) {
    hosted();
    const paid = await run("find", args);
    assert.equal(paid.exitCode, 2, JSON.stringify(args));
    assert.equal(paid.error?.code, "invalid_input", JSON.stringify(args));
    writeSettings({ search: { embedder: "scripted" } });
    const local = await run("find", args);
    assert.equal(local.error?.code, "invalid_input", JSON.stringify(args));
  }
});

test("with the local model a dry run or an estimate of find or search index is refused and runs nothing", async () => {
  writeSettings({ search: { embedder: "scripted" } });
  const built = await run("search index", { rebuild: true });
  assert.equal(built.exitCode, 0, JSON.stringify(built.error));
  const store = join(stateDir, "search");
  const listing = () =>
    readdirSync(store, { recursive: true })
      .map((name) => `${String(name)}@${statSync(join(store, String(name))).mtimeMs}`)
      .sort();
  const was = listing();
  assert.ok(
    was.some((n) => n.includes(".lance")),
    "an index to keep",
  );
  for (const [name, args] of [
    ["search index", { rebuild: true }],
    ["find", { words: "lantern" }],
  ] as const) {
    const dry = await run(name, { ...args, dryRun: true });
    assert.equal(dry.exitCode, 2, name);
    assert.equal(dry.error?.code, "invalid_input", name);
    assert.match(dry.error!.message, /spends nothing with the local model/);
    const estimate = await project.run(
      "estimate",
      { command: name, args: { ...args, target: lib.dir } },
      { extensions },
    );
    assert.equal(estimate.exitCode, 2, name);
    assert.equal(estimate.error?.code, "invalid_input", name);
    assert.match(estimate.error!.message, /spends nothing, so it has no estimate/);
  }
  assert.deepEqual(listing(), was, "nothing deleted or rebuilt");
});
