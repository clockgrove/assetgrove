/**
 * Project-owned, pinned, deterministic renditions of an image or an audio master. No provider
 * calls or target activation. An audio recipe ending in `encode` makes an Ogg Vorbis rendition,
 * which carries the AI mark as Vorbis comments and a C2PA sidecar manifest (docs/PRD-audio.md).
 */
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { transformAudioFiles } from "../audio/run.ts";
import type { AudioTransformRecord } from "../audio/run.ts";
import {
  existingSigner,
  resolveSigner,
  sidecarCredentialed,
  sidecarHolds,
  sidecarName,
  takesSidecar,
} from "../credentials.ts";
import type { ContentSigner, SignerRecord } from "../credentials.ts";
import { InputError } from "../errors.ts";
import { canonicalJson, sha256Hex } from "../library/canonical.ts";
import {
  DIGITAL_SOURCE_TYPES,
  readDigitalSourceType,
  readMarkedModels,
  embedDigitalSourceType,
  parseDigitalSourceType,
  requireDeclared,
  sourceDeclaration,
} from "../metadata.ts";
import type { DigitalSourceType } from "../metadata.ts";
import { checkProvenance } from "../provenance-binding.ts";
import { sniffMediaType } from "../request.ts";
import type { Provenance } from "../types.ts";
import { assetgroveVersion } from "../library/write.ts";
import { checkWrites } from "../paths.ts";
import { loadSettings } from "../settings.ts";
import { operationSpec } from "./operations.ts";
import { readRecipe, transformFiles } from "./run.ts";
import { rasterEngine } from "./raster-engine.ts";
import type { RunOptions, TransformRecord } from "./run.ts";

export interface RenditionOptions extends Pick<RunOptions, "style" | "frame" | "engines"> {
  recipes: string;
  recipe: string;
  source: string;
  sourceSha256: string;
  sourceProvenance?: string;
  out: string;
  preview?: boolean;
  digitalSourceType?: DigitalSourceType;
  /** Output file stem (default `rendition`); names only, not part of the digest. */
  name?: string;
  /**
   * Signs the C2PA sidecar of an Ogg rendition; by default the developer settings'
   * `contentCredentials`, else the development certificate, as hand-off signs.
   */
  signer?: ContentSigner;
  /**
   * The sidecar already at the destination, by file name, for a preview whose caller writes
   * elsewhere (delivery): kept when it still holds for the same bytes. A real build reads its own
   * rendition directory.
   */
  existingSidecar?: (name: string) => Promise<Uint8Array | undefined>;
  /**
   * Sign a sidecar that does not hold even in a preview (default: only a real build signs).
   * Delivery plans in preview and writes the planned bytes itself, so its real delivery signs.
   * Without it a preview writes nothing, the development certificate included: it reports a
   * sidecar already there that still holds, else the sidecar's path alone.
   */
  sign?: boolean;
}

/** An Ogg rendition's C2PA sidecar manifest, as its output records it. */
export interface RenditionSidecar {
  /** The sidecar's file name, beside the rendition: its stem and `.c2pa`. */
  name: string;
  path: string;
  /** Absent in a preview that would sign a new sidecar: a signature is not byte-stable. */
  sha256?: string;
  /** Absent in a preview with no signer yet (the development certificate not made). */
  signer?: SignerRecord;
}

async function read(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    throw new InputError(`cannot read ${path}: ${(error as Error).message}`, { cause: error });
  }
}
function json(bytes: Uint8Array, path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("expected an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new InputError(`invalid JSON in ${path}: ${(error as Error).message}`, { cause: error });
  }
}

/** Resolves and encodes before any write, including in the CLI and MCP preview path. */
export async function buildRendition(options: RenditionOptions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(options.recipe)) {
    throw new InputError("recipe must be a safe file stem (letters, digits, _ or -)");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(options.sourceSha256)) {
    throw new InputError("sourceSha256 must be the full source SHA-256");
  }
  const expected = options.sourceSha256.toLowerCase();
  const source = resolve(options.source);
  const sourceBytes = await read(source);
  if (sha256Hex(sourceBytes) !== expected) throw new InputError("source SHA-256 mismatch");
  const recipePath = resolve(options.recipes, `${options.recipe}.json`);
  const recipeBytes = await read(recipePath);
  if (dirname(await realpath(recipePath)) !== (await realpath(resolve(options.recipes)))) {
    throw new InputError("recipe file must stay inside the project recipe directory");
  }
  // Only the deterministic raster adapter is available by default. Explicit injected adapters
  // must implement the same synchronous raster operations; async overrides are rejected too.
  const engines = options.engines ?? [rasterEngine];
  const recipe = readRecipe(json(recipeBytes, recipePath), recipePath, engines);
  const audio = sniffMediaType(sourceBytes) === "audio/wav";
  for (const step of recipe.steps) {
    const media = operationSpec(step.op)?.media;
    if (audio) {
      if (media !== "audio")
        throw new InputError(
          `the source is a WAV master, so its rendition takes only audio operations: ${step.op}`,
        );
      continue;
    }
    if (media === "audio")
      throw new InputError(`${step.op} is an audio operation; the source is not a WAV master`);
    const engine =
      step.engine === undefined
        ? engines.find((e) => e.operations[step.op] || e.asyncOperations?.[step.op])
        : engines.find((e) => e.name === step.engine);
    if (
      !rasterEngine.operations[step.op] ||
      !engine?.operations[step.op] ||
      engine.asyncOperations?.[step.op]
    ) {
      throw new InputError(
        `rendition requires a synchronous deterministic raster operation: ${step.op}`,
      );
    }
  }
  const sidecar = resolve(options.sourceProvenance ?? `${source}.provenance.json`);
  let provenanceBytes: Uint8Array | undefined;
  try {
    provenanceBytes = new Uint8Array(await readFile(sidecar));
  } catch (error) {
    if (
      options.sourceProvenance !== undefined ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw new InputError(`cannot read source provenance ${sidecar}`, { cause: error });
    }
  }
  let sourceProvenance: Record<string, unknown> | undefined;
  let disclosure = readDigitalSourceType(sourceBytes, sniffMediaType(sourceBytes));
  if (provenanceBytes !== undefined) {
    sourceProvenance = json(provenanceBytes, sidecar);
    if (sourceProvenance.generator === "transform") {
      const outputs = sourceProvenance.outputs;
      const matched = Array.isArray(outputs)
        ? (outputs.find(
            (o: unknown) =>
              typeof o === "object" &&
              o !== null &&
              (o as { sha256?: unknown }).sha256 === expected,
          ) as { digitalSourceType?: unknown } | undefined)
        : undefined;
      if (!matched) {
        throw new InputError("source provenance does not identify the selected source SHA-256");
      }
      if (disclosure === undefined && typeof matched.digitalSourceType === "string") {
        disclosure = parseDigitalSourceType(matched.digitalSourceType);
      }
    } else {
      // Generation provenance has stronger, existing media/record/mark binding checks.
      sourceProvenance = (await checkProvenance({
        media: { path: source, bytes: sourceBytes, mediaType: sniffMediaType(sourceBytes) },
        provenance: {
          path: sidecar,
          bytes: provenanceBytes,
          value: sourceProvenance as unknown as Provenance,
        },
      })) as unknown as Record<string, unknown>;
      const binding = sourceProvenance.binding as { mediaSha256?: unknown } | undefined;
      if (binding?.mediaSha256 !== expected) {
        throw new InputError("source provenance must bind the selected source SHA-256");
      }
      if (Array.isArray(sourceProvenance.calls) && sourceProvenance.calls.length > 0) {
        if (
          disclosure !== undefined &&
          disclosure !== DIGITAL_SOURCE_TYPES.generated &&
          disclosure !== DIGITAL_SOURCE_TYPES.composite
        ) {
          throw new InputError("source generation provenance contradicts the embedded disclosure");
        }
        disclosure =
          disclosure === DIGITAL_SOURCE_TYPES.composite
            ? disclosure
            : DIGITAL_SOURCE_TYPES.generated;
      }
    }
  }
  disclosure ??= options.digitalSourceType;
  requireDeclared(disclosure);
  const plan: {
    record: TransformRecord | AudioTransformRecord;
    plannedFiles: { path: string; bytes: Uint8Array }[];
  } = audio
    ? await transformAudioFiles({
        recipe,
        inputs: [source],
        inputName: options.name ?? "rendition",
        out: join(resolve(options.out), "planned"),
        digitalSourceType: disclosure,
        dryRun: true,
      })
    : await transformFiles({
        ...options,
        recipe,
        inputs: [source],
        inputName: options.name ?? "rendition",
        out: join(resolve(options.out), "planned"),
        digitalSourceType: disclosure,
        dryRun: true,
        engines,
      });
  // transformFiles reads the source itself. Refuse a source changed during planning as well.
  if (plan.record.sources[0]?.sha256 !== expected)
    throw new InputError("source SHA-256 changed during planning");
  for (const output of plan.record.outputs) requireDeclared(output.digitalSourceType);
  if (options.digitalSourceType === undefined) delete plan.record.sourceDeclaration;
  else plan.record.sourceDeclaration = sourceDeclaration(options.digitalSourceType);
  const markedModels = readMarkedModels(sourceBytes, sniffMediaType(sourceBytes));
  const models = markedModels
    ?.split(";")
    .map((name) => name.trim())
    .filter(Boolean);
  if (models?.length) {
    for (const [index, file] of plan.plannedFiles.entries()) {
      const output = plan.record.outputs[index]!;
      file.bytes = embedDigitalSourceType(file.bytes, output.mediaType, output.digitalSourceType, {
        models,
      });
      output.sha256 = sha256Hex(file.bytes);
    }
    for (const step of plan.record.steps.filter(
      (step) => step.op === "embed-digital-source-type",
    )) {
      step.params.models = models;
    }
  }
  const resolvedRecipe = plan.record.steps.map(({ op, params, engine }) => ({
    op,
    params,
    engine,
  }));
  const build = {
    version: "assetgrove-rendition/1",
    sourceSha256: expected,
    recipe: resolvedRecipe,
    style: "style" in plan.record ? plan.record.style : undefined,
    decoder: plan.record.sources[0]!.decodedBy,
    encoders: plan.record.outputs.map((o) => ({ mediaType: o.mediaType, encodedBy: o.encodedBy })),
    digitalSourceTypes: plan.record.outputs.map((o) => o.digitalSourceType),
  };
  const digest = sha256Hex(canonicalJson(build));
  const directory = join(resolve(options.out), digest);
  const outputs = plan.record.outputs.map((output) => {
    if (
      output.name.includes("/") ||
      output.name.includes("\\") ||
      [".", "..", ""].includes(output.name)
    )
      throw new InputError(`refused: unsafe rendition output name: ${output.name}`);
    return { ...output, path: join(directory, basename(output.path)) };
  });
  // An Ogg's C2PA manifest is a sidecar beside it; the Ogg's bytes, and so the digest, stay.
  const sidecars: (RenditionSidecar & { bytes?: Uint8Array; output: number })[] = [];
  const sign = options.sign ?? !options.preview;
  for (const [index, output] of outputs.entries()) {
    if (!takesSidecar(output.mediaType)) continue;
    const signer =
      options.signer ??
      (sign ? await resolveSigner(loadSettings()) : await existingSigner(loadSettings()));
    const name = sidecarName(basename(output.path));
    const path = join(directory, name);
    const existing =
      (options.existingSidecar && (await options.existingSidecar(name))) ??
      (await readFile(path).then(
        (b) => new Uint8Array(b),
        () => undefined,
      ));
    const claim = {
      digitalSourceType: output.digitalSourceType,
      models: models ?? [],
      title: basename(output.path),
    };
    const fileBytes = plan.plannedFiles[index]!.bytes;
    let bytes: Uint8Array | undefined;
    if (sign) {
      bytes = await sidecarCredentialed(
        fileBytes,
        output.mediaType,
        claim,
        signer!,
        assetgroveVersion(),
        existing,
      );
    } else if (signer !== undefined && existing !== undefined) {
      // Keep-or-sign without the signing: a sidecar that still holds is what the build keeps.
      if (await sidecarHolds(fileBytes, claim, signer, existing)) bytes = existing;
    }
    const sidecar: RenditionSidecar = {
      name,
      path,
      ...(bytes !== undefined && { sha256: sha256Hex(bytes) }),
      ...(signer !== undefined && { signer: signer.record }),
    };
    Object.assign(output, { contentCredentials: sidecar });
    sidecars.push({ ...sidecar, ...(bytes !== undefined && { bytes }), output: index });
  }
  checkWrites([
    ...outputs.map((output) => basename(output.path)),
    ...sidecars.map((s) => s.name),
    "provenance.json",
  ]);
  const provenancePath = join(directory, "provenance.json");
  const record = {
    ...plan.record,
    outputs: outputs as (TransformRecord | AudioTransformRecord)["outputs"],
    ...(sourceProvenance !== undefined && {
      sourceProvenance: {
        path: sidecar,
        sha256: sha256Hex(provenanceBytes!),
        record: sourceProvenance,
      },
    }),
    rendition: {
      digest,
      recipe: { name: options.recipe, path: recipePath, sha256: sha256Hex(recipeBytes) },
      resolvedRecipe,
      build,
    } as unknown,
  } as (TransformRecord | AudioTransformRecord) & {
    rendition: unknown;
    sourceProvenance?: unknown;
  };
  const files = plan.plannedFiles.map((file, i) => ({ ...file, path: outputs[i]!.path }));
  if (!options.preview) {
    const protectedPaths = [source, recipePath, ...(provenanceBytes ? [sidecar] : [])];
    const protectedStats = await Promise.all(protectedPaths.map((p) => stat(p)));
    // Check all existing targets before writing anything, including links to an input.
    for (const file of [
      ...files,
      ...sidecars.map((s) => ({ path: s.path, bytes: new Uint8Array() })),
      { path: provenancePath, bytes: new Uint8Array() },
    ]) {
      const existing = await lstat(file.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (
        existing &&
        (existing.isSymbolicLink() ||
          protectedStats.some((s) => s.dev === existing.dev && s.ino === existing.ino))
      ) {
        throw new InputError(`refused: rendition target aliases an input: ${file.path}`);
      }
      if (
        existing &&
        files.includes(file) &&
        sha256Hex(await read(file.path)) !== sha256Hex(file.bytes)
      ) {
        throw new InputError(`refused: existing rendition bytes differ: ${file.path}`);
      }
    }
    await mkdir(directory, { recursive: true });
    for (const file of files) {
      try {
        await writeFile(file.path, file.bytes, { flag: "wx" });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          sha256Hex(await read(file.path)) !== sha256Hex(file.bytes)
        )
          throw error;
      }
    }
    // A sidecar is replaced when it no longer held for these bytes; `sidecarCredentialed` kept it
    // otherwise, so an unchanged rendition keeps its bytes.
    for (const sidecar of sidecars) await writeFile(sidecar.path, sidecar.bytes!);
    await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  }
  return {
    record,
    provenancePath,
    digest,
    preview: options.preview ?? false,
    files,
    sidecars: sidecars.map(({ output, path, bytes }) => ({ output, path, bytes })),
  };
}
