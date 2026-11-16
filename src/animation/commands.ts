/**
 * The work behind `assetgrove animation-qa` and `assetgrove fix-frame`, kept apart from argument
 * parsing so tests and the MCP surface can call it directly.
 */
import {
  bindProvenance,
  callsSha256,
  checkProvenance,
  ProvenanceError,
} from "../provenance-binding.ts";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Budget } from "../budget.ts";
import { ledgerFor } from "../spend.ts";
import type { SpendLedger } from "../spend.ts";
import { Caller } from "../calls.ts";
import { InputError } from "../errors.ts";
import type { GenerationProvider } from "../gateway/provider.ts";
import type { PlannedCall } from "../generators/generator.ts";
import { decodeImage, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import {
  embedDigitalSourceType,
  readDigitalSourceType,
  readMarkedCallsSha256,
} from "../metadata.ts";
import type { DigitalSourceType } from "../metadata.ts";
import { requireInsideProject } from "../bible.ts";
import { loadReference, sniffMediaType } from "../request.ts";
import { MOTION_TEMPLATE_OPERATION } from "../routes.ts";
import type { Routes } from "../routes.ts";
import { readImport } from "../sheet/import.ts";
import { resolveStyle } from "../style.ts";
import type { ResolvedStyle } from "../style.ts";
import type { Point, Provenance, Size, TargetProfile } from "../types.ts";
import { DEFAULT_FIX_CAP_USD, fixBaseProvenance, fixFrame, planFix } from "./fix.ts";
import type { FrameFix } from "./fix.ts";
import { planFlicker } from "./flicker.ts";
import { planHoles } from "./holes.ts";
import { measureThreshold, splitStrip } from "./strip.ts";
import { registrationPin, templatesFor, thresholdsFor } from "./templates.ts";
import { planTemplateDecisions, TemplateChooser } from "./template-choice.ts";
import { defaultAnchor, familyMayLoop, profileFrame, qaStrip } from "./run.ts";
import type { StripQaResult } from "./run.ts";

/** One strip to check: where it is and how to read it. */
export interface StripTarget {
  family: string;
  path: string;
  frame: Size;
  anchor: Point;
  durationMs?: number;
  style: ResolvedStyle;
  profile: TargetProfile;
  subject: string;
  /** The subject's gait from its asset spec; the profile's `animation.gait` applies when unset. */
  gait?: string;
  /** The motion template its spec or grouping declares for the family (`none`: no template). */
  template?: string;
}

/** QA measures alpha only, so a palette rule needs no palette here. */
export function qaStyle(profile: TargetProfile): ResolvedStyle {
  const style = profile.style;
  return resolveStyle(style && { ...style, color: { rule: "full" } });
}

export function parseAnchor(text: string | undefined): Point | undefined {
  if (text === undefined) return undefined;
  const m = /^(\d+),(\d+)$/.exec(text.trim());
  if (!m) throw new InputError(`--anchor must be x,y in frame pixels, got "${text}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

async function readStrip(path: string): Promise<{ raster: Raster; origin?: DigitalSourceType }> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    throw new InputError(`cannot read the strip ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  let raster: Raster;
  try {
    raster = decodeImage(bytes);
  } catch (error) {
    throw new InputError(`cannot decode the strip ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const origin = readDigitalSourceType(bytes, sniffMediaType(bytes));
  return { raster, ...(origin !== undefined && { origin }) };
}

/** The strips of every family an import wrote (`preview/<family>.png` in the import directory). */
export async function importTargets(importDir: string): Promise<StripTarget[]> {
  let record;
  try {
    record = await readImport(importDir);
  } catch (error) {
    throw new InputError(`cannot read the import ${importDir}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const families = [...new Set((record.written ?? []).flatMap((w) => w.families))];
  if (families.length === 0) {
    throw new InputError(`import ${importDir} has written no family yet; run write-families first`);
  }
  // A template the grouping declared for a written family, else the spec's for its own family.
  const declared = new Map<string, string>();
  for (const [family, template] of Object.entries(record.templates ?? {}))
    declared.set(family, template);
  for (const w of record.written ?? [])
    for (const [family, template] of Object.entries(w.templates ?? {}))
      declared.set(family, template);
  return families.map((family) => ({
    family,
    ...(declared.has(family) && { template: declared.get(family) as string }),
    path: join(importDir, "preview", `${family}.png`),
    frame: record.frame,
    anchor: record.anchor,
    ...(record.durationMs !== undefined && { durationMs: record.durationMs }),
    style: record.style,
    profile: record.profile,
    subject: record.subject ?? record.assetId,
    ...(record.gait !== undefined && { gait: record.gait }),
  }));
}

/** One strip given on the command line. */
export function stripTarget(options: {
  path: string;
  family: string;
  profile: TargetProfile;
  subject?: string;
  anchor?: Point;
  gait?: string;
  template?: string;
}): StripTarget {
  const frame = profileFrame(options.profile);
  return {
    family: options.family,
    path: options.path,
    frame,
    anchor: options.anchor ?? defaultAnchor(frame),
    ...(options.profile.frames.durationMs !== undefined && {
      durationMs: options.profile.frames.durationMs,
    }),
    style: qaStyle(options.profile),
    profile: options.profile,
    subject: options.subject ?? options.family,
    ...(options.gait !== undefined && { gait: options.gait }),
    ...(options.template !== undefined && { template: options.template }),
  };
}

export interface QaPlan {
  calls: number;
  perFamily: Array<{
    family: string;
    calls: number;
    flickerCalls: number;
    holeCalls: number;
    /** 1 when this family's motion template is decided by a call (once per family and subject). */
    templateCalls: number;
  }>;
  model: string;
  /** The motion-template route's model. */
  templateModel: string;
  /** The holes route's model (one call per frame with a see-through area inside its outline). */
  holesModel: string;
  estimateUsd: number;
  capUsd: number;
  withinCap: boolean;
}

/**
 * The calls a QA run would make: one motion-template decision per family (and subject) with no
 * declared template and no template of its name, when `decide`; and with `vision`, identity
 * flicker per frame pair (the seam pair counted while the template is undecided), and holes per
 * frame with a see-through area inside its outline (found on pixels, so that count is exact).
 */
export async function planAnimationQa(
  targets: StripTarget[],
  routes: Routes,
  capUsd: number,
  vision: boolean,
  decide = vision,
): Promise<QaPlan> {
  const perFamily: QaPlan["perFamily"] = [];
  let estimateUsd = 0;
  const asked = new Set<string>();
  for (const t of targets) {
    const { raster } = await readStrip(t.path);
    const count = Math.floor(raster.width / t.frame.width);
    const key = JSON.stringify([t.family, t.subject]);
    const template =
      decide && !asked.has(key)
        ? planTemplateDecisions(
            [
              {
                family: t.family,
                subject: t.subject,
                ...(t.template !== undefined && { declared: t.template }),
              },
            ],
            templatesFor(t.profile),
            routes,
          )
        : [];
    if (template.length > 0) asked.add(key);
    const flicker = vision
      ? planFlicker(count, familyMayLoop(t.family, t.profile, t.template), routes)
      : { calls: 0, estimatedCostUsd: 0 };
    const holes = vision
      ? planHoles(
          splitStrip(raster, t.frame),
          { threshold: measureThreshold(t.style), minPx: thresholdsFor(t.profile).holeMinPx },
          routes,
        )
      : { calls: 0, estimatedCostUsd: 0 };
    perFamily.push({
      family: t.family,
      calls: flicker.calls + holes.calls + template.length,
      flickerCalls: flicker.calls,
      holeCalls: holes.calls,
      templateCalls: template.length,
    });
    estimateUsd +=
      flicker.estimatedCostUsd +
      holes.estimatedCostUsd +
      template.reduce((sum, c) => sum + c.estimatedCostUsd, 0);
  }
  return {
    calls: perFamily.reduce((s, f) => s + f.calls, 0),
    perFamily,
    model: routes.flicker.model,
    holesModel: routes.holes.model,
    templateModel: routes[MOTION_TEMPLATE_OPERATION]?.model ?? "",
    estimateUsd,
    capUsd,
    withinCap: estimateUsd <= capUsd + 1e-9,
  };
}

/**
 * Runs animation QA on each strip. With a provider, each family's motion template is decided when
 * nothing declares or names it, and (unless `vision` is false) identity flicker and holes are
 * checked; every call of every strip is checked against the cap before the first one is made.
 */
export async function runAnimationQa(options: {
  targets: StripTarget[];
  outDir: string;
  routes: Routes;
  capUsd: number;
  provider?: { provider: GenerationProvider; name: string };
  /** Run the identity-flicker and holes checks. Default: when a provider is given. */
  vision?: boolean;
  /** The cross-run spend ledger every paid call also reserves against (src/spend.ts). */
  ledger?: SpendLedger;
  now?: () => Date;
}): Promise<{ results: StripQaResult[]; spentUsd: number }> {
  const decide = options.provider !== undefined;
  const vision = decide && options.vision !== false;
  const plan = await planAnimationQa(
    options.targets,
    options.routes,
    options.capUsd,
    vision,
    decide,
  );
  const ledger = options.targets.reduce<SpendLedger | undefined>(
    (l, t) => l?.forProfile(t.profile),
    ledgerFor(options.ledger, options.provider?.provider),
  );
  const budget = new Budget(options.capUsd, ledger);
  // Refuse up front when the whole run would not fit, before any provider call.
  budget.check(plan.estimateUsd, "the motion-template, identity-flicker and holes calls");
  const call = options.provider
    ? new Caller({
        provider: options.provider.provider,
        providerName: options.provider.name,
        budget,
        routes: options.routes,
        ...(options.now !== undefined && { now: options.now }),
      })
    : undefined;
  // One chooser per profile: a family is decided once per run, whichever strip asks first.
  const choosers = new Map<TargetProfile, TemplateChooser>();
  const results: StripQaResult[] = [];
  for (const t of options.targets) {
    const { raster, origin } = await readStrip(t.path);
    let chooser = choosers.get(t.profile);
    if (!chooser) {
      chooser = new TemplateChooser(templatesFor(t.profile), call);
      choosers.set(t.profile, chooser);
    }
    const choice = await chooser.choose({
      family: t.family,
      subject: t.subject,
      ...(t.template !== undefined && { declared: t.template }),
    });
    results.push(
      await qaStrip({
        choice,
        strip: raster,
        family: t.family,
        profile: t.profile,
        style: t.style,
        frame: t.frame,
        anchor: t.anchor,
        ...(t.durationMs !== undefined && { durationMs: t.durationMs }),
        ...(t.gait !== undefined && { gait: t.gait }),
        outDir: options.outDir,
        ...(origin !== undefined && { digitalSourceType: origin }),
        ...(call &&
          vision && {
            vision: {
              call,
              routes: options.routes,
              subject: t.subject,
              ...(options.now !== undefined && { now: options.now }),
            },
          }),
      }),
    );
  }
  return { results, spentUsd: budget.spentUsd };
}

export { DEFAULT_FIX_CAP_USD };

/**
 * The fix's calls: one motion-template decision first when nothing declares or names the
 * family's template (the fix's registration pin and its QA follow the template), then the edit.
 */
export function planFrameFix(routes: Routes, capUsd: number, target?: StripTarget) {
  const perCall: PlannedCall[] = [
    ...(target
      ? planTemplateDecisions(
          [
            {
              family: target.family,
              subject: target.subject,
              ...(target.template !== undefined && { declared: target.template }),
            },
          ],
          templatesFor(target.profile),
          routes,
        )
      : []),
    ...planFix(routes),
  ];
  const estimateUsd = perCall.reduce((s, c) => s + c.estimatedCostUsd, 0);
  return {
    calls: perCall.length,
    perCall,
    estimateUsd,
    capUsd,
    withinCap: estimateUsd <= capUsd + 1e-9,
  };
}

export interface FixFrameRun {
  stripPath: string;
  provenancePath: string;
  fix: FrameFix;
  qa: StripQaResult;
  spentUsd: number;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Fixes one frame of a strip and writes the fixed strip, its provenance and its QA and previews
 * into the output directory. Never writes into a target and never sets a review value.
 */
export async function runFixFrame(options: {
  target: StripTarget;
  index: number;
  from: { neighbour: number } | { keyPose: string };
  note?: string;
  provenancePath?: string;
  bible?: { version: string; palette: string[] };
  outDir: string;
  routes: Routes;
  capUsd: number;
  provider: { provider: GenerationProvider; name: string };
  /** The cross-run spend ledger every paid call also reserves against (src/spend.ts). */
  ledger?: SpendLedger;
  now?: () => Date;
}): Promise<FixFrameRun> {
  const { target } = options;
  if (resolve(options.outDir, basename(target.path)) === resolve(target.path)) {
    throw new InputError(
      "--out must not be the strip's own directory; the fix never overwrites it",
    );
  }
  const style = resolveStyle(target.profile.style, options.bible?.palette);
  const { raster, origin } = await readStrip(target.path);
  const sidecar = options.provenancePath ?? `${target.path}.provenance.json`;
  let provenance: Provenance | undefined;
  if (options.provenancePath !== undefined || (await exists(sidecar))) {
    let value: unknown;
    let bytes: Buffer | undefined;
    try {
      bytes = await readFile(sidecar);
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new InputError(`cannot read the provenance ${sidecar}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    // Checked here, before any call: a record the fix cannot extend must cost nothing.
    provenance = fixBaseProvenance(value, {
      strip: raster,
      source: sidecar,
      license: target.profile.license,
      ...(options.bible !== undefined && { bibleVersion: options.bible.version }),
      at: (options.now ?? (() => new Date()))().toISOString(),
    });
    // A strip's own record must be the record of these bytes (a transform record is matched by
    // the strip's pixels above).
    if (provenance === value) {
      provenance = await checkProvenance({
        media: {
          path: target.path,
          bytes: new Uint8Array(await readFile(target.path)),
          mediaType: "image/png",
        },
        provenance: { path: sidecar, bytes: bytes!, value: provenance },
      });
    }
  }
  if (provenance === undefined) {
    // No record beside the strip: one whose mark records calls had a record, and a fix from no
    // record would write a new one without them (and without their grant).
    const bytes = new Uint8Array(await readFile(target.path));
    let marked: string | undefined;
    try {
      marked = readMarkedCallsSha256(bytes, "image/png");
    } catch {
      marked = undefined;
    }
    if (marked !== undefined && marked !== callsSha256({ calls: [] })) {
      throw new ProvenanceError(
        `refused: ${target.path} has no provenance at ${sidecar}, but its own mark records model ` +
          "calls (its calls sha256 is not that of no call). Give the strip with the provenance " +
          "file Assetgrove wrote beside it, with --provenance",
      );
    }
  }
  if (provenance && origin !== undefined && provenance.digitalSourceType === undefined) {
    provenance = { ...provenance, digitalSourceType: origin };
  }
  if ("keyPose" in options.from)
    requireInsideProject([options.from.keyPose], process.cwd(), "the key pose");
  const keyPose =
    "keyPose" in options.from
      ? await loadReference(options.from.keyPose, "approved key pose", process.cwd())
      : undefined;
  const budget = new Budget(
    options.capUsd,
    ledgerFor(options.ledger, options.provider.provider, target.profile),
  );
  const call = new Caller({
    provider: options.provider.provider,
    providerName: options.provider.name,
    budget,
    routes: options.routes,
    ...(options.now !== undefined && { now: options.now }),
  });
  const choice = await new TemplateChooser(templatesFor(target.profile), call).choose({
    family: target.family,
    subject: target.subject,
    ...(target.template !== undefined && { declared: target.template }),
  });
  const fixed = await fixFrame({
    strip: raster,
    frame: target.frame,
    anchor: target.anchor,
    family: target.family,
    pin: registrationPin(choice.template, target.profile, target.gait),
    groundTolerance: thresholdsFor(target.profile).groundTolerance,
    subject: target.subject,
    index: options.index,
    from: keyPose ? { keyPose } : (options.from as { neighbour: number }),
    style,
    call,
    ...(options.note !== undefined && { note: options.note }),
    ...(provenance !== undefined && { provenance }),
    stripPath: target.path,
    license: target.profile.license,
    ...(options.bible !== undefined && { bibleVersion: options.bible.version }),
    ...(options.now !== undefined && { now: options.now }),
  });
  await mkdir(options.outDir, { recursive: true });
  const name = basename(target.path);
  const stripPath = resolve(options.outDir, name);
  const origin2 = fixed.provenance.digitalSourceType;
  const png = encodePng(fixed.strip);
  const stripBytes =
    origin2 === undefined
      ? png
      : embedDigitalSourceType(png, "image/png", origin2, {
          models: fixed.provenance.models,
          callsSha256: callsSha256(fixed.provenance),
        });
  await writeFile(stripPath, stripBytes);
  const provenancePath = `${stripPath}.provenance.json`;
  // The record is bound to the strip it was written with (src/provenance-binding.ts).
  fixed.provenance = bindProvenance(fixed.provenance, stripBytes);
  await writeFile(provenancePath, `${JSON.stringify(fixed.provenance, null, 2)}\n`);
  const qa = await qaStrip({
    choice,
    strip: fixed.strip,
    family: target.family,
    profile: target.profile,
    style,
    frame: target.frame,
    anchor: target.anchor,
    ...(target.durationMs !== undefined && { durationMs: target.durationMs }),
    ...(target.gait !== undefined && { gait: target.gait }),
    outDir: options.outDir,
    ...(origin2 !== undefined && { digitalSourceType: origin2 }),
  });
  return { stripPath, provenancePath, fix: fixed.fix, qa, spentUsd: budget.spentUsd };
}
