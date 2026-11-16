/**
 * Hosted embeddings through core's commands (issue #242, design section 7.7): with
 * `search.embedder: "route"` and the `embeddings` role on a scripted provider that is paid and
 * embeds, `search index` and `find` with words are paid requests (one plan step, one spend
 * confirmation, every call reserved in the spend ledger), a repeat pays nothing twice, reads make
 * no provider call, a route without `embed` exits 2 before any reservation, and an index built by
 * another embedder exits 2 `embedder_changed` until `search index --rebuild`.
 */
import "../../../test/fixtures/env.ts";
import { approve, ledgerPath, useAttended, writeSettings } from "../../../test/fixtures/env.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { commands } from "../../../src/commands/registry.ts";
import { searchCall } from "../../../src/commands/search.ts";
import { runCommand } from "../../../src/commands/runner.ts";
import type { CommandSpec, Outcome, RunContext } from "../../../src/commands/types.ts";
import type { ConfirmPort, ConfirmRequest } from "../../../src/confirm/prompt.ts";
import { routeDataFlows } from "../../../src/dataflows.ts";
import { coreExtension } from "../../../src/extensions/core.ts";
import { ExtensionRegistry } from "../../../src/extensions/registry.ts";
import { nearMatchesFor } from "../../../src/search/near-match.ts";
import { loadSettings } from "../../../src/settings.ts";
import { GAME, fixtureLibrary } from "../../../test/fixtures/library.ts";
import searchExtension, { nearMatchesWith } from "../src/extension.ts";

const script = fileURLToPath(new URL("./fixtures/embed-script.ts", import.meta.url));
const calls = ((globalThis as { embedCalls?: { image: number; text: number } }).embedCalls ??= {
  image: 0,
  text: 0,
});

const lib = fixtureLibrary();
const home = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-search-hosted-")));
const runs = join(home, "runs");
after(async () => {
  await rm(lib.dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

approve(script);

const extensions = new ExtensionRegistry([
  {
    extension: coreExtension,
    info: { package: "@clockgrove/assetgrove", version: null, entry: null },
  },
  {
    extension: searchExtension({ api: 1 }) as never,
    info: { package: "@clockgrove/assetgrove-search", version: null, entry: "test" },
  },
]);

const spec = (name: string): CommandSpec => commands.find((c) => c.name === name)!;

/** Hosted settings with the embeddings role on `provider` (the scripted one by default). */
function hosted(model = "scripted/embed-a", provider = "scripted"): void {
  writeSettings({
    search: { embedder: "route" },
    providers: {
      scripted: { limit: { kind: "prepaid", usd: 100 } },
      anthropic: {},
    },
    roles: { embeddings: { provider, model, estimatedCostUsd: 0.002 } },
  });
  useAttended();
}

/** Runs a command in process with a TTY port that says yes and records each request. */
async function run(
  name: string,
  args: Record<string, unknown>,
  asked: ConfirmRequest[] = [],
): Promise<Outcome> {
  const prompt: ConfirmPort = {
    method: "tty",
    confirm: async (request) => {
      asked.push(request);
      return true;
    },
  };
  const ctx: RunContext = { settings: loadSettings(), extensions, log: () => {}, prompt };
  return runCommand(spec(name), { target: lib.dir, providerScript: script, runs, ...args }, ctx);
}

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
  assert.ok(embedEntries().length >= embed.images + embed.texts, "every call is in the ledger");
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
  const lanternHit = (
    (await run("find", { where: ["subject=lantern"] })).fields["hits"] as { path: string }[]
  )[0]!;
  const reference = isAbsolute(lanternHit.path) ? lanternHit.path : join(lib.dir, lanternHit.path);
  const cwd = process.cwd();
  process.chdir(lib.dir);
  try {
    const near: RunContext = { settings: loadSettings(), extensions, log: () => {} };
    const spec = { kind: "still", assetId: "lantern", subject: "lantern" };
    for (const refs of [[], [reference]]) {
      const outcome = await nearMatchesFor(spec, refs, near);
      assert.equal(outcome.searchError, undefined, JSON.stringify(refs));
      // The shipped threshold is unmeasured (null), so a reference lists none; without, by subject.
      if (refs.length === 0) assert.ok((outcome.nearMatches ?? []).length > 0);
    }
    // With a threshold, the reference's stored vector finds the lantern itself.
    const { context } = await searchCall("find", undefined, near);
    const image = new Uint8Array(readFileSync(reference));
    const matched = await nearMatchesWith(
      0.99,
      { kind: "still", subject: "lantern", references: [image], limit: 3 },
      context,
    );
    assert.deepEqual(
      matched.hits.map((h) => h.address),
      [`asset://${GAME}/lantern`],
    );
  } finally {
    process.chdir(cwd);
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
  const flows = routeDataFlows(loadSettings());
  const flow = flows.find((f) => f.operation === "embed");
  assert.equal(flow?.providerId, "scripted");
});

test("an index built by another embedder exits 2 embedder_changed until search index --rebuild", async () => {
  hosted("scripted/embed-a");
  assert.equal((await run("search index", {})).exitCode, 0);

  hosted("scripted/embed-b");
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
