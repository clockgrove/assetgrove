/**
 * The pack test kit, `@clockgrove/assetgrove/testing` (#414): the conformance suite passes a
 * conforming pack, fails an `exact` QA check that calls the `Caller` (even one that catches the
 * refusal) or answers differently the second time, and fails a pack that reaches the global
 * `fetch`; core runs a kind's exact checks under a refusing `Caller` too. The temporary project
 * runs core's CLI and commands against the pack it installs.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import type { Extension, ExtensionContext, KindCheck } from "../src/extension/api.ts";
import { runKindChecks } from "../src/generators/generator.ts";
import { defaultRoutes } from "../src/routes.ts";
import {
  assertConformance,
  RefusingCaller,
  runConformance,
  sampleBible,
  samplePng,
  sampleProfile,
  ScriptedProvider,
  sampleScript,
  tempProject,
} from "../src/testing/index.ts";
import type { KindSample } from "../src/testing/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/extension-package", import.meta.url));
const project = tempProject();
after(() => project.close());
const installed = project.install(fixture, "assetgrove-fixture-extension");
const fixtureEntry = (
  (await import(pathToFileURL(join(installed, "index.js")).href)) as {
    default: (c: ExtensionContext) => Extension;
  }
).default;

const tileSample: KindSample = {
  spec: { kind: "fixture:tile", assetId: "tile-1", animationFamily: "idle" } as KindSample["spec"],
};

/** A pack with one kind whose only check is `check`. */
function packWith(check: KindCheck): (c: ExtensionContext) => Extension {
  return ({ z }) => ({
    api: 2,
    name: "probe",
    kinds: [
      {
        kind: "probe:dot",
        planCandidate: () => [],
        generate: async () => ({
          output: { mediaType: "image/png", extension: "png", bytes: samplePng(), fields: {} },
          qa: { passed: true, reasons: [] },
          prompt: "a dot",
          parameters: {},
        }),
        checks: [check],
      },
    ],
    presets: [
      {
        name: "probe:list",
        optionsSchema: z.strictObject({}),
        write: () => [{ path: "list.txt", content: "dot\n" }],
        check: async (_c, _o, _f, read) =>
          (await read("list.txt")) === undefined ? ["list.txt is missing"] : [],
      },
    ],
  });
}

const probeSample = {
  kinds: { "probe:dot": { spec: { kind: "probe:dot" } as KindSample["spec"] } },
};

const opaque: KindCheck = {
  name: "opaque",
  mode: "exact",
  run: (input) => [
    {
      check: "opaque",
      passed: input.output.bytes.length > 0,
      reason: "has bytes",
      source: "deterministic",
    },
  ],
};

test("the fixture pack passes the conformance suite: adapter, kind and preset", async () => {
  const report = await assertConformance(fixtureEntry, { kinds: { "fixture:tile": tileSample } });
  assert.ok(report.checked.some((c) => c.startsWith("adapter fixture:echo")));
  assert.ok(
    report.checked.some((c) => c === "kind fixture:tile: generate on the scripted provider"),
  );
  assert.ok(report.checked.some((c) => c.startsWith("preset fixture:list")));
});

test("a deterministic exact check that makes no call passes, run twice", async () => {
  const report = await runConformance(packWith(opaque), probeSample);
  assert.deepEqual(report.failures, []);
  assert.ok(
    report.checked.includes("kind probe:dot: exact check opaque, twice under a refusing Caller"),
  );
});

test("an exact check that calls the Caller fails the suite", async () => {
  const calling: KindCheck = {
    name: "asks-a-model",
    mode: "exact",
    run: async (_input, call) => {
      await call.vision("vision", "is it opaque?", []);
      return [];
    },
  };
  const report = await runConformance(packWith(calling), probeSample);
  assert.equal(report.passed, false);
  assert.deepEqual(report.failures, [
    "kind probe:dot exact check asks-a-model made a provider call (vision) on run 1",
  ]);
  await assert.rejects(assertConformance(packWith(calling), probeSample), /made a provider call/);
});

test("an exact check that catches the refusal still fails: the attempt is seen", async () => {
  const sneaky: KindCheck = {
    name: "sneaky",
    mode: "exact",
    run: async (_input, call) => {
      try {
        await call.decide("decide", "?", [], { type: "boolean", label: "x" } as never);
      } catch {
        // swallowed
      }
      return [];
    },
  };
  const report = await runConformance(packWith(sneaky), probeSample);
  assert.deepEqual(report.failures, [
    "kind probe:dot exact check sneaky made a provider call (decide) on run 1",
  ]);
});

test("an exact check that answers differently the second time fails the suite", async () => {
  let n = 0;
  const flaky: KindCheck = {
    name: "flaky",
    mode: "exact",
    run: () => [
      { check: "flaky", passed: ++n % 2 === 1, reason: `run ${n}`, source: "deterministic" },
    ],
  };
  const report = await runConformance(packWith(flaky), probeSample);
  assert.equal(report.passed, false);
  assert.equal(report.failures.length, 1);
  assert.match(
    report.failures[0]!,
    /^kind probe:dot exact check flaky is not deterministic: it answered .*run 1.* and then .*run 2/,
  );
});

test("a model check that throws on the scripted provider fails the suite, and a kind without a sample fails", async () => {
  const model: KindCheck = {
    ...opaque,
    name: "looks-right",
    mode: "model",
    run: () => {
      throw new Error("ran");
    },
  };
  const report = await runConformance(packWith(model), probeSample);
  assert.equal(report.failures.length, 1);
  assert.match(
    report.failures[0]!,
    /^kind probe:dot model check looks-right threw on the scripted provider: ran/,
  );
  const missing = await runConformance(packWith(opaque), {});
  assert.deepEqual(missing.failures, [
    "kind probe:dot has no sample: give options.kinds[<kind>] a spec",
  ]);
});

test("the suite runs with the global fetch trapped: a pack that reaches it fails", async () => {
  const reaching = (c: ExtensionContext): Extension => {
    const pack = packWith(opaque)(c);
    pack.kinds![0]!.generate = async (ctx) => {
      await fetch("https://example.test/steal").catch(() => undefined);
      return packWith(opaque)(c).kinds![0]!.generate(ctx);
    };
    return pack;
  };
  const report = await runConformance(reaching, probeSample);
  assert.deepEqual(report.failures, [
    "reached the global fetch (https://example.test/steal); use the context's http",
  ]);
  assert.notEqual(globalThis.fetch.name, "", "the global fetch is restored");
});

test("a preset whose check passes with nothing written fails the suite", async () => {
  const lax = (c: ExtensionContext): Extension => {
    const pack = packWith(opaque)(c);
    pack.presets![0]!.check = async () => [];
    return pack;
  };
  const report = await runConformance(lax, probeSample);
  assert.deepEqual(report.failures, [
    "preset probe:list check passed with none of its files written, so it checks nothing",
  ]);
});

test("core runs a kind's exact checks under a refusing Caller and model ones under the candidate's", async () => {
  const seen: string[] = [];
  const probe = (name: string, mode: KindCheck["mode"]): KindCheck => ({
    name,
    mode,
    run: (_input, call) => {
      seen.push(`${name}:${call instanceof RefusingCaller ? "refusing" : "candidate"}`);
      return [{ check: name, passed: true, reason: "ok", source: "deterministic" }];
    },
  });
  const call = new Caller({
    provider: new ScriptedProvider(sampleScript()),
    budget: new Budget(1),
    routes: defaultRoutes,
  });
  const reasons = await runKindChecks(
    [probe("exact-one", "exact"), probe("model-one", "model")],
    {
      spec: { kind: "probe:dot" } as KindSample["spec"],
      profile: sampleProfile(),
      bible: sampleBible(),
      output: { mediaType: "image/png", extension: "png", bytes: samplePng(), fields: {} },
    },
    call,
    () => new RefusingCaller(),
  );
  assert.deepEqual(seen, ["exact-one:refusing", "model-one:candidate"]);
  assert.equal(reasons.length, 2);
});

test("the temporary project runs core's CLI and commands with the pack installed and listed", async () => {
  project.writeSettings({ extensions: ["assetgrove-fixture-extension"] });
  const listed = await project.cli(["extensions", "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  const names = (listed.json?.["extensions"] as Array<{ name: string }>).map((e) => e.name);
  assert.deepEqual(names, ["core", "fixture"]);
  const inProcess = await project.run("extensions", {}, { extensions: [fixtureEntry] });
  assert.equal(inProcess.exitCode, 0, JSON.stringify(inProcess.error));
  project.writeSettings();
});
