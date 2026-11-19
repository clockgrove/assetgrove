import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { modelDeclarationRecord } from "../src/model-declarations.ts";
import { resolveRoutes } from "../src/routes.ts";
import type { Route, RouteProvider } from "../src/routes.ts";
import { Journal, withRunScope } from "../src/runs/journal.ts";
import { loadSettings } from "../src/settings.ts";
import type { CallRecord } from "../src/types.ts";

const declarations = {
  source: {
    statement: "Model weights derived from Example Base v2.",
    evidence: "https://example.invalid/model-card#source",
  },
  trainingData: {
    statement: "Provider reports licensed and synthetic training images.",
    evidence: "https://example.invalid/model-card#data",
  },
};
const unknown = { status: "unknown" };

async function settingsFor(dir: string, route: Record<string, unknown>) {
  const path = join(dir, "settings.json");
  await writeFile(
    path,
    JSON.stringify({
      format: "assetgrove-settings/1",
      providers: { scripted: {} },
      routes: { still: route },
    }),
  );
  return loadSettings({ env: { ASSETGROVE_CONFIG: path, HOME: dir }, cwd: dir });
}

const providerFor = (route: Route): RouteProvider[] => [
  {
    id: "scripted",
    adapter: { id: "scripted", capabilities: ["image"], defaultRoutes: { still: route } },
  },
];

test("supplied model source and training declarations survive settings, route and persisted call records", async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-model-declarations-")));
  try {
    const settings = await settingsFor(dir, {
      provider: "scripted",
      model: "example-model",
      modelDeclarations: declarations,
    });
    const routes = resolveRoutes(
      settings,
      providerFor({ model: "example-model", estimatedCostUsd: 0.1 }),
    );
    assert.deepEqual(routes.still.modelDeclarations, declarations);
    const provider = new ScriptedProvider({
      image: () => ({
        images: [{ mediaType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }],
      }),
      vision: () => ({ text: "" }),
    });
    const caller = new Caller({ provider, budget: new Budget(1), routes });
    await withRunScope({ journal: new Journal(dir, "r-0000000000000000") }, () =>
      caller.image("still", "an original gem", []),
    );
    const files = await readdir(join(dir, "calls"));
    const persisted = JSON.parse(
      await readFile(
        join(
          dir,
          "calls",
          files.find((file) => file.endsWith(".json"))!,
        ),
        "utf8",
      ),
    ) as { record: CallRecord };
    assert.deepEqual(persisted.record.modelDeclarations, {
      source: { status: "documented", ...declarations.source },
      trainingData: { status: "documented", ...declarations.trainingData },
    });
    assert.equal(persisted.record.outputGrant, undefined);
    routes.still.modelDeclarations!.source!.statement = "Changed after recording";
    assert.equal(caller.records[0]?.modelDeclarations?.source.status, "documented");
    assert.deepEqual(caller.records[0]?.modelDeclarations?.source, {
      status: "documented",
      ...declarations.source,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing model facts remain unknown and changed model overrides do not inherit declarations", async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-model-unknown-")));
  try {
    const settings = await settingsFor(dir, { provider: "scripted", model: "other-model" });
    const routes = resolveRoutes(
      settings,
      providerFor({
        model: "example-model",
        estimatedCostUsd: 0.1,
        modelDeclarations: declarations,
      }),
    );
    assert.equal(routes.still.modelDeclarations, undefined);
    assert.deepEqual(modelDeclarationRecord(routes.still.modelDeclarations), {
      source: unknown,
      trainingData: unknown,
    });
    assert.deepEqual(modelDeclarationRecord({ source: declarations.source }), {
      source: { status: "documented", ...declarations.source },
      trainingData: unknown,
    });
    const partial = await settingsFor(dir, {
      provider: "scripted",
      model: "example-model",
      modelDeclarations: { source: declarations.source },
    });
    assert.deepEqual(
      resolveRoutes(
        partial,
        providerFor({
          model: "example-model",
          estimatedCostUsd: 0.1,
          modelDeclarations: declarations,
        }),
      ).still.modelDeclarations,
      { source: declarations.source },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("model declarations require documentary evidence and reject unknown settings fields", async () => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-model-invalid-")));
  try {
    await assert.rejects(
      settingsFor(dir, {
        provider: "scripted",
        model: "m",
        modelDeclarations: { source: { statement: "a claim" } },
      }),
      /evidence/,
    );
    await assert.rejects(
      settingsFor(dir, {
        provider: "scripted",
        model: "m",
        modelDeclarations: { trainingData: { statement: "a claim", evidence: "", verified: true } },
      }),
      /evidence|verified/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
