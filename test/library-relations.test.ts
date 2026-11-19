import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { appendVersion, parseReview, writeReview } from "../src/library/review.ts";
import { fixtureLibrary } from "./fixtures/library.ts";
import type { FixtureLibrary } from "./fixtures/library.ts";
import type { Relationship, VersionReference } from "../src/library/relations.ts";

const cwd = fileURLToPath(new URL("..", import.meta.url));
interface Graph {
  edges: Relationship[];
  forward: Relationship[];
  reverse: Relationship[];
  changedSources: (Relationship & { currentSha256: string })[];
  affected: (VersionReference & { recordedSources: Relationship[] })[];
  problems: { file: string; code: string; reference: string; message: string }[];
}
function cli(
  lib: FixtureLibrary,
  command: string,
  ...args: string[]
): Promise<{ code: number; value: Graph }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.AI_GATEWAY_API_KEY;
    const child = execFile(
      process.execPath,
      ["src/cli.ts", "library", command, "--target", lib.dir, "--json", ...args],
      { cwd, env, timeout: 60_000 },
      (error, stdout, stderr) => {
        try {
          resolve({ code: error ? Number(error.code) : 0, value: JSON.parse(stdout) as Graph });
        } catch {
          reject(new Error(stdout + stderr));
        }
      },
    );
    child.stdin?.end();
  });
}
function lineage(lib: FixtureLibrary, asset: string, index: number, links: unknown) {
  const path = join(lib.root, `${asset}.review.json`);
  const record = parseReview(readFileSync(path, "utf8"), path);
  record.versions[index]!["lineage"] = links;
  writeFileSync(path, writeReview(record));
}
const ref = (lib: FixtureLibrary, asset: string, index = 0) => ({
  asset,
  sha256: lib.versions[asset.split("/").at(-1)!]![index]!,
});

test("CLI and MCP expose typed forward/reverse edges, exact changed hashes and transitive downstream versions; rebuild preserves records", async () => {
  const lib = fixtureLibrary();
  const client = new Client({ name: "relations-test", version: "1" });
  try {
    const old = ref(lib, "lantern", 1);
    const fern = ref(lib, "props/fern");
    const walk = ref(lib, "walk");
    const rock = ref(lib, "rock");
    lineage(lib, "props/fern", 0, [{ relation: "derived-from", ...old }]);
    lineage(lib, "walk", 0, [{ relation: "variant-of", ...fern }]);
    lineage(lib, "rock", 0, [{ relation: "part-of", ...walk }]);
    const expected: Relationship[] = [
      {
        relation: "derived-from",
        downstream: fern,
        source: old,
        reference: "props/fern.review.json:ag:versions[0].lineage[0]",
      },
      {
        relation: "part-of",
        downstream: rock,
        source: walk,
        reference: "rock.review.json:ag:versions[0].lineage[0]",
      },
      {
        relation: "variant-of",
        downstream: walk,
        source: fern,
        reference: "walk.review.json:ag:versions[0].lineage[0]",
      },
    ];
    assert.deepEqual((await cli(lib, "relations")).value.changedSources, []);
    const sourcePath = join(lib.root, "lantern.review.json");
    const sourceRecord = parseReview(readFileSync(sourcePath, "utf8"), sourcePath);
    const replacementHash = "e".repeat(64);
    writeFileSync(
      sourcePath,
      writeReview(
        appendVersion(sourceRecord, {
          sha256: replacementHash,
          at: "2026-11-19T00:00:00Z",
        }),
      ),
    );
    const result = await cli(lib, "relations");
    assert.equal(result.code, 0);
    assert.deepEqual(result.value.edges, expected);
    assert.deepEqual(result.value.forward, expected);
    assert.deepEqual(result.value.reverse, expected);
    const selected = await cli(lib, "relations", "--asset", "props/fern", "--sha256", fern.sha256);
    assert.deepEqual(selected.value.forward, [expected[0]]);
    assert.deepEqual(selected.value.reverse, [expected[2]]);
    const historical = await cli(lib, "relations", "--asset", "lantern", "--sha256", old.sha256);
    assert.deepEqual(historical.value.reverse, [expected[0]]);
    const replacement = await cli(
      lib,
      "relations",
      "--asset",
      "lantern",
      "--sha256",
      replacementHash,
    );
    assert.deepEqual(replacement.value.reverse, []);
    assert.deepEqual(result.value.changedSources, [
      { ...expected[0], currentSha256: replacementHash },
    ]);
    assert.deepEqual(result.value.affected, [
      { ...fern, recordedSources: [expected[0]] },
      { ...rock, recordedSources: [expected[1]] },
      { ...walk, recordedSources: [expected[2]] },
    ]);
    assert.equal("freshness" in result.value, false);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== "AI_GATEWAY_API_KEY",
      ),
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["src/cli.ts", "mcp"],
        cwd,
        env,
        stderr: "pipe",
      }),
    );
    const mcp = await client.callTool({
      name: "library_relations",
      arguments: { target: lib.dir },
    });
    assert.deepEqual(mcp.structuredContent, result.value);
    const filtered = await client.callTool({
      name: "library_relations",
      arguments: { target: lib.dir, asset: "props/fern", sha256: fern.sha256 },
    });
    assert.deepEqual(filtered.structuredContent, selected.value);
    await cli(lib, "rebuild");
    assert.deepEqual((await cli(lib, "relations")).value, result.value);
  } finally {
    await client.close();
    await rm(lib.dir, { recursive: true, force: true });
  }
});

test("invalid lineage and cycles name exact offending version references through relations and library check/rebuild", async () => {
  const lib = fixtureLibrary();
  try {
    lineage(lib, "lantern", 0, [{ relation: "derived-from", ...ref(lib, "walk") }]);
    lineage(lib, "walk", 0, [{ relation: "part-of", ...ref(lib, "lantern") }]);
    lineage(lib, "rock", 0, [
      { relation: "variant-of", asset: "missing", sha256: "f".repeat(64) },
      { relation: "derived-from", asset: "../escape", sha256: "a".repeat(64) },
      { relation: "invented", ...ref(lib, "lantern") },
    ]);
    const result = await cli(lib, "relations");
    assert.equal(result.code, 6);
    assert.deepEqual(
      result.value.problems.map(({ file, reference, code }) => ({ file, reference, code })),
      [
        {
          file: "lantern.review.json",
          reference: "ag:versions[0].lineage[0]",
          code: "lineage_cycle",
        },
        ...[0, 1, 2].map((i) => ({
          file: "rock.review.json",
          reference: `ag:versions[0].lineage[${i}]`,
          code: "lineage_invalid",
        })),
        { file: "walk.review.json", reference: "ag:versions[0].lineage[0]", code: "lineage_cycle" },
      ],
    );
    assert.match(result.value.problems[1]!.message, /missing@f{64}/);
    assert.match(result.value.problems[2]!.message, /\.\.\/escape/);
    for (const command of ["check", "rebuild"]) {
      const checked = await cli(lib, command);
      assert.equal(checked.code, 6);
      assert.deepEqual(
        checked.value.problems.filter((p) => p.code.startsWith("lineage_")),
        result.value.problems,
      );
    }
    assert.deepEqual((await cli(lib, "relations")).value, result.value);
  } finally {
    await rm(lib.dir, { recursive: true, force: true });
  }
});

test("reordered raw versions retain exact lineage references", async () => {
  const lib = fixtureLibrary();
  try {
    const path = join(lib.root, "lantern.review.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw["ag:versions"].reverse();
    raw["ag:versions"][0].lineage = [
      { relation: "derived-from", ...ref(lib, "walk") },
      { relation: "invalid", ...ref(lib, "walk") },
    ];
    writeFileSync(path, JSON.stringify(raw));
    const result = await cli(lib, "relations");
    assert.equal(result.value.edges[0]!.reference, "lantern.review.json:ag:versions[0].lineage[0]");
    assert.equal(result.value.problems[0]!.reference, "ag:versions[0].lineage[1]");
    const checked = await cli(lib, "check");
    assert.deepEqual(
      checked.value.problems.filter((p) => p.code.startsWith("lineage_")),
      result.value.problems,
    );
    await cli(lib, "rebuild");
    const rebuilt = JSON.parse(readFileSync(path, "utf8"));
    const rebuiltIndex = rebuilt["ag:versions"].findIndex(
      (v: { lineage?: unknown }) => v.lineage !== undefined,
    );
    const after = await cli(lib, "relations");
    assert.equal(after.value.problems[0]!.reference, `ag:versions[${rebuiltIndex}].lineage[1]`);
  } finally {
    await rm(lib.dir, { recursive: true, force: true });
  }
});
