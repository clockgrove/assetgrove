/** Preview and apply vocabulary normalization without inventing or discarding existing labels. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InputError } from "../errors.ts";
import { canonicalLabels, loadVocabulary } from "../library/labels.ts";
import {
  dropSummary,
  parseCard,
  setPersonFields,
  writeCard,
  rewriteMachineFields,
} from "../library/card.ts";
import { matchingSummaryEntry, summaryDigest } from "../library/summary.ts";
import { acquireLibraryLock } from "../runs/lock.ts";
import { scanLibrary, writeIfChanged, writeIndexes } from "../library/write.ts";
import { openProject, projectDir } from "../tree/project.ts";
import { defineCommand } from "./types.ts";

export const libraryLabelsCommand = defineCommand<{
  target?: string;
  apply?: boolean;
  dryRun?: boolean;
}>({
  name: "library labels",
  tool: "library_labels",
  summary: "preview or apply the project's canonical label vocabulary",
  details:
    "Reads .assetgrove/labels.json. Defaults to a dry run listing mappings, unknown values, collisions and affected cards. --apply normalizes known labels under the library lock, preserving unknown values, card prose and summary authorship. Collisions refuse all writes. Add an old name as an alias to rename a label.",
  input: {
    type: "object",
    properties: {
      target: { type: "string", description: "the project directory", placeholder: "<dir>" },
      apply: { type: "boolean", description: "apply the reported normalization" },
      dryRun: { type: "boolean", description: "preview without writing" },
    },
    additionalProperties: false,
  },
  effect: { readOnly: false, spends: "never", writes: "target" },
  async run(args, ctx) {
    if (args.apply && args.dryRun) throw new InputError("choose --apply or --dry-run");
    const project = await openProject(projectDir(args.target), ctx.settings.stateDir);
    const lock = args.apply
      ? acquireLibraryLock(project.library.root, ctx.settings.stateDir)
      : undefined;
    try {
      const vocabulary = loadVocabulary(project.dir);
      if (!vocabulary)
        throw new InputError(
          "no .assetgrove/labels.json; create the project's label vocabulary first",
        );
      const scan = scanLibrary(project.library.root);
      const unknown = new Map<string, string[]>();
      const affected: { card: string; before: string[]; after: string[] }[] = [];
      const planned = [];
      for (const found of scan.cards) {
        const path = join(found.dir, `${found.id}.md`);
        const card = parseCard(readFileSync(path, "utf8"), path);
        const before = (card.data["tags"] ?? []) as string[];
        for (const value of before)
          if (!vocabulary.mappings.has(value.trim().normalize("NFKC").toLowerCase())) {
            const cards = unknown.get(value) ?? [];
            cards.push(path);
            unknown.set(value, cards);
          }
        const after = canonicalLabels(before, vocabulary);
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        affected.push({ card: path, before, after });
        const entry = matchingSummaryEntry(card.data);
        let changed = setPersonFields(
          entry ? card : dropSummary(card, path),
          { tags: after },
          undefined,
          path,
        );
        if (entry)
          changed = rewriteMachineFields(
            changed,
            {
              ...changed.data,
              verified: (changed.data["verified"] as unknown[]).map((v) =>
                typeof v === "object" &&
                v !== null &&
                (v as { by?: string }).by === entry.by &&
                (v as { summary?: string }).summary === entry.summary
                  ? { ...entry, summary: summaryDigest(changed.data["description"], after) }
                  : v,
              ),
            },
            path,
          );
        planned.push({ path, card: changed });
      }
      const files: string[] = [];
      if (args.apply) {
        if (vocabulary.collisions.length)
          throw new InputError("label collisions must be resolved before applying");
        if (scan.unreadable.length)
          throw new InputError(
            "unreadable library records must be repaired before applying labels",
          );
        for (const item of planned)
          if (await writeIfChanged(item.path, writeCard(item.card))) files.push(item.path);
        if (files.length)
          files.push(
            ...(await writeIndexes(project.library, scanLibrary(project.library.root).cards, [])),
          );
      }
      return {
        exitCode: 0,
        fields: {
          applied: !!args.apply,
          vocabulary: vocabulary.path,
          mappings: [...vocabulary.mappings].map(([from, to]) => ({ from, to })),
          collisions: vocabulary.collisions,
          unknown: [...unknown].map(([value, cards]) => ({ value, cards })),
          affected,
          unreadable: scan.unreadable,
          files,
        },
        human: `${args.apply ? "Normalized" : "Would normalize"} ${affected.length} cards; ${unknown.size} unknown labels; ${vocabulary.collisions.length} collisions.`,
      };
    } finally {
      lock?.release();
    }
  },
});
