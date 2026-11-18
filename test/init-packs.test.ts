import "./fixtures/env.ts";
import { gitTarget } from "./fixtures/git.ts";
import { resetSettings, writeSettings } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { keyRecipe } from "../src/keys.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/extension-keyed-package", import.meta.url));
const PACKAGE = "assetgrove-fixture-keyed";
after(() => resetSettings());

function cli(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [join(root, "src", "cli.ts"), ...args],
      { cwd, env: process.env },
      (error, stdout, stderr) =>
        resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}

async function project(paint: Record<string, string> = {}): Promise<string> {
  const dir = gitTarget(await mkdtemp(join(realpathSync(tmpdir()), "assetgrove-initpack-")));
  cpSync(fixture, join(dir, "node_modules", PACKAGE), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "a-game", private: true, dependencies: { [PACKAGE]: "1.0.0" } }),
  );
  writeSettings({
    extensions: [PACKAGE],
    providers: { paint: { adapter: "keyed:paint", ...paint } },
    routes: { still: { provider: "paint", model: "paint-1", estimatedCostUsd: 0.01 } },
  });
  return dir;
}

const initArgs = (dir: string, ...more: string[]) => [
  "init",
  "--directory",
  dir,
  "--profile-preset",
  "sprite-32",
  "--style-preset",
  "cozy-storybook",
  "--world",
  "Testland",
  "--providers",
  "keyed:paint",
  ...more,
];

test("init lists a listed pack's adapter, hosts and key recipe", async () => {
  const dir = await project();
  const result = await cli([...initArgs(dir), "--json"], dir);
  assert.equal(result.code, 0, result.stderr);
  const doc = JSON.parse(result.stdout);

  assert.deepEqual(doc.adapters, [
    {
      adapter: "keyed:paint",
      extension: "keyed",
      package: PACKAGE,
      hosts: ["api.keyed.example"],
      endpointFromSettings: false,
      keyEnv: "KEYED_API_KEY",
    },
  ]);

  const still = doc.providers.find((f: { operation: string }) => f.operation === "still");
  assert.equal(still.providerId, "paint");
  assert.equal(still.host, "api.keyed.example");

  const step = (id: string) => doc.steps.find((s: { id: string }) => s.id === id);
  assert.ok(
    step("claude-code.no-provider-hosts").rules.providerHosts.includes("api.keyed.example"),
  );
  assert.match(step("claude-code.user-scope").detail, /KEYED_API_KEY \(keyed:paint\)/);

  assert.equal(step("settings").suggestedRoles.image.provider, "keyed:paint");
});

test("the human output lists the pack's adapter", async () => {
  const dir = await project();
  const result = await cli(initArgs(dir), dir);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(
      `- pack adapter keyed:paint \\(${PACKAGE}\\): hosts api.keyed.example; key KEYED_API_KEY`,
    ),
  );
});

test("init names the key variable the settings give a pack adapter", async () => {
  const dir = await project({ keyEnv: "PAINT_KEY" });
  const result = await cli([...initArgs(dir), "--json"], dir);
  assert.equal(result.code, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.adapters[0].keyEnv, "PAINT_KEY");
  const first = doc.steps.find((s: { id: string }) => s.id === "claude-code.user-scope");
  assert.match(first.detail, /PAINT_KEY \(keyed:paint\)/);
  assert.doesNotMatch(first.detail, /KEYED_API_KEY/);

  const human = await cli(initArgs(dir), dir);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /- pack adapter keyed:paint .*; key PAINT_KEY/);
});

test("a core-only key recipe names no pack key", () => {
  const recipe = keyRecipe("claude-code");
  assert.ok(!JSON.stringify(recipe).includes("KEYED"));
  assert.ok(!recipe.steps[0]!.text.includes("pack adapter"));
});
