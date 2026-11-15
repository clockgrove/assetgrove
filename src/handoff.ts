import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  combineDigitalSourceTypes,
  embedDigitalSourceType,
  readDigitalSourceType,
  metadataStep,
  requireDeclared,
} from "./metadata.ts";
import { decodeImage } from "./image/raster.ts";
import { pixelHash } from "./transform/run.ts";
import { InputError } from "./errors.ts";
import { commandIdentity, defaultGate, requireApproval, resolveProgram } from "./approvals.ts";
import type { ApprovalGate, CommandStep } from "./approvals.ts";
import { requireLicensable } from "./license.ts";
import { GLB_MEDIA_TYPE } from "./model3d/glb.ts";
import { shapeModelHandoff } from "./model3d/handoff.ts";
import { readRun, writeRun } from "./loop.ts";
import type { StagedCandidate } from "./loop.ts";
import { checkWrites, readRecordPath, relativeRecordPath } from "./paths.ts";
import { sha256 } from "./request.ts";
import { renderString, setPath } from "./template.ts";
import { HandoffCheckError, resolveHandoff } from "./handoff/presets/index.ts";
import type { PresetRegistry } from "./handoff/presets/index.ts";
import type { HandoffProblem, PresetFile } from "./handoff/presets/index.ts";
import type { AssetSpec, Provenance, TargetProfile } from "./types.ts";

const run = promisify(execFile);

export interface PickOptions {
  runDir: string;
  candidateId: string;
  /** The target repository (or directory) the pick is written into. */
  targetDir: string;
  now?: () => Date;
  /** How the profile's validator is approved; the developer settings with no prompt when absent. */
  gate?: ApprovalGate;
  /** The presets the profile's `handoff` list chooses among; core's when absent. */
  registry?: PresetRegistry;
}

export interface PickResult {
  candidate: StagedCandidate;
  mediaPath: string;
  manifestPath: string;
  provenancePath?: string;
  /** Each hand-off preset that ran, with the files it wrote. */
  handoff?: PresetResult[];
  validator?: ValidatorResult;
}

/** One hand-off preset that ran: its name and the files it wrote, relative to the target. */
export interface PresetResult {
  preset: string;
  files: string[];
}

/** What the target's validator said, and the approved command step that ran it. */
export interface ValidatorResult {
  accepted: boolean;
  command: string[];
  output: string;
  /** The command's hash and approval method (design section 8). */
  approval: CommandStep;
}

function inside(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new InputError(`profile layout path "${path}" leaves the target directory`);
  }
  return full;
}

/** Whether the manifest template embeds the whole provenance record as `"{{provenance}}"`. */
function embedsProvenance(template: unknown): boolean {
  if (typeof template === "string") return /^\{\{\s*provenance\s*\}\}$/.test(template);
  if (Array.isArray(template)) return template.some(embedsProvenance);
  if (template !== null && typeof template === "object") {
    return Object.values(template).some(embedsProvenance);
  }
  return false;
}

/** What a hand-off writes: one media file with its fields and provenance. */
export interface TargetWrite {
  profile: TargetProfile;
  spec: AssetSpec;
  bibleVersion: string;
  output: {
    bytes: Uint8Array;
    mediaType: string;
    extension: string;
    fields: Record<string, unknown>;
    /** Files written beside the media; each is exposed to the templates as `output.<field>`. */
    sidecars?: Array<{
      name: string;
      bytes: Uint8Array;
      mediaType: string;
      field: string;
      extra?: Record<string, unknown>;
    }>;
  };
  provenance: Provenance;
  /** Values the templates read as `{{run.*}}`. */
  run: Record<string, unknown>;
  targetDir: string;
  /** How the profile's validator is approved; the developer settings with no prompt when absent. */
  gate?: ApprovalGate;
  /** The presets the profile's `handoff` list chooses among; core's when absent. */
  registry?: PresetRegistry;
}

export interface TargetWriteResult {
  mediaPath: string;
  manifestPath: string;
  provenancePath?: string;
  /** Every written file, relative to the target directory. */
  files: string[];
  /** Each hand-off preset of the profile's `handoff` list, in order, with the files it wrote. */
  handoff: PresetResult[];
  validator?: ValidatorResult;
}

/**
 * Writes one output into the target through the profile's hand-off presets (design section 14;
 * src/handoff/presets): first every preset's options are validated (exit 2), then the media,
 * sidecars and provenance are written with each preset's files (the `manifest` preset renders the
 * profile's template with the review field set to the profile's pending value), then each preset
 * checks what it wrote. A failed check throws a HandoffCheckError (exit 6 `handoff_check_failed`)
 * and the validator does not run. Then runs the target's validator, when the profile declares one;
 * the validator must be approved (src/approvals.ts) before anything is written, and the provenance
 * records its hash and approval method. Assetgrove never writes any review value other than
 * pending. Refuses with a LicenseError, before writing, an
 * output whose provider grant the target cannot declare (src/license.ts); `{{profile.license}}`
 * renders the licence the output is declared under.
 */
export async function writeToTarget(write: TargetWrite): Promise<TargetWriteResult> {
  const { profile, spec } = write;
  // First: the profile's hand-off presets and their options.
  const presets = resolveHandoff(profile, write.registry);
  // Before anything is written: the output must be declarable under a licence the target takes.
  const licensed = requireLicensable(profile, write.provenance);
  if (write.provenance.digitalSourceType === "undeclared") requireDeclared("undeclared");
  const known = [
    write.provenance.digitalSourceType,
    readDigitalSourceType(write.output.bytes, write.output.mediaType),
  ].filter((value) => value !== undefined);
  const digitalSourceType = known.length ? combineDigitalSourceTypes(known) : "undeclared";
  requireDeclared(digitalSourceType);
  const output = {
    ...write.output,
    bytes: embedDigitalSourceType(write.output.bytes, write.output.mediaType, digitalSourceType),
  };
  const provenance = { ...licensed, digitalSourceType };
  const last = provenance.steps?.at(-1);
  if (
    last?.op !== "embed-digital-source-type" ||
    last.params["digitalSourceType"] !== digitalSourceType
  ) {
    const hashes = ["image/png", "image/jpeg"].includes(output.mediaType)
      ? [pixelHash(decodeImage(output.bytes))]
      : [];
    provenance.steps = [...(provenance.steps ?? []), metadataStep(digitalSourceType, hashes)];
  }
  const targetDir = resolve(write.targetDir);
  // Before anything is written: the validator a profile names runs only with an approval.
  let validatorStep: CommandStep | undefined;
  if (profile.validator) {
    const template = profile.validator.command;
    if (!template[0]) throw new InputError("the profile's validator command is empty");
    resolveProgram(template[0], targetDir);
    const identity = commandIdentity("validator", template, targetDir);
    validatorStep = await requireApproval(identity, write.gate ?? defaultGate());
    provenance.commands = [...(provenance.commands ?? []), validatorStep];
  }
  const context: Record<string, unknown> = {
    spec: { ...spec.fields, ...spec },
    profile: {
      ...profile.values,
      name: profile.name,
      // The licence this output is declared under, so a template never relabels it.
      license: provenance.license,
      ...(profile.style !== undefined && { style: profile.style }),
    },
    bible: { version: write.bibleVersion },
    output: {
      ...output.fields,
      mediaType: output.mediaType,
      extension: output.extension,
      sha256: sha256(output.bytes),
    },
    provenance,
    run: write.run,
  };
  const mediaRel = renderString(profile.layout.media, context);
  const manifestRel = renderString(profile.layout.manifest, context);
  const provenanceRel =
    profile.layout.provenance !== undefined
      ? renderString(profile.layout.provenance, context)
      : embedsProvenance(profile.manifest)
        ? undefined
        : `${mediaRel}.provenance.json`;
  (context["output"] as Record<string, unknown>)["path"] = mediaRel;
  const sidecarRels = (write.output.sidecars ?? []).map((sidecar) => {
    if (sidecar.name === "" || /[\\/]/.test(sidecar.name) || sidecar.name.includes("..")) {
      throw new InputError(`sidecar name "${sidecar.name}" must be a bare file name`);
    }
    const rel = posix.join(posix.dirname(mediaRel.replaceAll("\\", "/")), sidecar.name);
    setPath(context["output"] as Record<string, unknown>, sidecar.field, {
      ...sidecar.extra,
      path: rel,
      sha256: sha256(sidecar.bytes),
    });
    return rel;
  });
  if (provenanceRel !== undefined) context["provenancePath"] = provenanceRel;

  const presetContext = { profile, context, manifestRel };
  const presetFiles: PresetFile[][] = presets.map(({ preset, options }) =>
    preset.write(presetContext, options),
  );

  // Before anything is written: no two writes differ only by case, and no segment holds ":".
  checkWrites([
    mediaRel,
    ...presetFiles.flat().map((file) => file.path),
    ...sidecarRels,
    ...(provenanceRel === undefined ? [] : [provenanceRel]),
  ]);
  const mediaPath = inside(targetDir, mediaRel);
  const manifestPath = inside(targetDir, manifestRel);
  const provenancePath = provenanceRel === undefined ? undefined : inside(targetDir, provenanceRel);
  const writes: Array<[string, Uint8Array | string]> = [
    [mediaPath, output.bytes],
    ...presetFiles
      .flat()
      .map((file): [string, Uint8Array | string] => [inside(targetDir, file.path), file.content]),
  ];
  (write.output.sidecars ?? []).forEach((sidecar, i) => {
    writes.push([inside(targetDir, sidecarRels[i] as string), sidecar.bytes]);
  });
  if (provenancePath) {
    writes.push([provenancePath, `${JSON.stringify(provenance, null, 2)}\n`]);
  }
  for (const [path, content] of writes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  const result: TargetWriteResult = {
    mediaPath,
    manifestPath,
    ...(provenancePath !== undefined && { provenancePath }),
    files: writes.map(([path]) => relativeRecordPath(targetDir, path)),
    handoff: presets.map(({ preset }, i) => ({
      preset: preset.name,
      files: (presetFiles[i] ?? []).map((file) =>
        relativeRecordPath(targetDir, inside(targetDir, file.path)),
      ),
    })),
  };

  // Each preset checks what it wrote; a failed check stops the hand-off before the validator.
  const read = (rel: string) =>
    readFile(inside(targetDir, rel)).then(
      (bytes) => new Uint8Array(bytes),
      () => undefined,
    );
  const problems: HandoffProblem[] = [];
  for (const [i, { preset, options }] of presets.entries()) {
    const found = await preset.check(presetContext, options, presetFiles[i] ?? [], read);
    problems.push(...found.map((problem) => ({ preset: preset.name, problem })));
  }
  if (problems.length > 0) throw new HandoffCheckError(problems);
  if (profile.validator && validatorStep) {
    const vars = { manifest: manifestRel, media: mediaRel };
    const command = profile.validator.command.map((part) => renderString(part, vars));
    const [file, ...args] = command;
    if (!file) throw new InputError("the profile's validator command is empty");
    const program = resolveProgram(file, targetDir);
    const approval = validatorStep;
    try {
      const { stdout, stderr } = await run(program, args, { cwd: targetDir });
      result.validator = { accepted: true, command, output: `${stdout}${stderr}`.trim(), approval };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message: string };
      const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message;
      result.validator = { accepted: false, command, output: out, approval };
    }
  }
  return result;
}

/**
 * Writes the author's pick into the target (see `writeToTarget`) and records the pick in the run.
 */
export async function pick(options: PickOptions): Promise<PickResult> {
  const record = await readRun(options.runDir);
  const candidate = record.candidates.find((c) => c.id === options.candidateId);
  if (!candidate) {
    const ids = record.candidates.map((c) => c.id).join(", ") || "none";
    throw new InputError(
      `"${options.candidateId}" is not a QA-passing candidate of run ${record.runId} (passing: ${ids})`,
    );
  }
  const bytes = new Uint8Array(
    await readFile(join(options.runDir, readRecordPath(candidate.file, "staged file"))),
  );
  if (sha256(bytes) !== candidate.sha256) {
    throw new InputError(`staged file ${candidate.file} changed since it was staged`);
  }
  const sidecars = [];
  for (const staged of candidate.sidecars ?? []) {
    const sidecarBytes = new Uint8Array(
      await readFile(join(options.runDir, readRecordPath(staged.file, "staged file"))),
    );
    if (sha256(sidecarBytes) !== staged.sha256) {
      throw new InputError(`staged file ${staged.file} changed since it was staged`);
    }
    sidecars.push({
      name: staged.name,
      bytes: sidecarBytes,
      mediaType: staged.mediaType,
      field: staged.field,
      ...(staged.extra !== undefined && { extra: staged.extra }),
    });
  }
  // A 3D output takes the shape its target declares: clip fields, side images (assetgrove#137).
  const shaped =
    candidate.mediaType === GLB_MEDIA_TYPE && record.profile.model3d !== undefined
      ? shapeModelHandoff(record.profile, { bytes, fields: candidate.fields, sidecars })
      : { bytes, fields: candidate.fields, sidecars };
  const now = options.now ?? (() => new Date());
  const targetDir = resolve(options.targetDir);
  const written = await writeToTarget({
    profile: record.profile,
    spec: record.spec,
    bibleVersion: record.bibleVersion,
    output: {
      bytes: shaped.bytes,
      mediaType: candidate.mediaType,
      extension: candidate.extension,
      fields: shaped.fields,
      ...(shaped.sidecars.length > 0 && { sidecars: shaped.sidecars }),
    },
    provenance: candidate.provenance,
    run: { runId: record.runId, candidateId: candidate.id, pickedAt: now().toISOString() },
    targetDir,
    ...(options.gate && { gate: options.gate }),
    ...(options.registry && { registry: options.registry }),
  });
  const { files, ...rest } = written;
  record.picked = {
    candidateId: candidate.id,
    at: now().toISOString(),
    target: targetDir,
    files,
  };
  await writeRun(options.runDir, record);
  return { candidate, ...rest };
}
