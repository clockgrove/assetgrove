/**
 * The pack conformance suite (`@clockgrove/assetgrove/testing`, design section 11): what a pack runs
 * in its own tests on its adapters, kinds and presets. The whole suite runs with the global `fetch`
 * trapped, so a pack that reaches the network outside its guarded `http` fails. Every `exact` QA
 * check of every kind runs twice, each time under a `Caller` that refuses every call: an exact check
 * that makes a call, throws, or answers differently the second time fails the suite; every `model`
 * check that runs is run once on the scripted provider. A kind whose `generate` or check returns a
 * reason naming a check neither the kind nor core declares fails it too: core would record that
 * reason advisory (`cause: "undeclared"`), never filtering.
 */
import { createHash } from "node:crypto";
import { AssertionError } from "node:assert";
import { isAbsolute } from "node:path";
import { Budget } from "../budget.ts";
import { Caller, RefusingCaller } from "../calls.ts";
import { bindExtensionSettings, createExtensionContext } from "../extension/context.ts";
import type {
  AssetKind,
  EnginePreset,
  Extension,
  ExtensionEntry,
  KindCheck,
  KindCheckInput,
  FamiliesContext,
  PresetContext,
  PresetFile,
  ProviderAdapter,
} from "../extension/api.ts";
import { coreExtension } from "../extensions/core.ts";
import { checkExtension, packSettingsOf } from "../extensions/registry.ts";
import { checkOf, kindQaRegistry } from "../qa/stability.ts";
import type { QaCheck } from "../qa/stability.ts";
import type { Script } from "../gateway/scripted.ts";
import { ScriptedProvider } from "../gateway/scripted.ts";
import { createProvider } from "../providers/adapter.ts";
import { defaultRoutes, ROLE_DEFAULT_OPERATION } from "../routes.ts";
import type { Routes } from "../routes.ts";
import type { ProviderSettings } from "../settings.ts";
import type { AssetSpec, MediaOutput, Reason, StyleBible, TargetProfile } from "../types.ts";
import { sampleBible, samplePng, sampleProfile, sampleScript } from "./samples.ts";
import { refusingToolRunner } from "../extension/tools.ts";

/** One kind's sample: what the suite plans, generates and checks it with. */
export interface KindSample {
  spec: AssetSpec;
  /** The synthetic `sampleBible()` when absent. */
  bible?: StyleBible;
  /** The synthetic `sampleProfile()` when absent. */
  profile?: TargetProfile;
  /**
   * The candidate media the kind's checks read; when absent the suite generates one through the
   * scripted provider (`script`, else `sampleScript()`).
   */
  output?: MediaOutput;
  script?: Script;
}

/** One preset's sample: its profile entry's `options` and the context it writes from. */
export interface PresetSample {
  options?: unknown;
  /** For a `scope: "families"` preset, fields of its `FamiliesContext`. */
  context?: Partial<PresetContext> | Partial<FamiliesContext>;
}

export interface ConformanceOptions {
  /** The package name the context's `log` names; `conformance` when absent. */
  name?: string;
  /** A sample for each kind, by its id. Every kind needs one. */
  kinds?: Record<string, KindSample>;
  /** A sample for each preset, by its name; `{}` options when absent. */
  presets?: Record<string, PresetSample>;
  /** The settings entry each adapter is created from, by its id. */
  adapters?: Record<string, ProviderSettings>;
  /**
   * The pack's `extensionSettings` block, checked against its `settingsSchema` as core checks it
   * and handed over as `context.settings`; absent, the schema's defaults alone.
   */
  settings?: Record<string, unknown>;
}

export interface ConformanceReport {
  passed: boolean;
  /** One line per failure, naming the id and what failed. */
  failures: string[];
  /** One line per check that ran. */
  checked: string[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The pack's extension, as core would load it: the default export, or its factory's result, whose
 * `context.settings` then holds `settings` (the pack's block) checked against its `settingsSchema`.
 */
export async function resolveEntry(
  entry: ExtensionEntry,
  name = "conformance",
  settings?: Record<string, unknown>,
): Promise<Extension> {
  if (typeof entry !== "function") return entry;
  const context = createExtensionContext(name);
  const extension = await entry(context);
  const schema: unknown = (extension as Partial<Extension> | null)?.settingsSchema;
  // A schema that is not zod is left for checkExtension to refuse.
  if (schema === undefined || typeof (schema as { safeParse?: unknown }).safeParse === "function")
    bindExtensionSettings(context, packSettingsOf(extension, name, settings, "the pack settings"));
  return extension;
}

/** Replaces the global `fetch` while `body` runs; every call is recorded and refused. */
async function withFetchTrapped<T>(trapped: string[], body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    trapped.push(url);
    return Promise.reject(new Error(`the conformance suite traps the global fetch (${url})`));
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

function reasonProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "did not return a list of reasons";
  for (const r of value as Array<Partial<Reason> | null>) {
    if (
      typeof r?.check !== "string" ||
      typeof r.passed !== "boolean" ||
      typeof r.reason !== "string" ||
      !["deterministic", "vision", "decision"].includes(r.source as string)
    )
      return `returned a reason that is not {check, passed, reason, source}: ${JSON.stringify(r)}`;
  }
  return undefined;
}

/** Runs one `exact` check twice, each under a refusing Caller; the problems it shows. */
export async function exactCheckProblems(
  check: KindCheck & Pick<Required<KindCheck>, "run">,
  input: KindCheckInput,
): Promise<string[]> {
  const answers: string[] = [];
  for (const pass of [1, 2]) {
    const caller = new RefusingCaller(`exact check ${check.name} makes no provider call`);
    let result: unknown;
    try {
      result = await check.run(input, caller);
    } catch (error) {
      if (caller.attempts.length > 0)
        return [`made a provider call (${caller.attempts.join(", ")}) on run ${pass}`];
      return [`threw on run ${pass}: ${messageOf(error)}`];
    }
    if (caller.attempts.length > 0)
      return [`made a provider call (${caller.attempts.join(", ")}) on run ${pass}`];
    const shape = reasonProblem(result);
    if (shape !== undefined) return [`${shape} on run ${pass}`];
    answers.push(JSON.stringify(result));
  }
  return answers[0] === answers[1]
    ? []
    : [`is not deterministic: it answered ${answers[0]} and then ${answers[1]}`];
}

function routesFor(ext: Extension): Routes {
  const routes: Record<string, unknown> = { ...defaultRoutes };
  for (const adapter of ext.adapters ?? [])
    for (const [op, route] of Object.entries(adapter.defaultRoutes ?? {}))
      routes[op] ??= { ...route, provider: adapter.id };
  // A kind's own operation takes its role's default route, as core resolves it (src/routes.ts).
  for (const kind of ext.kinds ?? [])
    for (const [op, role] of Object.entries(kind.operations ?? {})) {
      const fallback = routes[ROLE_DEFAULT_OPERATION[role] ?? ""];
      if (fallback !== undefined) routes[op] ??= fallback;
    }
  return routes as unknown as Routes;
}

/** The checks a list of reasons names that no declaration covers, each once. */
function undeclaredOf(reasons: readonly Reason[], checks: readonly QaCheck[]): string[] {
  return [...new Set(reasons.filter((r) => checkOf(r, checks) === undefined).map((r) => r.check))];
}

async function checkKind(
  kind: AssetKind,
  sample: KindSample | undefined,
  routes: Routes,
  declared: readonly QaCheck[],
  fail: (why: string) => void,
  ran: (what: string) => void,
): Promise<void> {
  if (sample === undefined) {
    fail("has no sample: give options.kinds[<kind>] a spec");
    return;
  }
  const profile = sample.profile ?? sampleProfile();
  const bible = sample.bible ?? sampleBible();
  try {
    const planned = kind.planCandidate(sample.spec, profile, routes);
    if (!Array.isArray(planned)) fail("planCandidate did not return a list");
    else
      for (const call of planned)
        if (typeof call?.operation !== "string" || !(call.estimatedCostUsd >= 0))
          fail(`planCandidate returned a call without an operation and an estimate`);
    ran("planCandidate");
  } catch (error) {
    fail(`planCandidate threw: ${messageOf(error)}`);
    return;
  }
  let output = sample.output;
  if (output === undefined) {
    try {
      const provider = new ScriptedProvider(sample.script ?? sampleScript());
      const generated = await kind.generate({
        spec: sample.spec,
        specDir: process.cwd(),
        bible,
        bibleDir: process.cwd(),
        profile,
        call: new Caller({ provider, providerName: "scripted", budget: new Budget(100), routes }),
        index: 0,
        seed: 1,
      });
      output = generated?.output;
      if (
        typeof output?.mediaType !== "string" ||
        typeof output.extension !== "string" ||
        !(output.bytes instanceof Uint8Array) ||
        output.bytes.length === 0
      ) {
        fail("generate returned no media (output.mediaType, extension and bytes)");
        return;
      }
      if (typeof generated.qa?.passed !== "boolean") fail("generate returned no qa verdict");
      else {
        const shape = reasonProblem(generated.qa.reasons);
        if (shape !== undefined) fail(`generate's qa ${shape}`);
        else
          for (const id of undeclaredOf(generated.qa.reasons, declared))
            fail(
              `generate returned a reason for check "${id}", which neither the kind nor core declares; declare it in the kind's checks`,
            );
      }
      ran("generate on the scripted provider");
    } catch (error) {
      fail(`generate threw on the scripted provider: ${messageOf(error)}`);
      return;
    }
  }
  for (const check of kind.checks ?? []) {
    const run = check.run;
    if (run === undefined) {
      ran(`${check.mode} check ${check.name}: declared, its reasons come from generate`);
      continue;
    }
    const input = { spec: sample.spec, profile, bible, output };
    if (check.mode !== "exact") {
      // A model check runs once on the scripted provider, so the reasons it returns are checked
      // against the kind's declarations as `stage` judges them.
      try {
        const provider = new ScriptedProvider(sample.script ?? sampleScript());
        const call = new Caller({
          provider,
          providerName: "scripted",
          budget: new Budget(100),
          routes,
        });
        const reasons = await run(input, call);
        const shape = reasonProblem(reasons);
        if (shape !== undefined) fail(`${check.mode} check ${check.name} ${shape}`);
        else
          for (const id of undeclaredOf(reasons, declared))
            fail(
              `${check.mode} check ${check.name} returned a reason for check "${id}", which neither the kind nor core declares`,
            );
      } catch (error) {
        fail(
          `${check.mode} check ${check.name} threw on the scripted provider: ${messageOf(error)}; give options.kinds[<kind>].script the answers it needs`,
        );
      }
      ran(`${check.mode} check ${check.name}, once on the scripted provider`);
      continue;
    }
    const problems = await exactCheckProblems({ ...check, run }, input);
    for (const problem of problems) fail(`exact check ${check.name} ${problem}`);
    if (problems.length === 0) {
      const reasons = await run(input, new RefusingCaller(`exact check ${check.name}`));
      for (const id of undeclaredOf(reasons, declared))
        fail(
          `exact check ${check.name} returned a reason for check "${id}", which neither the kind nor core declares`,
        );
    }
    ran(`exact check ${check.name}, twice under a refusing Caller`);
  }
}

async function checkPreset(
  preset: EnginePreset,
  sample: PresetSample | undefined,
  fail: (why: string) => void,
  ran: (what: string) => void,
): Promise<void> {
  let options: unknown;
  try {
    options = preset.optionsSchema.parse(sample?.options ?? {});
  } catch (error) {
    fail(`optionsSchema refused the sample options: ${messageOf(error)}`);
    return;
  }
  // The suite runs no program: a preset's tool run is refused here (sample.context may give one).
  const noTools = refusingToolRunner("the conformance suite runs no program");
  const assetCtx = (): PresetContext => ({
    profile: sampleProfile(),
    context: { spec: { assetId: "conformance-1", kind: "still" }, output: {}, provenance: {} },
    manifestRel: "assets/manifests/conformance-1.json",
    run: noTools,
    ...(sample?.context as Partial<PresetContext> | undefined),
  });
  const familyPng = samplePng();
  const familiesCtx = (): FamiliesContext => ({
    profile: sampleProfile(),
    assetId: "conformance-1",
    families: [
      {
        name: "idle",
        id: "conformance-1-idle",
        media: "assets/source/conformance-1-idle.png",
        sha256: createHash("sha256").update(familyPng).digest("hex"),
        content: familyPng,
      },
    ],
    run: noTools,
    ...(sample?.context as Partial<FamiliesContext> | undefined),
  });
  // The sample target is empty: `read` finds nothing there.
  const nothing = async (): Promise<undefined> => undefined;
  const write = (): Promise<PresetFile[]> =>
    preset.scope === "families"
      ? preset.write(familiesCtx(), options, nothing)
      : preset.write(assetCtx(), options, nothing);
  const check = (files: PresetFile[], read: (p: string) => Promise<Uint8Array | undefined>) =>
    preset.scope === "families"
      ? preset.check(familiesCtx(), options, files, read)
      : preset.check(assetCtx(), options, files, read);
  let files: PresetFile[];
  try {
    files = await write();
  } catch (error) {
    fail(`write threw: ${messageOf(error)}`);
    return;
  }
  if (!Array.isArray(files)) {
    fail("write did not return a list of files");
    return;
  }
  for (const file of files) {
    const path = file?.path;
    if (
      typeof path !== "string" ||
      path === "" ||
      isAbsolute(path) ||
      path.startsWith("/") ||
      path.split(/[\\/]/).includes("..")
    )
      fail(`write returned a path outside the target: ${JSON.stringify(path)}`);
    if (typeof file?.content !== "string" && !(file?.content instanceof Uint8Array))
      fail(`write returned ${JSON.stringify(path)} without string or byte content`);
  }
  ran("write");
  const written = new Map(
    files.map((f) => [
      f.path,
      typeof f.content === "string" ? new TextEncoder().encode(f.content) : f.content,
    ]),
  );
  try {
    const problems = await check(files, async (p) => written.get(p));
    if (!Array.isArray(problems) || problems.length > 0)
      fail(`check refused what write wrote: ${JSON.stringify(problems)}`);
    if (files.length > 0) {
      const missing = await check(files, nothing);
      if (!Array.isArray(missing) || missing.length === 0)
        fail("check passed with none of its files written, so it checks nothing");
    }
    ran("check reads back what write wrote");
  } catch (error) {
    fail(`check threw: ${messageOf(error)}`);
  }
  if (preset.warnings === undefined) return;
  // Warnings are advisory lines about the target: a list of strings, never a throw.
  const read = async (p: string) => written.get(p);
  try {
    const warnings =
      preset.scope === "families"
        ? await preset.warnings(familiesCtx(), options, read)
        : await preset.warnings(assetCtx(), options, read);
    if (!Array.isArray(warnings) || warnings.some((w) => typeof w !== "string"))
      fail(`warnings returned ${JSON.stringify(warnings)}, not a list of strings`);
    ran("warnings returns a list of strings");
  } catch (error) {
    fail(`warnings threw: ${messageOf(error)}`);
  }
}

function checkAdapter(
  adapter: ProviderAdapter,
  settings: ProviderSettings | undefined,
  fail: (why: string) => void,
  ran: (what: string) => void,
): void {
  if (!Array.isArray(adapter.capabilities)) fail("capabilities is not a list");
  if (!Array.isArray(adapter.fixedHosts)) fail("fixedHosts is not a list");
  else
    for (const host of adapter.fixedHosts) {
      let parsed: string | undefined;
      try {
        parsed = new URL(`https://${host}`).host;
      } catch {
        parsed = undefined;
      }
      if (typeof host !== "string" || parsed !== host.toLowerCase())
        fail(`fixedHosts holds ${JSON.stringify(host)}, which is not a bare host`);
    }
  if (typeof adapter.endpointFromSettings !== "boolean")
    fail("endpointFromSettings is not a boolean");
  if (typeof adapter.create !== "function") {
    fail("has no create function");
    return;
  }
  const entry: ProviderSettings = settings ?? {
    adapter: adapter.id,
    ...(adapter.endpointFromSettings && { baseURL: "http://127.0.0.1:9/" }),
  };
  try {
    createProvider(
      "conformance",
      { adapter: adapter.id, ...entry },
      { adapters: [adapter], env: {} },
    );
    ran("create with core's guarded fetch, billing declared");
  } catch (error) {
    fail(`create failed: ${messageOf(error)}`);
  }
}

/**
 * Runs the conformance suite on a pack's entry (its default export) and reports every failure.
 * Nothing is thrown for a failing pack; `assertConformance` throws.
 */
export async function runConformance(
  entry: ExtensionEntry,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const failures: string[] = [];
  const checked: string[] = [];
  const trapped: string[] = [];
  await withFetchTrapped(trapped, async () => {
    let ext: Extension;
    try {
      ext = checkExtension(await resolveEntry(entry, options.name, options.settings), "the pack");
    } catch (error) {
      failures.push(messageOf(error));
      return;
    }
    checked.push(`extension ${ext.name}: shape and ids`);
    const routes = routesFor(ext);
    for (const adapter of ext.adapters ?? [])
      checkAdapter(
        adapter,
        options.adapters?.[adapter.id],
        (why) => failures.push(`adapter ${adapter.id} ${why}`),
        (what) => checked.push(`adapter ${adapter.id}: ${what}`),
      );
    for (const kind of ext.kinds ?? [])
      await checkKind(
        kind,
        options.kinds?.[kind.kind],
        routes,
        // Judged as `stage` judges it: core's declarations and the kind's own, never another kind's.
        kindQaRegistry(kind, coreExtension.kinds ?? []).checks,
        (why) => failures.push(`kind ${kind.kind} ${why}`),
        (what) => checked.push(`kind ${kind.kind}: ${what}`),
      );
    for (const preset of ext.presets ?? [])
      await checkPreset(
        preset,
        options.presets?.[preset.name],
        (why) => failures.push(`preset ${preset.name} ${why}`),
        (what) => checked.push(`preset ${preset.name}: ${what}`),
      );
  });
  for (const url of trapped)
    failures.push(`reached the global fetch (${url}); use the context's http`);
  return { passed: failures.length === 0, failures, checked };
}

/** Runs the suite and throws an `AssertionError` listing every failure. */
export async function assertConformance(
  entry: ExtensionEntry,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const report = await runConformance(entry, options);
  if (!report.passed)
    throw new AssertionError({
      message: `the pack fails the conformance suite:\n- ${report.failures.join("\n- ")}`,
      actual: report.failures,
      expected: [],
      operator: "conformance",
    });
  return report;
}
