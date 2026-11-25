import { ConfirmationError } from "./approvals.ts";
import { ReferenceViewCache } from "./model3d/views.ts";
import { ClipMapCache } from "./model3d/clip-map.ts";
import type { PromptPolicyRecord } from "./policy/text.ts";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import {
  DIGITAL_SOURCE_TYPES,
  embedDigitalSourceType,
  readDigitalSourceType,
  metadataStep,
} from "./metadata.ts";
import type { DigitalSourceType } from "./metadata.ts";
import { decodeImage } from "./image/raster.ts";
import { pixelHash } from "./transform/run.ts";
import { Budget, BudgetExceededError } from "./budget.ts";
import { SpendHoldError, ledgerFor } from "./spend.ts";
import type { SpendLedger } from "./spend.ts";
import { Caller, RefusingCaller } from "./calls.ts";
import { currentRunScope } from "./runs/journal.ts";
import { referenceLicenses } from "./bible.ts";
import { InputError, JobStoppedError } from "./errors.ts";
import { extensionOf, unavailableId } from "./extensions/errors.ts";
import { validateKindProfile, validateKindSpec } from "./kind-schemas.ts";
import { ProviderLimitError } from "./limits.ts";
import { licenseFields } from "./license.ts";
import { parseJsonFile } from "./json.ts";
import { checkLayout, checkWrites, safeFileName, safeSegment } from "./paths.ts";
import type { IdentityAgreement, IdentityRecordCheck } from "./identity.ts";
import { applyStability, kindQaRegistry, mergeFiltering } from "./qa/stability.ts";
import type { FilteringState, StabilityEntry } from "./qa/stability.ts";
import type { GenerationProvider } from "./gateway/provider.ts";
import { checkFrameLayout, withLayoutParameters } from "./frames.ts";
import { runKindChecks } from "./generators/generator.ts";
import { mediaCheckContext } from "./media.ts";
import type { Generator, PlannedCall } from "./generators/generator.ts";
import { loadBibleInputs, sha256, sniffMediaType } from "./request.ts";
import { writeContact } from "./contact.ts";
import type { Routes } from "./routes.ts";
import type { CandidateSummary } from "./library/summary.ts";
import type {
  AssetSpec,
  CallRecord,
  Provenance,
  Reason,
  StyleBible,
  TargetProfile,
} from "./types.ts";

export const DEFAULT_CANDIDATES = 4;
export const DEFAULT_CAP_USD = 5;

export interface StageOptions {
  spec: AssetSpec;
  specDir: string;
  bible: StyleBible;
  bibleDir: string;
  profile: TargetProfile;
  /** Directory the profile's relative paths resolve against (the profile file's directory). */
  profileDir?: string;
  routes: Routes;
  /** The provider set of the settings, or one provider that serves every route. */
  provider: GenerationProvider;
  /** One provider's settings id, recorded in each call's route; a set records each route's own. */
  providerName?: string;
  /** The cross-run spend ledger every paid call also reserves against (src/spend.ts). */
  ledger?: SpendLedger;
  /** The asset kinds of the registry (src/extensions/registry.ts): core's and the extensions'. */
  generators: Generator[];
  /**
   * Directory runs are staged under; each run gets `<runsDir>/<runId>/`. The stage command gives
   * the run id of its request digest, `r-<16 hex>` (src/runs/dir.ts).
   */
  runsDir: string;
  candidates?: number;
  capUsd?: number;
  runId?: string;
  now?: () => Date;
  /** Receives one line per candidate outcome and one when the run stops early. */
  log?: (message: string) => void;
  /** The plan step's prompt-policy record, kept in the run record and each candidate's provenance. */
  promptPolicy?: PromptPolicyRecord;
  /** The author's note of this round, appended to each candidate's generation prompt. */
  note?: string;
  /**
   * The measured stability entries model-backed checks filter by; src/qa/stability.json by default.
   * The kinds' own entries are added to them.
   */
  stability?: readonly StabilityEntry[];
  /** The settings' state directory; judged reference views are cached under it. */
  stateDir?: string;
}

/** What a stage run would call and cost, computed without spending anything. */
export interface StagePlan {
  kind: string;
  requested: number;
  capUsd: number;
  /** The calls one candidate makes. */
  perCandidate: PlannedCall[];
  /** The calls the request makes once (a 3D character's reference view calls). */
  perRequest: PlannedCall[];
  /** Calls across all candidates and the request's own. */
  calls: number;
  estimateUsd: number;
  /** Whether the estimate fits the cap; a forecast over the cap is reported, not thrown. */
  withinCap: boolean;
}

export function planStage(options: {
  spec: AssetSpec;
  profile: TargetProfile;
  routes: Routes;
  generators: Generator[];
  candidates?: number;
  capUsd?: number;
  /** The style bible; with it, the request's own calls are forecast too. */
  bible?: StyleBible;
}): StagePlan {
  const requested = options.candidates ?? DEFAULT_CANDIDATES;
  const capUsd = options.capUsd ?? DEFAULT_CAP_USD;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new InputError(`invalid candidate count: ${requested}`);
  }
  if (typeof capUsd !== "number" || !Number.isFinite(capUsd) || capUsd < 0) {
    throw new InputError(`invalid cost cap: ${capUsd}`);
  }
  if (typeof options.spec.kind !== "string") {
    throw new InputError(`the spec's "kind" must be a string naming an asset kind`);
  }
  const generator = options.generators.find((g) => g.kind === options.spec.kind);
  if (!generator) {
    // An `<ext>:<name>` kind comes from an extension the settings do not load.
    if (extensionOf(options.spec.kind) !== undefined)
      throw unavailableId(options.spec.kind, "asset kind");
    throw new InputError(`no generator handles asset kind "${options.spec.kind}"`);
  }
  // Before any paid call: the paths the hand-off will write for this spec can be written.
  checkLayout(options.profile, options.spec);
  validateKindSpec(generator, options.spec);
  validateKindProfile(generator, options.profile);
  const perCandidate = generator.planCandidate(options.spec, options.profile, options.routes);
  const perRequest =
    options.bible && generator.planRequest
      ? generator.planRequest(options.spec, options.profile, options.routes, options.bible)
      : [];
  // A kind's own operations (`<pack>:<op>`) must be declared; core's operations stay callable by
  // every kind, as they were before kinds declared operations.
  if (extensionOf(generator.kind) !== undefined) {
    const declared = Object.keys(generator.operations ?? {});
    for (const call of [...perCandidate, ...perRequest]) {
      if (extensionOf(call.operation) !== undefined && !declared.includes(call.operation))
        throw new InputError(
          `kind ${generator.kind} plans a call on operation "${call.operation}", which it does not declare in its operations (declared: ${declared.length > 0 ? declared.join(", ") : "none"})`,
        );
    }
  }
  const estimateUsd =
    perCandidate.reduce((sum, c) => sum + c.estimatedCostUsd, 0) * requested +
    perRequest.reduce((sum, c) => sum + c.estimatedCostUsd, 0);
  return {
    kind: generator.kind,
    requested,
    capUsd,
    perCandidate,
    perRequest,
    calls: perCandidate.length * requested + perRequest.length,
    estimateUsd,
    withinCap: estimateUsd <= capUsd + 1e-9,
  };
}

/** A candidate that passed QA, as staged for the author. */
export interface StagedCandidate {
  id: string;
  /** File name inside the run directory. */
  file: string;
  mediaType: string;
  extension: string;
  sha256: string;
  /** Why it passed: one reason per check. */
  reasons: Reason[];
  fields: Record<string, unknown>;
  provenance: Provenance;
  /** The model-written summary its QA call gave, and the operation and model that wrote it. */
  summary?: CandidateSummary;
  /** Files written for the person beside the candidate (turntable renders), relative to the run. */
  artifacts?: string[];
  /**
   * Artifacts whose name the generator returned could not be written as given (path rules,
   * design section 14): the file written and the name returned.
   */
  artifactNames?: Array<{ file: string; original: string }>;
  /** Files that go into the target beside the media (textures, groom maps), each a template field. */
  sidecars?: Array<{
    /** Path relative to the run directory. */
    file: string;
    /** File name written beside the media, no directory parts. */
    name: string;
    mediaType: string;
    sha256: string;
    /** Dotted path under `output` where `{ path, sha256 }` is exposed to the templates. */
    field: string;
    /** Merged into the `{ path, sha256 }` object. */
    extra?: Record<string, unknown>;
  }>;
}

export interface RunRecord {
  runId: string;
  /** The run directory this record is in (`<runs>/r-<16 hex>/` for a planned request). */
  runDir?: string;
  /** The prompt policy's check of the request's prompt text (planned runs). */
  promptPolicy?: PromptPolicyRecord;
  /** The person's confirmation of the request's spend (design section 7), when it needed one. */
  confirmation?: import("./types.ts").ConfirmationRecord;
  /**
   * Set by request_change: the asset id, the sha256 of the version the candidates were made on,
   * and the ids of the editing annotations they answer (design section 3.4).
   */
  changeRequest?: { asset: string; version: string; answers: string[] };
  createdAt: string;
  spec: AssetSpec;
  /** Absolute directory the spec's relative paths resolved against. */
  specDir: string;
  profile: TargetProfile;
  bibleVersion: string;
  capUsd: number;
  estimateUsd: number;
  spentUsd: number;
  requested: number;
  /** Only candidates that passed QA. Failing candidates are never staged or shown. */
  candidates: StagedCandidate[];
  /** How many candidates were filtered out by QA or failed to generate. */
  filtered: number;
  /** Messages of candidates that failed to generate (no media is kept for them). */
  errors: string[];
  /** Why each filtered candidate was filtered (planned runs); `candidate` is the 1-based number. */
  rejections?: Array<{
    candidate: number;
    reasons: Reason[];
    /** What the candidate cost (staged runs). */
    costUsd?: number;
    /** Files written for the person (turntable renders), relative to the run. */
    artifacts?: string[];
    /**
     * Artifacts whose name the generator returned could not be written as given (path rules,
     * design section 14): the file written and the name returned.
     */
    artifactNames?: Array<{ file: string; original: string }>;
  }>;
  /**
   * The identity lock check of a planned run: which lock version scored the candidates, the mode
   * and threshold, and how often the identity verdict agreed with the QA verdict (the shadow-mode
   * measurement). Absent when the character has no lock or scoring was off.
   */
  identity?: {
    subject: string;
    lockVersion: string;
    lockSha256: string;
    mode: "shadow" | "enforce";
    threshold: number;
    agreement: IdentityAgreement;
    /** How many candidates were scored; an unscored candidate is not counted here or in `agreement`. */
    scores: number;
    /** How many candidates' scoring calls failed, so they were kept unscored; absent when none. */
    unscored?: number;
    /** Enforce mode: the record's own check, run once before the first paid generation. */
    recordCheck?: IdentityRecordCheck;
  };
  /**
   * Whether each model-backed check filtered: `filtering` only where it is measured stable on the
   * run's model (src/qa/stability.json, or the kind's own entries); otherwise `advisory`, its
   * reasons marked `shadow`, with the cause. A check neither its kind nor core declares is `advisory`
   * with cause `undeclared`. Absent when no model-backed or undeclared check ran.
   */
  filtering?: FilteringState[];
  /** The numbered contact sheet in the run directory (`contact.png`), when a candidate has an image. */
  contactSheet?: string;
  /** Why candidate generation stopped early, when it did (for example the cost cap). */
  stopped?: string;
  picked?: { candidateId: string; at: string; target: string; files: string[] };
}

export const RUN_FILE = "run.json";

/**
 * Run-relative record paths for a candidate's artifacts in `dir`: the last segment of each name,
 * made safe and unique ignoring case (`a.png`, `A.png` -> `a.png`, `A-2.png`). `artifactNames`
 * lists each file written under a name other than the name's last `/` segment, which is what was
 * written before names were mapped; so `sub\file.png` is listed and `dir/file.png` is not.
 */
function artifactPaths(
  dir: string,
  named: ReadonlyArray<{ name: string }>,
): { artifacts: string[]; artifactNames: Array<{ file: string; original: string }> } {
  const used = new Set<string>();
  const artifacts: string[] = [];
  const artifactNames: Array<{ file: string; original: string }> = [];
  for (const { name } of named) {
    const given = name.split(/[\\/]/).pop() ?? "";
    const safe = safeFileName(given);
    let unique = safe;
    const dot = safe.lastIndexOf(".");
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const extension = dot > 0 ? safe.slice(dot) : "";
    for (let n = 2; used.has(unique.toLowerCase()); n++) unique = `${stem}-${n}${extension}`;
    used.add(unique.toLowerCase());
    const file = posix.join(dir, unique);
    artifacts.push(file);
    if (unique !== name.split("/").pop()) artifactNames.push({ file, original: name });
  }
  return { artifacts, artifactNames };
}

function provenanceOf(
  generator: Generator,
  calls: CallRecord[],
  prompt: string,
  parameters: Record<string, unknown>,
  bible: StyleBible,
  profile: TargetProfile,
  seed: number | undefined,
): Provenance {
  const unique = <T>(values: T[]) => [...new Set(values)];
  const licenses = referenceLicenses(bible.referenceLicense, bible.references ?? []);
  return {
    generator: generator.kind,
    route: unique(calls.map((c) => c.route)).join(" + "),
    models: unique(calls.map((c) => c.model)),
    prompt,
    parameters,
    ...(seed !== undefined && { seed }),
    requestIds: calls.map((c) => c.requestId),
    referenceHashes: unique(calls.flatMap((c) => c.referenceHashes)),
    bibleVersion: bible.version,
    ...(licenses.length > 0 && { referenceLicenses: licenses }),
    ...licenseFields(profile, calls),
    providerTerms: unique(
      calls.flatMap((c) => (c.providerTerms !== undefined ? [c.providerTerms] : [])),
    ),
    startedAt: calls[0]?.startedAt ?? "",
    finishedAt: calls[calls.length - 1]?.finishedAt ?? "",
    costUsd: calls.reduce((sum, c) => sum + c.costUsd, 0),
    calls,
  };
}

/**
 * Stages a run: reserves the whole run's estimate against the cap (refusing before any provider
 * call when it does not fit), generates candidates, keeps only the ones that pass QA, and writes
 * them with their reasons and provenance to the run directory for the author to pick from.
 */
export async function stage(options: StageOptions): Promise<{ run: RunRecord; runDir: string }> {
  const { spec, bible, profile, routes } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const plan = planStage(options);
  const { requested, capUsd, estimateUsd } = plan;
  const generator = options.generators.find((g) => g.kind === spec.kind) as Generator;
  // The QA checks and stability entries this kind's reasons are judged by: core's kinds' (ids
  // without an extension prefix) and the kind's own, never another pack's.
  const registry = kindQaRegistry(
    generator,
    options.generators.filter((g) => extensionOf(g.kind) === undefined),
    options.stability,
  );
  // Artifacts go in `c<n>-<kind as a slug>/`, so an extension kind's ":" never names a directory;
  // the name is checked here, before any paid call.
  const artifactDir = safeSegment(generator.kind);
  checkWrites([`c${requested}-${artifactDir}`]);

  const budget = new Budget(capUsd, ledgerFor(options.ledger, options.provider, profile));
  // The run-level check: refuse the whole run, before any call, if it would exceed the cap or
  // cross a spend ledger limit.
  budget.check(estimateUsd, `a run of ${requested} candidates`);

  const runId =
    options.runId ??
    `${now().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = resolve(options.runsDir, runId);
  await mkdir(runDir, { recursive: true });
  // The run's model-checked record (model and probability) over the plan step's blocklist record.
  const promptPolicy = currentRunScope()?.promptPolicy ?? options.promptPolicy;

  const run: RunRecord = {
    runId,
    runDir,
    ...(promptPolicy && { promptPolicy }),
    createdAt: now().toISOString(),
    spec,
    specDir: resolve(options.specDir),
    profile,
    bibleVersion: bible.version,
    capUsd,
    estimateUsd,
    spentUsd: 0,
    requested,
    candidates: [],
    filtered: 0,
    errors: [],
  };

  // Which view each reference shows is judged once for the run, whatever its candidate count.
  const referenceViews = new ReferenceViewCache(options.stateDir);
  // Which library clip a requested family is, likewise decided once per family for the run.
  const clipMaps = new ClipMapCache();
  for (let index = 0; index < requested; index++) {
    const call = new Caller({
      provider: options.provider,
      ...(options.providerName !== undefined && { providerName: options.providerName }),
      budget,
      routes,
      now,
      index,
    });
    const seed = Number.parseInt(
      sha256(new TextEncoder().encode(`${runId}:${index}`)).slice(0, 8),
      16,
    );
    try {
      let generated = await generator.generate({
        spec,
        specDir: options.specDir,
        bible,
        bibleDir: options.bibleDir,
        profile,
        call,
        index,
        seed,
        ...(options.note !== undefined && { note: options.note }),
        ...(options.profileDir !== undefined && { profileDir: options.profileDir }),
        referenceViews,
        clipMaps,
      });
      if (generator.checks !== undefined && generator.checks.length > 0) {
        const extra = await runKindChecks(
          generator.checks,
          {
            spec,
            profile,
            bible,
            output: generated.output,
            ...mediaCheckContext(generator.media, generated.output),
          },
          call,
          () => new RefusingCaller(`an exact check of ${generator.kind} makes no provider call`),
        );
        generated = {
          ...generated,
          qa: {
            passed: generated.qa.passed && extra.every((r) => r.shadow === true || r.passed),
            reasons: [...generated.qa.reasons, ...extra],
          },
        };
      }
      if (generator.frames === "strip") {
        // A strip kind's output carries core's frame layout; its provenance records the frames.
        const layout = checkFrameLayout(generator.kind, generated.output);
        generated = {
          ...generated,
          parameters: withLayoutParameters(generator.kind, generated.parameters, layout),
        };
      }
      const id = `c${index + 1}`;
      // Record paths use "/"; the candidate's writes are checked before the first one.
      const { artifacts, artifactNames } = artifactPaths(
        `${id}-${artifactDir}`,
        generated.artifacts ?? [],
      );
      checkWrites([`${id}.${generated.output.extension}`, ...artifacts]);
      for (const [i, artifact] of (generated.artifacts ?? []).entries()) {
        const name = artifacts[i] as string;
        await mkdir(join(runDir, posix.dirname(name)), { recursive: true });
        await writeFile(join(runDir, name), artifact.bytes);
      }
      // A model-backed check filters only where it is measured stable on the run's model, and a
      // check neither its kind nor core declares never filters.
      const qa = applyStability(generated.qa.reasons, routes, {
        checks: registry.checks,
        entries: registry.entries,
        undeclared: "advisory",
      });
      if (qa.filtering.length > 0)
        run.filtering = mergeFiltering(run.filtering ?? [], qa.filtering);
      // The generator's own verdict stands unless stability made one of its reasons advisory.
      const advised = qa.reasons.some((r, i) => r !== generated.qa.reasons[i] && !r.passed);
      const passed = advised
        ? qa.reasons.every((r) => r.shadow === true || r.passed)
        : generated.qa.passed;
      if (!passed) {
        run.filtered++;
        if (generated.artifacts) {
          // Recorded per candidate, with what it cost, so the filtered ones can be reviewed too.
          (run.rejections ??= []).push({
            candidate: index + 1,
            reasons: qa.reasons,
            costUsd: call.records.reduce((sum, r) => sum + r.costUsd, 0),
            artifacts,
            ...(artifactNames.length > 0 && { artifactNames }),
          });
        }
        log(`candidate ${index + 1}/${requested}: filtered by QA`);
        continue;
      }
      const file = `${id}.${generated.output.extension}`;
      let digitalSourceType: DigitalSourceType = DIGITAL_SOURCE_TYPES.generated;
      if (spec.keyPose && call.records.some((record) => record.operation === "edit")) {
        const source = new Uint8Array(await readFile(resolve(options.specDir, spec.keyPose)));
        const sourceType = readDigitalSourceType(source, sniffMediaType(source));
        if (sourceType !== DIGITAL_SOURCE_TYPES.generated)
          digitalSourceType = DIGITAL_SOURCE_TYPES.composite;
      }
      const bytes = embedDigitalSourceType(
        generated.output.bytes,
        generated.output.mediaType,
        digitalSourceType,
        { models: [...new Set(call.records.map((r) => r.model))] },
      );
      const provenance = provenanceOf(
        generator,
        call.records,
        generated.prompt,
        generated.parameters,
        bible,
        profile,
        call.records.some((r) => r.seed !== undefined) ? seed : undefined,
      );
      provenance.digitalSourceType = digitalSourceType;
      if (promptPolicy) provenance.promptPolicy = promptPolicy;
      const pixelHashes = ["image/png", "image/jpeg"].includes(generated.output.mediaType)
        ? [pixelHash(decodeImage(generated.output.bytes))]
        : [];
      provenance.steps = [metadataStep(digitalSourceType, pixelHashes)];
      await writeFile(join(runDir, file), bytes);
      run.candidates.push({
        id,
        file,
        mediaType: generated.output.mediaType,
        extension: generated.output.extension,
        sha256: sha256(bytes),
        reasons: qa.reasons,
        fields: generated.output.fields,
        provenance,
        ...(generated.summary !== undefined && {
          summary: { ...generated.summary, operation: "vision", model: routes["vision"].model },
        }),
        ...(artifacts.length > 0 && { artifacts }),
        ...(artifactNames.length > 0 && { artifactNames }),
      });
      log(`candidate ${index + 1}/${requested}: passed QA`);
    } catch (error) {
      run.filtered++;
      const message = error instanceof Error ? error.message : String(error);
      // Bad input, or a provider with no declared limit, fails every candidate the same way:
      // refuse the run rather than go on, but leave its record so the runs directory never holds
      // a run without one.
      // So does a stopped job or a spend hold: the journaled job waits to be collected, and a
      // held run may spend nothing new, so no other candidate is paid for.
      if (
        error instanceof ConfirmationError ||
        error instanceof InputError ||
        error instanceof ProviderLimitError ||
        error instanceof JobStoppedError ||
        error instanceof SpendHoldError
      ) {
        run.errors.push(`candidate ${index + 1}: ${message}`);
        run.stopped = /^(refused|stopped):/.test(message) ? message : `refused: ${message}`;
        run.spentUsd = budget.spentUsd;
        await writeRun(runDir, run);
        throw error;
      }
      if (error instanceof BudgetExceededError) {
        run.stopped = error.message;
        log(`stopped: ${message}`);
        break;
      }
      // A candidate that fails to generate is not shown; the run goes on with the next one.
      run.errors.push(`candidate ${index + 1}: ${message}`);
      log(`candidate ${index + 1}/${requested}: failed: ${message}`);
    } finally {
      run.spentUsd = budget.spentUsd;
    }
  }

  const references: Uint8Array[] = [];
  try {
    references.push(
      ...(await loadBibleInputs(spec, bible, options.bibleDir)).subject.map((r) => r.bytes),
    );
  } catch {
    // A spec with no bible references (a 3D character from its turnaround) has none to show.
  }
  const contact = await writeContact(runDir, spec, run.candidates, references, profile, {
    kinds: options.generators,
  });
  if (contact !== undefined) run.contactSheet = contact;
  await writeRun(runDir, run);
  return { run, runDir };
}

export async function writeRun(runDir: string, run: RunRecord): Promise<void> {
  await writeFile(join(runDir, RUN_FILE), `${JSON.stringify(run, null, 2)}\n`);
}

export async function readRun(runDir: string): Promise<RunRecord> {
  return (await parseJsonFile(join(runDir, RUN_FILE), "run")) as RunRecord;
}

export { readJson } from "./json.ts";
