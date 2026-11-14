import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BIBLE_PRESETS, loadBible, serializeBible } from "../src/bible.ts";
import { migrateCommand } from "../src/commands/migrate.ts";
import { FORMAT_VERSIONS, registerMigration, unregisterMigration } from "../src/formats.ts";
import { loadProfile } from "../src/inputs.ts";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function cli(...args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await exec(process.execPath, [CLI, ...args]);
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code: number; stdout: string };
    return { code: e.code, stdout: e.stdout };
  }
}

const workdir = () => mkdtemp(join(tmpdir(), "assetgrove-migrate-"));

test("migrate adds the format line to an unversioned profile, then reports it current", async () => {
  const file = join(await workdir(), "profile.json");
  await writeFile(file, JSON.stringify({ name: "x", license: "MIT" }));
  await assert.rejects(loadProfile(file), { code: "format_unsupported" });

  const added = await cli("migrate", file, "--kind", "target-profile", "--json");
  assert.equal(added.code, 0);
  const result = JSON.parse(added.stdout) as Record<string, unknown>;
  assert.equal(result["status"], "added");
  assert.equal(result["from"], null);
  assert.equal(result["format"], "assetgrove-target-profile/1");
  const text = await readFile(file, "utf8");
  assert.equal(Object.keys(JSON.parse(text) as object)[0], "format");
  assert.ok(text.endsWith("}\n"));
  assert.equal((await loadProfile(file)).value.name, "x");

  const again = await cli("migrate", file, "--kind", "target-profile", "--json");
  assert.equal((JSON.parse(again.stdout) as Record<string, unknown>)["status"], "current");
  assert.equal(await readFile(file, "utf8"), text);
});

test("migrate adds the format line to a Markdown style preset and keeps the prose", async () => {
  const prose = "# X\n\n## Do's and Don'ts\n\nDo.\n";
  const source = serializeBible(
    structuredClone(BIBLE_PRESETS["cozy-storybook"]!),
    prose,
    "style-preset",
  );
  const stripped = source.replace(/^format:.*\n/m, "");
  assert.notEqual(stripped, source);
  const file = join(await workdir(), "preset.md");
  await writeFile(file, stripped);
  await assert.rejects(loadBible(file, "style-preset"), { code: "format_unsupported" });

  const run = await cli("migrate", file, "--kind", "style-preset", "--json");
  assert.equal((JSON.parse(run.stdout) as Record<string, unknown>)["status"], "added");
  const text = await readFile(file, "utf8");
  assert.ok(text.startsWith("---\nformat: assetgrove-style-preset/1\n"));
  assert.ok(text.endsWith(`---\n${prose}`));
  assert.equal((await loadBible(file, "style-preset")).prose, prose);
});

test("migrate moves an older version forward", async () => {
  const versions = FORMAT_VERSIONS as Record<string, number>;
  const file = join(await workdir(), "recipe.json");
  await writeFile(file, JSON.stringify({ format: "assetgrove-recipe/1", steps: [] }));
  versions["recipe"] = 2;
  registerMigration("recipe", 1, (value) => ({ ...value, note: "moved" }));
  try {
    const outcome = await migrateCommand.run(
      { file, kind: "recipe" },
      { settings: {} as never, log: () => {} },
    );
    assert.equal(outcome.fields["status"], "migrated");
    assert.equal(outcome.fields["from"], 1);
    assert.equal(outcome.fields["format"], "assetgrove-recipe/2");
    const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    assert.deepEqual(written, { format: "assetgrove-recipe/2", steps: [], note: "moved" });
  } finally {
    unregisterMigration("recipe", 1);
    versions["recipe"] = 1;
  }
});

test("migrate refuses an unknown kind with exit 2", async () => {
  const file = join(await workdir(), "profile.json");
  await writeFile(file, "{}");
  const run = await cli("migrate", file, "--kind", "nonsense", "--json");
  assert.equal(run.code, 2);
  assert.equal(await readFile(file, "utf8"), "{}");
});
