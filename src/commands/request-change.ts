/**
 * `request_change` (design section 3.4): marked regions on a picked asset's current version become
 * a run of candidates. Each region is `<box|mask=PATH> [frame N|view N] [ref PATH]... : <note>`.
 * The job is a masked edit where the `edit` route's adapter declares `mask`, otherwise an edit of
 * the whole image with the notes; a frame region takes fix-frame's path, a view region on a 3D
 * asset another round of the 3D kind with the note. The request asks for spend once, with each
 * region and note in the form, and runs through the executor and journal. Each region becomes an
 * `editing` annotation on the version (which turns `changes-requested`), its mask and references
 * copied into `<assetId>.review/<sha256>.<ext>`. Every candidate appears on `compare.png`, with its
 * `outsideChange`. Picking one appends the version with `answers` naming the requests.
 */
import { bindProvenance } from "../provenance-binding.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { choiceLoops, defaultAnchor, profileFrame } from "../animation/run.ts";
import { qaStyle } from "../animation/commands.ts";
import { fixFrame } from "../animation/fix.ts";
import { splitStrip } from "../animation/strip.ts";
import { Budget, BudgetExceededError, runCap } from "../budget.ts";
import { Caller } from "../calls.ts";
import {
  compareRasters,
  comparisonFields,
  regionMask,
  turntableViews,
  writeCompareSheet,
} from "../compare.ts";
import type { Comparison, CompareRow } from "../compare.ts";
import { writeContactRows } from "../contact.ts";
import { paletteReads } from "../call-parameters.ts";
import { InputError, ProviderError } from "../errors.ts";
import { CORE_REGISTRY } from "../extensions/registry.ts";
import { decodeImage, encodePng } from "../image/raster.ts";
import type { Raster } from "../image/raster.ts";
import { loadStyleBible } from "../inputs.ts";
import { imageSize } from "../model3d/scene.ts";
import { loadAsset, locateAsset, withLibraryLock, writeAsset } from "../library/actions.ts";
import type { LoadedAsset } from "../library/actions.ts";
import { sha256Hex } from "../library/canonical.ts";
import { parseLfsPointer } from "../library/lfs.ts";
import { appendAnnotation, nextStamp, versionStatus } from "../library/review.ts";
import type { Annotation, AnnotationInput, Version, VersionStatus } from "../library/review.ts";
import { AssetIdError, writeAtomic } from "../library/write.ts";
import { planStage, readRun, stage, writeRun } from "../loop.ts";
import type { RunRecord, StagedCandidate } from "../loop.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType } from "../metadata.ts";
import type { DigitalSourceType } from "../metadata.ts";
import { providerSet, spendLedger } from "../providers/index.ts";
import { parseRegions } from "../regions.ts";
import type { Region } from "../regions.ts";
import { sha256, sniffMediaType } from "../request.ts";
import {
  DEFAULT_RUNS,
  DRY_RUN_PROPERTY,
  ROUND_PROPERTY,
  RUNS_PROPERTY,
  buildWorkPlan,
  jobOf,
  jobsOf,
  mergeJobs,
  paidBy,
  styleBibleReads,
} from "../runs/plan.ts";
import type { PlanJob } from "../runs/plan.ts";
import { ledgerFor } from "../spend.ts";
import { registrationPin, templatesFor, thresholdsFor } from "../animation/templates.ts";
import { planTemplateDecisions, TemplateChooser } from "../animation/template-choice.ts";
import type { LoadedReference, Provenance } from "../types.ts";
import { dryRunOutcome, formatWork, refusal } from "./result.ts";
import { defineCommand } from "./types.ts";
import type { RunContext } from "./types.ts";

export const DEFAULT_CHANGE_CANDIDATES = 2;

const MEDIA_FRAGMENTS = "http://www.w3.org/TR/media-frags/";
const SAFE_SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

interface RequestChangeArgs {
  address: string;
  region: string[];
  keepRest?: boolean;
  candidates?: number;
  bible?: string;
  cap?: number;
  runs?: string;
  workItem?: string;
  providerScript?: string;
  dryRun?: boolean;
  round?: number;
}

/** Which job the regions ask for (assumption 1 of the plan). */
type Job = "masked-edit" | "edit" | "fix-frame" | "3d-round";

/** The file extension a media type names: its subtype, so no format list lives here. */
function extensionOf(mediaType: string): string {
  const subtype = (mediaType.split("/")[1] ?? "").split(/[+;]/)[0] ?? "";
  const clean = subtype.toLowerCase().replace(/[^a-z0-9]/g, "");
  return clean === "jpeg" ? "jpg" : clean || "bin";
}

function seedOf(text: string): number {
  return Number.parseInt(createHash("sha256").update(text).digest("hex").slice(0, 8), 16);
}

/** The run that made the asset: the newest version's run under the runs directory. */
async function sourceRun(asset: LoadedAsset, runsDir: string): Promise<RunRecord> {
  const made = [...asset.record.versions]
    .reverse()
    .find((v) => v.run !== undefined && v.run !== "");
  if (made === undefined)
    throw new InputError(
      `${asset.reviewPath} names no run that made ${asset.assetId}; request_change edits from that run's spec and profile`,
    );
  const id = made.run!;
  if (!SAFE_SEGMENT.test(id))
    throw new InputError(
      `${asset.reviewPath} names the run "${id}", which is not one path segment`,
    );
  try {
    return await readRun(join(runsDir, id));
  } catch {
    throw new InputError(
      `the run ${id} that made ${asset.assetId} is not in ${runsDir}; give the runs directory that holds it with --runs`,
    );
  }
}

/** The job the regions ask for, refusing a mix (exit 2). */
function jobKind(regions: readonly Region[], is3d: boolean): "still" | "frame" | "3d" {
  if (regions.length === 0) throw new InputError("request_change needs at least one --region");
  if (is3d) {
    if (regions.some((r) => r.view === undefined))
      throw new InputError(
        "a region on a 3D asset names its view (view N): the change is another round of the 3D kind",
      );
    return "3d";
  }
  if (regions.some((r) => r.view !== undefined))
    throw new InputError("view N names a view of a 3D asset; this asset is an image");
  const framed = regions.filter((r) => r.frame !== undefined).length;
  if (framed > 0 && framed < regions.length)
    throw new InputError(
      "give every region a frame N, or none: frame regions take fix-frame's path, the others edit the whole image",
    );
  return framed > 0 ? "frame" : "still";
}

/** The plan step: the asset, its version, the regions, the job and the WorkPlan; no call made. */
/**
 * Checks each frame region's `frame N` against the strip before any confirmation, as fix-frame
 * would after it: the strip must be a row of the profile's frames, with N among them and a
 * neighbour frame to copy from.
 */
function checkFrames(
  frames: ReadonlySet<number>,
  size: { width: number; height: number } | undefined,
  frame: { width: number; height: number },
): void {
  if (
    size === undefined ||
    frame.width < 1 ||
    size.height !== frame.height ||
    size.width % frame.width !== 0
  )
    throw new InputError(
      `a frame region needs a strip of ${frame.width}x${frame.height} frames${size ? `, not a ${size.width}x${size.height} image` : ""}`,
    );
  const count = size.width / frame.width;
  if (count < 2)
    throw new InputError("a frame region needs a strip of at least two frames, one to copy from");
  for (const f of frames)
    if (!Number.isInteger(f) || f < 1 || f > count)
      throw new InputError(`frame ${f} is not in the strip, which has ${count} frames`);
}

async function prepare(args: RequestChangeArgs, ctx: RunContext) {
  const candidates = args.candidates ?? DEFAULT_CHANGE_CANDIDATES;
  if (!Number.isInteger(candidates) || candidates < 1)
    throw new InputError(`invalid candidate count: ${candidates}`);
  const location = locateAsset(args.address);
  const asset = await loadAsset(location);
  const version = asset.record.versions.at(-1)!;
  const regions = parseRegions(args.region ?? [], { base: process.cwd() });
  const is3d = extname(asset.mediaPath).toLowerCase() === ".glb";
  const kind = jobKind(regions, is3d);
  if (!existsSync(asset.mediaPath))
    throw new InputError(`the working media ${asset.mediaPath} is missing`);
  const bytes = new Uint8Array(await readFile(asset.mediaPath));
  if (parseLfsPointer(bytes) !== undefined)
    throw new InputError(`${asset.mediaPath} is a Git LFS pointer; fetch its bytes first`);
  if (sha256Hex(bytes) !== version.sha256)
    throw new InputError(
      `${asset.mediaPath} differs from version ${asset.record.versions.length} of ${asset.assetId} (sha256 ${version.sha256}): adopt the hand edit with \`library adopt\` before requesting a change`,
    );
  const runsDir = resolve(args.runs ?? DEFAULT_RUNS);
  const source = await sourceRun(asset, runsDir);
  const providers = await providerSet(args.providerScript, ctx);
  const routes = providers.routes;
  const capUsd = runCap(args.cap, ctx.settings);
  let job: Job;
  let jobs: PlanJob[];
  // Text a prompt carries besides the region notes: a frame fix names the family and the subject
  // (the asset id when the spec has no subject) in its template decision and fix prompt, and a 3D
  // round names the subject on its prompt's Subject: line, so the plan step checks them, free,
  // before the spend is confirmed.
  const promptText: string[] = [];
  let bible: Awaited<ReturnType<typeof loadStyleBible>> | undefined;
  let palettes: Record<string, string> = {};
  const registry = ctx.extensions ?? CORE_REGISTRY;
  const generators = [...registry.kinds];
  if (kind === "3d") {
    if (args.bible === undefined)
      throw new InputError(
        "a view region asks for another round of the 3D kind, which reads the style bible: give it with --bible",
      );
    bible = await loadStyleBible(args.bible);
    promptText.push(source.spec.subject ?? source.spec.assetId ?? asset.assetId);
    const plan = planStage({
      spec: source.spec,
      profile: source.profile,
      routes,
      generators,
      candidates,
      capUsd,
      bible: bible.value,
    });
    palettes = paletteReads([...plan.perCandidate, ...plan.perRequest]);
    // The request's own calls (the reference views it judges) are part of the confirmed spend.
    jobs = mergeJobs([
      ...jobsOf(plan.perCandidate, routes, candidates),
      ...jobsOf(plan.perRequest, routes),
    ]);
    job = "3d-round";
  } else {
    const route = routes["edit"];
    if (!route) throw new InputError('no model route for operation "edit"');
    const frames = new Set(regions.flatMap((r) => (r.frame !== undefined ? [r.frame] : [])));
    if (kind === "frame") {
      checkFrames(frames, imageSize(bytes), profileFrame(source.profile));
      const scaleRoute = routes["fix-scale"];
      if (!scaleRoute) throw new InputError('no model route for operation "fix-scale"');
      promptText.push(
        source.spec.animationFamily ?? "strip",
        source.spec.subject ?? source.spec.assetId ?? asset.assetId,
      );
      // The frame fix pins the point the family's template keeps still: one motion-template
      // decision first when the spec declares no template and none is named for the family.
      jobs = [
        ...jobsOf(
          planTemplateDecisions(
            [
              {
                family: source.spec.animationFamily ?? "strip",
                subject: source.spec.subject ?? source.spec.assetId ?? asset.assetId,
                ...(source.spec.template !== undefined && { declared: source.spec.template }),
              },
            ],
            templatesFor(source.profile),
            routes,
          ),
          routes,
        ),
        jobOf("edit", route, candidates * frames.size),
        jobOf("fix-scale", scaleRoute, candidates * frames.size),
      ];
      job = "fix-frame";
    } else {
      jobs = [jobOf("edit", route, candidates)];
      job = providers.declares(route, "mask") ? "masked-edit" : "edit";
    }
  }
  const reads: Record<string, string> = {};
  regions.forEach((r, i) => {
    if (r.shape.kind === "mask") reads[`region${i + 1}/mask`] = r.shape.path;
    r.refs.forEach((path, j) => (reads[`region${i + 1}/ref${j + 1}`] = path));
  });
  if (bible !== undefined) Object.assign(reads, styleBibleReads("bible", bible));
  Object.assign(reads, palettes);
  const work = await buildWorkPlan(requestChangeCommand, args, {
    promptAllow: ctx.settings.promptPolicy.allow,
    inputs: ["bible"],
    reads,
    hashes: { version: version.sha256 },
    promptText: [...regions.map((r) => r.note), ...promptText],
    jobs,
    capUsd,
    paid: paidBy(providers, jobs),
    providers,
    candidates,
  });
  return {
    candidates,
    asset,
    version,
    bytes,
    regions,
    job,
    source,
    providers,
    capUsd,
    bible,
    generators,
    work,
  };
}

/**
 * A media-fragment box selector for a box region, in percent of the image it was drawn on (design
 * section 3.1), so it fits a version of another size. A pixel box converts through `size`, the
 * frame's or the image's; only when no size is known (a 3D view) does it stay in pixels.
 */
function selectorOf(
  region: Region,
  size: { width: number; height: number } | undefined,
): Record<string, unknown> | undefined {
  if (region.shape.kind !== "box") return undefined;
  const { unit, x, y, width, height } = region.shape;
  const pct = (value: number, of: number) => Number(((value * 100) / of).toFixed(4));
  const value =
    unit === "percent"
      ? `xywh=percent:${x},${y},${width},${height}`
      : size !== undefined && size.width > 0 && size.height > 0
        ? `xywh=percent:${pct(x, size.width)},${pct(y, size.height)},${pct(width, size.width)},${pct(height, size.height)}`
        : `xywh=pixel:${x},${y},${width},${height}`;
  return { type: "FragmentSelector", conformsTo: MEDIA_FRAGMENTS, value };
}

/** Copies a mask or reference into `<assetId>.review/<sha256>.<ext>`; its path from the record. */
async function copyBeside(
  asset: LoadedAsset,
  path: string,
  written: string[],
): Promise<{ rel: string; bytes: Uint8Array; sha256: string }> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    throw new InputError(`cannot read ${path}`);
  }
  const hash = sha256Hex(bytes);
  const ext =
    extname(path)
      .slice(1)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") || extensionOf(sniffMediaType(bytes) ?? "");
  const rel = `${asset.assetId}.review/${hash}.${ext}`;
  const full = join(asset.dir, rel);
  if (!existsSync(full)) {
    await writeAtomic(full, bytes);
    written.push(full);
  }
  return { rel, bytes, sha256: hash };
}

/**
 * Records the regions as editing annotations on the version, under the library lock, copying each
 * mask and reference beside the record. A resumed run finds its own annotations by `ag:run`.
 */
async function recordRequests(
  args: RequestChangeArgs,
  ctx: RunContext,
  prepared: {
    asset: LoadedAsset;
    version: Version;
    regions: Region[];
    bytes: Uint8Array;
    source: RunRecord;
  },
  runId: string,
): Promise<{ annotations: Annotation[]; files: string[]; state: VersionStatus }> {
  const location = locateAsset(args.address);
  return withLibraryLock(location, ctx.settings.stateDir, async () => {
    const asset = await loadAsset(location);
    const current = asset.record.versions.at(-1)!;
    if (current.sha256 !== prepared.version.sha256)
      throw new AssetIdError(
        "version_changed",
        `asset "${asset.assetId}" is now at version ${asset.record.versions.length} (sha256 ${current.sha256}), not the version ${prepared.version.sha256} this request was planned on; request the change again`,
      );
    const own = asset.record.annotations.filter(
      (a) => a.motivation === "editing" && (a as Record<string, unknown>)["ag:run"] === runId,
    );
    if (own.length > 0)
      return { annotations: own, files: [], state: versionStatus(asset.record, current.sha256) };
    const files: string[] = [];
    const created = nextStamp(asset.record);
    let record = asset.record;
    const ids: string[] = [];
    for (const region of prepared.regions) {
      const mask =
        region.shape.kind === "mask"
          ? await copyBeside(asset, region.shape.path, files)
          : undefined;
      const refs = [];
      for (const path of region.refs) refs.push(await copyBeside(asset, path, files));
      const selector = selectorOf(
        region,
        region.frame !== undefined
          ? profileFrame(prepared.source.profile)
          : imageSize(prepared.bytes),
      );
      const input = {
        type: "Annotation",
        motivation: "editing",
        created,
        body: [
          { type: "TextualBody", purpose: "editing", value: region.note },
          ...refs.map((r) => ({ type: "SpecificResource", source: r.rel, purpose: "linking" })),
        ],
        target: {
          source: asset.resource,
          "ag:version": current.sha256,
          ...(region.frame !== undefined && { "ag:frame": region.frame }),
          ...(region.view !== undefined && { "ag:view": region.view }),
          ...(mask !== undefined && { "ag:mask": mask.rel }),
          ...(selector !== undefined && { selector }),
        },
        "ag:run": runId,
      } as AnnotationInput;
      const before = new Set(record.annotations.map((a) => a.id));
      record = appendAnnotation(record, input);
      const added = record.annotations.find((a) => !before.has(a.id));
      if (added !== undefined) ids.push(added.id);
    }
    const written = await writeAsset(asset, record);
    const annotations = record.annotations.filter((a) => ids.includes(a.id));
    return { annotations, files: [...files, ...written.files], state: written.state };
  });
}

/** Where a region lies, in words for the prompt. */
function whereOf(region: Region): string {
  if (region.shape.kind === "mask") return "in the area the mask marks";
  const { unit, x, y, width, height } = region.shape;
  const u = unit === "percent" ? "%" : " px";
  return `in the area from ${x}${u} to ${x + width}${u} across and ${y}${u} to ${y + height}${u} down`;
}

function editPrompt(regions: readonly Region[], masked: boolean, keepRest: boolean): string {
  let next = 2;
  const lines = ["Reference image 1 is the current version of the asset."];
  for (const [i, r] of regions.entries())
    for (let j = 0; j < r.refs.length; j++)
      lines.push(`Reference image ${next++} is a reference for change ${i + 1}.`);
  lines.push(
    masked
      ? "Edit only the masked area; keep everything outside it exactly as it is."
      : "Edit it as each change below asks, in its own area.",
    ...regions.map((r, i) => `Change ${i + 1}, ${whereOf(r)}: ${r.note}`),
  );
  if (keepRest && !masked) lines.push("Keep everything outside these areas exactly as it is.");
  lines.push("Keep the subject, identity, design, palette, style, framing and scale.", "No text.");
  return lines.join("\n");
}

async function loadRef(path: string, role: string): Promise<LoadedReference> {
  const bytes = new Uint8Array(await readFile(path));
  const mediaType = sniffMediaType(bytes);
  if (mediaType === undefined) throw new InputError(`${path} is not an image`);
  return { role, path, mediaType, bytes, sha256: sha256(bytes) };
}

/** One candidate made by the job, before it is staged. */
interface Made {
  bytes: Uint8Array;
  mediaType: string;
  provenance: Provenance;
  comparison?: Comparison;
  /** The candidate's image for the contact sheet. */
  image?: Raster;
}

export const requestChangeCommand = defineCommand<RequestChangeArgs>({
  name: "request-change",
  tool: "request_change",
  summary: "make candidates of a new version from regions marked on a picked asset",
  details: `Marks regions on the current version of a picked asset (its card, media or review record)
and makes --candidates (default ${DEFAULT_CHANGE_CANDIDATES}) candidates of a new version, within the
cost cap in USD. A region is "<x,y,w,h|mask=PATH> [frame N|view N] [ref PATH]... : <note>", a box in
pixels or, with % on each value, in percent; paths resolve inside the project root. The job: a
masked edit when the edit route's adapter declares the mask capability (a mask=PATH region sends
that file), otherwise an edit of the whole image with the notes (--keep-rest asks to keep the rest);
frame regions take fix-frame's path, one edit per frame plus one fix-scale decision per frame
when its candidate scales differ, both in the confirmed spend; view regions on a 3D asset run another
round of the 3D kind with the note (--bible names the style bible). The asset, the version's
sha256 and each region, note, mask and reference are in the request's digest; the notes pass the
prompt policy before the confirmation, and the spend form shows each region and note. Each region
becomes an editing annotation on the version (its state turns changes-requested), its mask and
references copied into <assetId>.review/<sha256>.<ext>. Writes c<n>.<ext> with provenance,
contact.png and compare.png to the run directory and reports each candidate's outsideChange (above
0.05 with the advisory reason changed_outside_region). The same request again resumes from the
run's journal or returns the finished run, paying for nothing twice. Pick a candidate with pick: the
version is appended with answers naming the requests. The run that made the asset is read from
--runs. --dry-run prints the planned calls and the forecast, and needs no key.`,
  input: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "the asset's card, media or review record",
        placeholder: "<asset>",
      },
      region: {
        type: "array",
        items: { type: "string" },
        description:
          "a region and its note: <x,y,w,h|mask=PATH> [frame N|view N] [ref PATH]... : <note>",
        placeholder: "<region>",
      },
      keepRest: {
        type: "boolean",
        description: "ask the whole-image edit to keep everything outside the regions",
      },
      candidates: {
        type: "integer",
        minimum: 1,
        description: "how many candidates to make",
        default: DEFAULT_CHANGE_CANDIDATES,
      },
      bible: {
        type: "string",
        description: "the style bible, for view regions on a 3D asset",
        placeholder: "<BIBLE.md>",
      },
      cap: {
        type: "number",
        description:
          "the run's cost cap in USD; at most, and by default, the settings' caps.runUsd",
        placeholder: "<usd>",
      },
      workItem: {
        type: "string",
        description: "the work item the spend ledger counts against",
        placeholder: "<label>",
      },
      providerScript: {
        type: "string",
        description: "answer every model call from this module instead of a provider",
        placeholder: "<module>",
      },
      runs: RUNS_PROPERTY,
      round: ROUND_PROPERTY,
      dryRun: DRY_RUN_PROPERTY,
    },
    required: ["address", "region"],
    additionalProperties: false,
  },
  positionals: [{ name: "address" }],
  effect: { readOnly: false, spends: "always", writes: "runs" },
  confirm: "spend",
  plan: async (args, ctx) => (await prepare(args, ctx)).work,
  async run(args, ctx) {
    const prepared = await prepare(args, ctx);
    const { candidates, asset, version, regions, job, source, providers, capUsd, work } = prepared;
    const ledger = spendLedger(ctx, args.workItem);
    if (args.dryRun)
      return dryRunOutcome(work, formatWork("request-change", work), ledger, { job });
    const dir = ctx.run?.dir ?? work.runDir;
    const runId = basename(dir);
    const recorded = await recordRequests(args, ctx, prepared, runId);
    const answers = recorded.annotations.map((a) => a.id);
    const budget = new Budget(capUsd, ledgerFor(ledger, providers, source.profile));
    const sourceCandidate = source.candidates.find((c) => c.id === (version.candidate ?? "")) as
      StagedCandidate | undefined;
    const errors: string[] = [];
    const staged: StagedCandidate[] = [];
    const rows: CompareRow[] = [];
    const shown: Array<{ number: number; images: Raster[] }> = [];
    const outside: Record<string, unknown>[] = [];
    let before: Raster | undefined;
    let run: RunRecord;

    if (job === "3d-round") {
      const bible = prepared.bible!;
      const note = regions.map((r) => `In view ${r.view}: ${r.note}`).join("\n");
      const staging = await stage({
        spec: source.spec,
        specDir: source.specDir,
        bible: bible.value,
        bibleDir: bible.dir,
        profile: source.profile,
        routes: providers.routes,
        provider: providers,
        generators: prepared.generators,
        runsDir: dirname(dir),
        runId,
        candidates,
        capUsd,
        ledger,
        note,
        log: ctx.log,
        stateDir: ctx.settings.stateDir,
        ...(work.promptPolicy && { promptPolicy: work.promptPolicy }),
      });
      run = staging.run;
      const renders = (c: StagedCandidate | undefined) =>
        (c?.artifacts ?? [])
          .filter((a) => a.endsWith(".png") && !basename(a).startsWith("clip-"))
          .sort();
      const n = regions[0]!.view!;
      const viewRegions = regions.filter((r) => r.view === n);
      // The version's view: its turntable render in the library, else the one its run staged.
      const sourceRender = renders(sourceCandidate)[n - 1];
      const beforeView =
        turntableViews(asset.mediaPath)[n - 1] ??
        (sourceRender !== undefined
          ? join(resolve(args.runs ?? DEFAULT_RUNS), source.runId, sourceRender)
          : undefined);
      for (const [i, c] of run.candidates.entries()) {
        const after = renders(c)[n - 1];
        if (beforeView === undefined || after === undefined) continue;
        const comparison = await compareRasters(
          decodeImage(new Uint8Array(await readFile(beforeView))),
          decodeImage(new Uint8Array(await readFile(join(dir, after)))),
          viewRegions,
        );
        rows.push({ number: i + 1, comparison });
        outside.push({ id: c.id, ...comparisonFields(comparison) });
      }
      errors.push(...run.errors);
    } else {
      before = decodeImage(prepared.bytes);
      const mediaType = sniffMediaType(prepared.bytes) ?? "image/png";
      const current: LoadedReference = {
        role: "the current version",
        path: asset.resource,
        mediaType,
        bytes: prepared.bytes,
        sha256: version.sha256,
      };
      const refs: LoadedReference[] = [];
      for (const [i, r] of regions.entries())
        for (const path of r.refs) refs.push(await loadRef(path, `reference for change ${i + 1}`));
      let mask: LoadedReference | undefined;
      if (job === "masked-edit") {
        const only = regions.length === 1 ? regions[0]!.shape : undefined;
        let maskBytes: Uint8Array | undefined;
        let maskPath = "regions";
        if (only?.kind === "mask") {
          const file = new Uint8Array(await readFile(only.path));
          const decoded = decodeImage(file);
          if (decoded.width === before.width && decoded.height === before.height) {
            maskBytes = file;
            maskPath = only.path;
          }
        }
        maskBytes ??= encodePng(await regionMask(regions, before.width, before.height));
        mask = {
          role: "mask",
          path: maskPath,
          mediaType: "image/png",
          bytes: maskBytes,
          sha256: sha256(maskBytes),
        };
      }
      const sourceType = (sourceCandidate?.provenance.digitalSourceType ??
        DIGITAL_SOURCE_TYPES.generated) as DigitalSourceType;
      const frames = [
        ...new Set(regions.flatMap((r) => (r.frame !== undefined ? [r.frame] : []))),
      ].sort((a, b) => a - b);
      let templates: TemplateChooser | undefined;
      for (let index = 0; index < candidates; index++) {
        const caller = new Caller({
          provider: providers,
          budget,
          routes: providers.routes,
          index,
          log: ctx.log,
        });
        try {
          let made: Made;
          if (job === "fix-frame") {
            const frame = profileFrame(source.profile);
            const anchor = defaultAnchor(frame);
            let strip = before;
            let provenance: Provenance | undefined = sourceCandidate?.provenance;
            const family = source.spec.animationFamily ?? "strip";
            // Decided once, on the first candidate's caller, and reused by every candidate.
            templates ??= new TemplateChooser(templatesFor(source.profile), caller);
            const choice = await templates.choose({
              family,
              subject: source.spec.subject ?? source.spec.assetId ?? asset.assetId,
              ...(source.spec.template !== undefined && { declared: source.spec.template }),
            });
            const pin = registrationPin(choice.template, source.profile, source.spec.gait);
            for (const f of frames) {
              const count = splitStrip(strip, frame).length;
              const fixed = await fixFrame({
                strip,
                frame,
                anchor,
                family,
                pin,
                loop: choiceLoops(choice),
                groundTolerance: thresholdsFor(source.profile).groundTolerance,
                subject: source.spec.subject ?? source.spec.assetId ?? asset.assetId,
                index: f,
                from: { neighbour: f > 1 ? f - 1 : Math.min(2, count) },
                style: qaStyle(source.profile),
                call: caller,
                // The decision chose the pin of every candidate's fix, so each candidate's
                // provenance records it once, with its first fixed frame.
                ...(choice.record !== undefined &&
                  f === frames[0] && { decisions: [choice.record] }),
                note: regions
                  .filter((r) => r.frame === f)
                  .map((r) => `${whereOf(r)} of the frame: ${r.note}`)
                  .join("\n"),
                ...(provenance !== undefined && { provenance }),
                stripPath: asset.resource,
                license: source.profile.license,
                bibleVersion: source.bibleVersion,
              });
              strip = fixed.strip;
              provenance = fixed.provenance;
            }
            let worst: Comparison | undefined;
            for (const f of frames) {
              const comparison = await compareRasters(
                splitStrip(before, frame)[f - 1]!,
                splitStrip(strip, frame)[f - 1]!,
                regions.filter((r) => r.frame === f),
              );
              if (worst === undefined || comparison.outsideChange > worst.outsideChange)
                worst = comparison;
            }
            made = {
              bytes: encodePng(strip),
              mediaType: "image/png",
              provenance: provenance!,
              ...(worst !== undefined && { comparison: worst }),
              image: strip,
            };
          } else {
            const prompt = editPrompt(regions, job === "masked-edit", args.keepRest === true);
            const seed = seedOf(`${runId}:${index}`);
            const image = await caller.image("edit", prompt, [current, ...refs], seed, {
              ...(mask !== undefined && { mask }),
            });
            const decoded = decodeImage(image.bytes);
            const calls = caller.records;
            const provenance: Provenance = {
              ...(sourceCandidate?.provenance ?? ({} as Provenance)),
              route: calls.map((c) => c.route).join(" + "),
              models: [...new Set(calls.map((c) => c.model))],
              prompt,
              parameters: {
                changeOf: { asset: asset.assetId, version: version.sha256, answers },
                ...(mask !== undefined && { mask: { path: mask.path, sha256: mask.sha256 } }),
              },
              seed,
              requestIds: calls.map((c) => c.requestId),
              referenceHashes: [current.sha256, ...refs.map((r) => r.sha256)],
              bibleVersion: source.bibleVersion,
              startedAt: calls[0]?.startedAt ?? "",
              finishedAt: calls[calls.length - 1]?.finishedAt ?? "",
              costUsd: calls.reduce((sum, c) => sum + c.costUsd, 0),
              calls,
              digitalSourceType: sourceType,
            };
            delete provenance.steps;
            made = {
              bytes: image.bytes,
              mediaType: image.mediaType,
              provenance,
              comparison: await compareRasters(before, decoded, regions),
              image: decoded,
            };
          }
          const id = `c${index + 1}`;
          const extension = extensionOf(made.mediaType);
          const file = `${id}.${extension}`;
          const bytes = embedDigitalSourceType(made.bytes, made.mediaType, sourceType);
          await writeFile(join(dir, file), bytes);
          await writeFile(
            join(dir, `${id}.provenance.json`),
            `${JSON.stringify(bindProvenance(made.provenance, bytes), null, 2)}\n`,
          );
          const numbers = made.comparison ? comparisonFields(made.comparison) : undefined;
          staged.push({
            id,
            file,
            mediaType: made.mediaType,
            extension,
            sha256: sha256(bytes),
            reasons: numbers?.reasons ?? [],
            fields: sourceCandidate?.fields ?? {},
            provenance: made.provenance,
          });
          if (made.comparison) {
            rows.push({ number: index + 1, comparison: made.comparison });
            outside.push({ id, ...numbers });
          }
          if (made.image) shown.push({ number: index + 1, images: [made.image] });
        } catch (error) {
          if (!(error instanceof ProviderError) && !(error instanceof BudgetExceededError))
            throw error;
          errors.push(
            `candidate ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (error instanceof BudgetExceededError || budget.spentUsd >= capUsd) break;
        }
      }
      const contact = await writeContactRows(dir, shown, [before]);
      run = {
        runId,
        runDir: dir,
        ...(work.promptPolicy && { promptPolicy: work.promptPolicy }),
        createdAt: new Date().toISOString(),
        spec: source.spec,
        specDir: source.specDir,
        profile: source.profile,
        bibleVersion: source.bibleVersion,
        capUsd,
        estimateUsd: work.forecastUsd,
        spentUsd: budget.spentUsd,
        requested: candidates,
        candidates: staged,
        filtered: errors.length,
        errors,
        ...(contact && { contactSheet: contact.file }),
      };
    }
    run.changeRequest = { asset: asset.assetId, version: version.sha256, answers };
    await writeRun(dir, run);
    const compareSheet = rows.length > 0 ? await writeCompareSheet(dir, rows) : undefined;
    const fields = {
      runDir: dir,
      asset: asset.assetId,
      version: version.sha256,
      state: recorded.state,
      job,
      requests: recorded.annotations.map((a) => ({
        id: a.id,
        ...(typeof a.target !== "string" &&
          a.target["ag:frame"] !== undefined && { frame: a.target["ag:frame"] }),
        ...(typeof a.target !== "string" &&
          a.target["ag:view"] !== undefined && { view: a.target["ag:view"] }),
      })),
      spentUsd: run.spentUsd,
      candidates: run.candidates.map((c) => ({
        id: c.id,
        file: c.file,
        sha256: c.sha256,
        ...outside.find((o) => o["id"] === c.id),
      })),
      errors,
      files: recorded.files,
      ...(run.contactSheet && { contactSheet: run.contactSheet }),
      ...(compareSheet && { compareSheet: "compare.png" }),
    };
    const human = [
      `${run.candidates.length} of ${candidates} candidate(s) for ${asset.assetId} (${job}), $${run.spentUsd.toFixed(4)} spent`,
      `requests ${answers.join(", ")} on version ${asset.record.versions.length} (${recorded.state})`,
      ...fields.candidates.map(
        (c) =>
          `  ${c.file}${"outsideChange" in c ? `  outsideChange ${String(c.outsideChange)}` : ""}`,
      ),
      ...errors,
      `pick one with: assetgrove pick --run ${dir} --candidate <id> --target <project>`,
    ].join("\n");
    if (run.candidates.length === 0)
      return refusal("provider_error", errors[0] ?? "no candidate was made", fields, human);
    return { exitCode: 0, fields, human };
  },
});
