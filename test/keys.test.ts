import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { HARNESSES, keyRecipe } from "../src/keys.ts";

const markers = (text: string): string[] =>
  [...text.matchAll(/`key:([a-z0-9.-]+)`/g)].map((match) => match[1]!).sort();

const ids = (harnesses: readonly string[]): string[] =>
  harnesses.flatMap((harness) => keyRecipe(harness).steps.map((step) => step.id)).sort();

test("every harness has steps with unique ids prefixed by the harness", () => {
  for (const harness of HARNESSES) {
    const recipe = keyRecipe(harness);
    assert.equal(recipe.harness, harness);
    assert.ok(recipe.steps.length >= 1);
    assert.ok(recipe.limits.length >= 1);
    const stepIds = recipe.steps.map((step) => step.id);
    assert.equal(new Set(stepIds).size, stepIds.length);
    for (const id of stepIds) assert.match(id, new RegExp(`^${harness}\\.[a-z0-9-]+$`));
  }
});

test("claude-code steps deny Read and Edit of configDir and stateDir", () => {
  const cases = [
    { dirs: undefined, config: "<configDir>", state: "<stateDir>" },
    {
      dirs: {
        configDir: "/home/a/.config/assetgrove",
        stateDir: "/home/a/.local/state/assetgrove",
      },
      config: "home/a/.config/assetgrove",
      state: "home/a/.local/state/assetgrove",
    },
    {
      dirs: { configDir: "C:\\Users\\a\\cfg", stateDir: "C:\\Users\\a\\st" },
      config: "C:/Users/a/cfg",
      state: "C:/Users/a/st",
    },
  ];
  for (const { dirs, config, state } of cases) {
    const deny = keyRecipe("claude-code", dirs).steps.flatMap(
      (step) => step.rules?.permissionsDeny ?? [],
    );
    for (const verb of ["Read", "Edit"]) {
      assert.ok(deny.includes(`${verb}(//${config}/**)`), `${verb} ${config}`);
      assert.ok(deny.includes(`${verb}(//${state}/**)`), `${verb} ${state}`);
    }
    assert.ok(deny.includes("Read(~/.claude.json)"));
  }
  const hosts = keyRecipe("claude-code").steps.find(
    (step) => step.id === "claude-code.no-provider-hosts",
  )?.rules?.providerHosts;
  assert.ok(hosts?.includes("ai-gateway.vercel.sh"));
});

test("docs/keys.md marks every step id", async () => {
  assert.deepEqual(markers(await readFile("docs/keys.md", "utf8")), ids(HARNESSES));
});

test("docs/testing-hosts.md marks the steps of the four hosted harnesses", async () => {
  const hosted = HARNESSES.filter((harness) => harness !== "other");
  assert.deepEqual(markers(await readFile("docs/testing-hosts.md", "utf8")), ids(hosted));
});

test("docs/quick-start.md's key section marks the claude-code steps", async () => {
  const text = await readFile("docs/quick-start.md", "utf8");
  const section = /^## [^\n]*Keys[^\n]*\n([\s\S]*?)(?=^## )/m.exec(text)?.[1];
  assert.ok(section, "docs/quick-start.md has a key section");
  assert.deepEqual(markers(section), ids(["claude-code"]));
});

test("an unknown harness throws", () => {
  assert.throws(() => keyRecipe("nope"), /Unknown harness/);
});
