/** Project-owned, pinned, deterministic image renditions. No provider calls or target activation. */
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
import { checkWrites } from "../paths.ts";
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
  for (const step of recipe.steps) {
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
  const plan = await transformFiles({
    ...options,
    recipe,
    inputs: [source],
    inputName: "rendition",
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
    style: plan.record.style,
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
  checkWrites([...outputs.map((output) => basename(output.path)), "provenance.json"]);
  const provenancePath = join(directory, "provenance.json");
  const record: TransformRecord & { rendition: unknown; sourceProvenance?: unknown } = {
    ...plan.record,
    outputs,
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
    },
  };
  if (!options.preview) {
    const files = plan.plannedFiles.map((file, i) => ({ ...file, path: outputs[i]!.path }));
    const protectedPaths = [source, recipePath, ...(provenanceBytes ? [sidecar] : [])];
    const protectedStats = await Promise.all(protectedPaths.map((p) => stat(p)));
    // Check all existing targets before writing anything, including links to an input.
    for (const file of [...files, { path: provenancePath, bytes: new Uint8Array() }]) {
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
        file.path !== provenancePath &&
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
    await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  }
  return { record, provenancePath, digest, preview: options.preview ?? false };
}
