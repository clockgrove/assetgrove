/**
 * The set-up of the set-level audit's real check (test/real/audit.real.ts): a three-asset synthetic
 * set with an identity lock and a style bible the audit accepts. Shared with the offline test
 * (test/audit-real-setup.test.ts), which runs it through the audit's plan step with no provider
 * call, so a set-up the audit refuses fails in `pnpm test` and not only in a paid run.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BIBLE_PRESETS, serializeBible } from "../../src/bible.ts";
import { encodePng } from "../../src/image/raster.ts";
import { GAME, fixtureLibrary } from "./library.ts";
import { drawSubject } from "./synthetic.ts";

/** The prose of the check's bible: a Markdown bible must carry a Do's and Don'ts section. */
export const AUDIT_BIBLE_PROSE = "# Synthetic\n\n## Do's and Don'ts\nDo.\n";

export interface AuditSet {
  /** The fixture library's folder: the audit's target. Remove it when done. */
  dir: string;
  /** The tree folder the audit reads. */
  set: string;
}

/** Writes the three-asset set, its identity turnaround and its style bible into a fixture library. */
export function auditSet(): AuditSet {
  const lib = fixtureLibrary({ bulk: 3 });
  // Images large enough for every vision model; the third one drawn differently.
  for (let i = 0; i < 3; i++)
    writeFileSync(
      join(lib.root, "bulk", `bulk-00${i}.png`),
      encodePng(drawSubject(384, i === 2 ? 3 : 0)),
    );
  const art = join(lib.dir, ".assetgrove", "art-direction");
  writeFileSync(join(art, "pebble.png"), encodePng(drawSubject(384)));
  const bible = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  bible.referenceLicense = "NOASSERTION";
  bible.world = "Synthetic";
  bible.identities = {
    pebble: {
      version: "pebble-1",
      approved: true,
      turnaround: "pebble.png",
      signatureFeatures: ["a round body"],
      proportions: "as wide as tall",
      palette: ["#808080"],
    },
  };
  writeFileSync(join(art, "BIBLE.md"), serializeBible(bible, AUDIT_BIBLE_PROSE));
  return { dir: lib.dir, set: `asset://${GAME}/by-tag/bulk/` };
}
