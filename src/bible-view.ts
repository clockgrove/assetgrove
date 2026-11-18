/**
 * The style view of a BIBLE.md: the palette, subject references, perspective sample, subject
 * descriptions, mood and style notes that `stage`, `generate-sheet`, `import`, `look-dev`,
 * `request-change` and `fix-frame` read. BIBLE.md is the one style bible; this view is derived from
 * it on every load and never written, so the constitution and these commands cannot drift apart.
 */
import type { ArtBible, BibleDocument } from "./bible.ts";
import { biblePalette } from "./bible.ts";
import type { BibleReference, StyleBible } from "./types.ts";

type Axes = ArtBible["axes"];
type AxisKey = keyof Axes;

const AXES: [AxisKey, string][] = [
  ["rendering", "rendering"],
  ["realism", "realism"],
  ["proportions", "proportions"],
  ["outline", "outline"],
  ["shading", "shading"],
  ["detailDensity", "detail"],
  ["texture", "texture"],
  ["lightingKey", "lighting"],
];

function axisText(key: AxisKey, axes: Partial<Axes>): string | undefined {
  const value = axes[key];
  if (value === undefined) return undefined;
  return key === "outline" ? (value as Axes["outline"]).weight : String(value);
}

/**
 * The notes every asset gets, then each look's. An axis that a look overrides is written for every
 * asset with "unless the asset's look sets it", and the look adds its own value, so an asset with
 * no look keeps the world's whole style and one with a look gets its look's.
 */
function styleNotesOf(bible: ArtBible): { notes: string[]; looks: StyleBible["looks"] } {
  const looks = bible.looks ?? {};
  const overridden = new Set(
    Object.values(looks).flatMap((look) => Object.keys(look) as AxisKey[]),
  );
  const notes: string[] = [];
  for (const [key, label] of AXES) {
    const text = axisText(key, bible.axes);
    if (text === undefined) continue;
    notes.push(
      overridden.has(key)
        ? `${label}: ${text} (unless the asset's look sets it)`
        : `${label}: ${text}`,
    );
  }
  notes.push(`audience: ${bible.tone.audience}`, ...bible.tone.contentLimits);
  return {
    notes,
    looks: Object.fromEntries(
      Object.entries(looks).map(([name, look]) => [
        name,
        {
          notes: AXES.flatMap(([key, label]) => {
            const text = axisText(key, look);
            return text === undefined ? [] : [`${label} for this look: ${text}`];
          }),
        },
      ]),
    ),
  };
}

/**
 * Each subject's references: the positive anchors that name a subject (the perspective sample
 * left out), then each identity lock's approved turnaround and references not already listed for
 * that subject. Negative anchors are planning's alone and are not sent here.
 */
function referencesOf(bible: ArtBible): BibleReference[] {
  const anchors = bible.anchors.positive
    .filter((anchor) => anchor.path !== bible.perspective)
    .map(({ path, role, subject, look, view, license }) => ({
      path,
      role,
      ...(subject !== undefined && { subject }),
      ...(look !== undefined && { look }),
      ...(view !== undefined && { view }),
      ...(license !== undefined && { license }),
    }));
  const listed = new Set(anchors.map((r) => `${r.subject ?? ""}\0${r.path}`));
  const locked: BibleReference[] = Object.entries(bible.identities).flatMap(([subject, lock]) =>
    [
      { path: lock.turnaround, role: "approved turnaround", subject },
      ...(lock.references ?? []).map((path) => ({ path, role: "identity reference", subject })),
    ].filter((r) => !listed.has(`${subject}\0${r.path}`)),
  );
  return [...anchors, ...locked];
}

/** Each subject's description: `subjects`, else what its identity lock says of it. */
function subjectsOf(bible: ArtBible): StyleBible["subjects"] {
  const subjects: Record<string, { description: string }> = {};
  for (const [name, lock] of Object.entries(bible.identities))
    subjects[name] = {
      description: [lock.proportions, ...lock.signatureFeatures].filter(Boolean).join("; "),
    };
  return { ...subjects, ...(bible.subjects ?? {}) };
}

/** The style view of a loaded BIBLE.md (see the module comment). */
export function styleBibleOf(doc: BibleDocument): StyleBible {
  const bible = doc.data;
  const { notes, looks } = styleNotesOf(bible);
  return {
    ...(bible.format !== undefined && { format: bible.format }),
    version: bible.version,
    ...(bible.referenceLicense !== undefined && { referenceLicense: bible.referenceLicense }),
    palette: biblePalette(bible),
    references: referencesOf(bible),
    ...(bible.perspective !== undefined && { perspective: bible.perspective }),
    ...(bible.perspectiveDescription !== undefined && {
      perspectiveDescription: bible.perspectiveDescription,
    }),
    subjects: subjectsOf(bible),
    mood: bible.tone.moodRange,
    notes,
    looks,
  };
}
