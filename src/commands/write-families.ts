import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatReport } from "../animation/run.ts";
import { digestOf, requireConfirmation } from "../confirm/index.ts";
import type { KindRequest } from "../confirm/index.ts";
import { readJson } from "../inputs.ts";
import {
  DEFAULT_JITTER_BOUND_PX,
  GROUPING_FILE,
  readImport,
  writeFamilies,
} from "../sheet/import.ts";
import { refusal } from "./result.ts";
import { defineCommand } from "./types.ts";

interface WriteFamiliesArgs {
  import: string;
  target: string;
  grouping?: string;
  jitterBound?: number;
}

/** The sha256 of each frame file an import lists, by file; one that cannot be read is left out. */
async function frameHashes(importDir: string, files: readonly string[]) {
  const hashes: Record<string, string> = {};
  for (const file of files) {
    try {
      hashes[file] = createHash("sha256")
        .update(await readFile(join(importDir, file)))
        .digest("hex");
    } catch {
      // writeFamilies reports a frame it cannot read.
    }
  }
  return hashes;
}

/**
 * The write request (design section 7): its digest covers the import, its frame files' bytes, the
 * grouping's digest, the target and the jitter bound, and it shows the families and the grouping
 * digest.
 */
export async function writeRequest(options: {
  importDir: string;
  grouping: unknown;
  targetDir: string;
  jitterBoundPx: number;
}): Promise<KindRequest> {
  const groupingDigest = digestOf(options.grouping);
  const record = await readImport(options.importDir);
  const files = Array.isArray(record.frames) ? record.frames.map((f) => f.file) : [];
  const body = {
    command: "write-families",
    import: resolve(options.importDir),
    inputs: {
      import: digestOf(record),
      frames: digestOf(await frameHashes(options.importDir, files)),
      grouping: groupingDigest,
    },
    target: resolve(options.targetDir),
    jitterBound: options.jitterBoundPx,
  };
  const g = options.grouping as { families?: unknown } | null;
  const families = Array.isArray(g?.families)
    ? g.families
        .map((f) => (f as { name?: unknown } | null)?.name)
        .filter((n) => typeof n === "string")
    : [];
  const id = digestOf(body);
  return {
    kind: "write",
    id,
    summary: `write ${families.length} famil${families.length === 1 ? "y" : "ies"} into ${body.target}`,
    details: { families, groupingDigest, import: body.import, target: body.target, digest: id },
    body,
    grouping: options.grouping,
  };
}

export const writeFamiliesCommand = defineCommand<WriteFamiliesArgs>({
  name: "write-families",
  tool: "write_families",
  summary: "write the strips of a human-confirmed grouping into the target, review pending",
  details: `Writes one strip and manifest per family of a grouping (status "confirmed") into the
target with review pending, registered within the jitter bound in pixels. The grouping's status
grants nothing: a person confirms the write of these families and this grouping digest (design
section 7) through headless settings, a record at <configDir>/confirmations/<hex>.json, an MCP client's form, the TTY,
or exit 8 confirmation_required and \`assetgrove confirm <hex>\`. Agents never confirm a write.
It spends nothing, so it asks no motion-template question: a family no grouping or spec declares a
template for, that no template is named for and no recorded decision chose one for, is written as
undecided, its ground-contact, footprint-drift and loop-seam checks pending ("not run: template
undecided") until \`animation-qa --import\` decides the template and runs them.`,
  input: {
    type: "object",
    properties: {
      import: {
        type: "string",
        description: "the import directory",
        placeholder: "<import directory>",
      },
      target: {
        type: "string",
        description: "the directory to write into",
        placeholder: "<target directory>",
      },
      grouping: {
        type: "string",
        description: "the confirmed grouping",
        placeholder: "<import>/grouping.json",
      },
      jitterBound: {
        type: "number",
        description: "the registration jitter bound in pixels",
        default: DEFAULT_JITTER_BOUND_PX,
      },
    },
    required: ["import", "target"],
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "target" },
  confirm: "write",
  async run(args, ctx) {
    const importDir = args.import;
    const groupingPath = args.grouping ?? join(importDir, GROUPING_FILE);
    const grouping = (await readJson<unknown>(groupingPath)).value;
    const jitterBoundPx = args.jitterBound ?? DEFAULT_JITTER_BOUND_PX;
    const confirmation = await requireConfirmation(
      await writeRequest({ importDir, grouping, targetDir: args.target, jitterBoundPx }),
      { settings: ctx.settings, ...(ctx.prompt && { prompt: ctx.prompt }) },
    );
    const result = await writeFamilies({
      importDir,
      grouping,
      targetDir: args.target,
      jitterBoundPx,
      gate: { settings: ctx.settings, ...(ctx.prompt && { prompt: ctx.prompt }) },
      ...(ctx.extensions && { registry: ctx.extensions }),
      confirmation,
    });
    const lines: string[] = [];
    for (const f of result.families) {
      lines.push(
        `${f.name}: ${f.frames.length} frames${f.mirrored ? " (mirrored)" : ""}, jitter ${f.jitterPx.toFixed(2)} px`,
        `  wrote ${f.result.mediaPath}`,
        `  wrote ${f.result.manifestPath}`,
      );
      for (const finding of f.result.ruleFindings ?? [])
        if (finding.status === "failed" && finding.severity === "warning")
          lines.push(
            `warning: project rule ${finding.rule}: ${finding.asset} (${finding.evidence})`,
          );
      if (f.fieldsNote !== undefined) lines.push(`  note: ${f.fieldsNote}`);
      if (f.result.provenancePath) lines.push(`  wrote ${f.result.provenancePath}`);
      lines.push(
        ...formatReport({ ...f.animation, identityFlicker: "skipped", holes: "skipped" }).map(
          (l) => `  ${l}`,
        ),
      );
      lines.push(`  onion skin ${f.onionPath}`, `  loop preview ${f.loopPreviewPath}`);
      if (f.result.validator) {
        lines.push(
          `  target validator ${f.result.validator.accepted ? "accepted" : "REJECTED"} it` +
            (f.result.validator.output ? `: ${f.result.validator.output}` : ""),
        );
      }
    }
    lines.push(`preview loop: ${result.previewPath}`);
    const fields = { ...result, confirmation };
    const human = lines.join("\n");
    if (result.families.some((f) => f.result.validator?.accepted === false)) {
      return refusal(
        "validator_rejected",
        "the target's validator rejected a written family",
        fields,
        human,
      );
    }
    return { exitCode: 0, fields, human };
  },
});
