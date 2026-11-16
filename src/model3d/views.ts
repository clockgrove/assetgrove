/**
 * Which view each approved reference of a 3D request shows (#325), for generation and look-dev
 * alike. A `view` the bible declares on the reference wins; otherwise a typed choice decision is
 * shown the image and its role and chooses among the views below. The answer is cached by the
 * image's sha256: in memory for the run and, when the command has a state directory, in
 * `<stateDir>/reference-views/<sha256>.json`. A request with no front view is refused before its
 * first expensive call.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Caller } from "../calls.ts";
import { InputError } from "../errors.ts";
import type { PlannedCall } from "../generators/generator.ts";
import { loadReference, subjectOf } from "../request.ts";
import { REFERENCE_VIEW_OPERATION } from "../routes.ts";
import type { Routes } from "../routes.ts";
import type { AssetSpec, BibleReference, LoadedReference, StyleBible } from "../types.ts";

/** The views a reference can show, each with what it means (the choice's options). */
export const REFERENCE_VIEWS = {
  front: "a single full-body view of the character from the front, facing the viewer",
  left: "a single full-body view of the character's own left side, in profile",
  right: "a single full-body view of the character's own right side, in profile",
  back: "a single full-body view of the character from behind",
  "three-quarter":
    "a single full-body view of the character turned about halfway between front and side",
  sheet: "several views of the character on one sheet (a turnaround or character sheet)",
  detail: "not a full-body view: a close-up of the head or a part, an expression, a pose detail",
} as const;

export type ReferenceView = keyof typeof REFERENCE_VIEWS;

/** How a reference's view was known: declared by the bible, judged now, or judged earlier. */
export type ViewSource = "declared" | "judged" | "cached";

export interface ViewedReference extends LoadedReference {
  view: ReferenceView;
  viewSource: ViewSource;
  /** The judged view's probability, when it was judged. */
  probability?: number;
}

export function isReferenceView(value: unknown): value is ReferenceView {
  return typeof value === "string" && Object.hasOwn(REFERENCE_VIEWS, value);
}

/** Throws for a declared `view` that names none of the views. */
export function checkDeclaredView(reference: { path: string; view?: unknown }, where: string) {
  if (reference.view !== undefined && !isReferenceView(reference.view)) {
    throw new InputError(
      `${where}: reference ${reference.path} declares view ${JSON.stringify(reference.view)}; ` +
        `a view is one of ${Object.keys(REFERENCE_VIEWS).join(", ")}`,
    );
  }
}

/**
 * The bible's references of the spec's subject, without the perspective sample; with `byLook`,
 * only those of the spec's look (or of every look).
 */
export function subjectBibleReferences(
  spec: AssetSpec,
  bible: StyleBible,
  options: { byLook?: boolean } = {},
): BibleReference[] {
  const subject = subjectOf(spec);
  return (bible.references ?? []).filter(
    (r) =>
      r.subject === subject &&
      r.role !== "perspective" &&
      (!options.byLook || r.look === undefined || spec.look === undefined || r.look === spec.look),
  );
}

/**
 * The view calls a request forecasts: one per reference with no declared view. An upper bound,
 * so the confirmed request does not depend on what the cache holds.
 */
export function planReferenceViews(references: BibleReference[], routes: Routes): PlannedCall[] {
  const undeclared = references.filter((r) => r.view === undefined);
  if (undeclared.length === 0) return [];
  const route = Object.hasOwn(routes, REFERENCE_VIEW_OPERATION)
    ? routes[REFERENCE_VIEW_OPERATION]
    : undefined;
  if (!route) throw new InputError(`no model route for operation "${REFERENCE_VIEW_OPERATION}"`);
  return undeclared.map(() => ({
    operation: REFERENCE_VIEW_OPERATION,
    model: route.model,
    estimatedCostUsd: route.estimatedCostUsd,
  }));
}

interface CachedView {
  view: ReferenceView;
  probability?: number;
  model: string;
  role: string;
}

/** Judged views by image sha256: in memory for the run, and on disk under a state directory. */
export class ReferenceViewCache {
  readonly #memory = new Map<string, CachedView>();
  readonly #dir: string | undefined;

  constructor(stateDir?: string) {
    this.#dir = stateDir !== undefined ? join(stateDir, "reference-views") : undefined;
  }

  async get(sha256: string): Promise<CachedView | undefined> {
    const held = this.#memory.get(sha256);
    if (held || this.#dir === undefined) return held;
    try {
      const value = JSON.parse(await readFile(join(this.#dir, `${sha256}.json`), "utf8")) as
        Partial<CachedView> | undefined;
      if (!value || !isReferenceView(value.view)) return undefined;
      const cached: CachedView = {
        view: value.view,
        ...(typeof value.probability === "number" && { probability: value.probability }),
        model: typeof value.model === "string" ? value.model : "",
        role: typeof value.role === "string" ? value.role : "",
      };
      this.#memory.set(sha256, cached);
      return cached;
    } catch {
      return undefined;
    }
  }

  async set(sha256: string, value: CachedView): Promise<void> {
    this.#memory.set(sha256, value);
    if (this.#dir === undefined) return;
    await mkdir(this.#dir, { recursive: true });
    const file = join(this.#dir, `${sha256}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temp, file);
  }
}

function viewPrompt(role: string): string {
  return [
    "The image is an approved reference of a character, for building its 3D model.",
    `The style bible names its role: "${role}". The role may not name the view; judge from the image.`,
    "Which view of the character does the image show? Left and right are the character's own left and right side, not the viewer's.",
  ].join("\n");
}

/**
 * Which view each reference shows: the bible's declared view, else the cache, else one typed
 * choice decision on the image and its role (made through `call`, inside the run's budget).
 */
export async function referenceViews(
  call: Caller,
  references: Array<LoadedReference & { declared?: string | undefined }>,
  cache: ReferenceViewCache,
): Promise<ViewedReference[]> {
  const out: ViewedReference[] = [];
  for (const { declared, ...reference } of references) {
    if (declared !== undefined) {
      checkDeclaredView({ path: reference.path, view: declared }, "the style bible");
      out.push({ ...reference, view: declared as ReferenceView, viewSource: "declared" });
      continue;
    }
    const cached = await cache.get(reference.sha256);
    if (cached) {
      out.push({
        ...reference,
        view: cached.view,
        viewSource: "cached",
        ...(cached.probability !== undefined && { probability: cached.probability }),
      });
      continue;
    }
    const { result, record } = await call.decide(
      REFERENCE_VIEW_OPERATION,
      viewPrompt(reference.role),
      [reference],
      {
        type: "choice",
        instructions: "Choose the view the image shows.",
        options: { ...REFERENCE_VIEWS },
      },
    );
    if (result.answer.type !== "choice" || !isReferenceView(result.answer.choice)) {
      throw new InputError(`the ${REFERENCE_VIEW_OPERATION} decision gave no view`);
    }
    const view = result.answer.choice;
    const probability = record.decision?.value;
    await cache.set(reference.sha256, {
      view,
      ...(probability !== undefined && { probability }),
      model: record.model,
      role: reference.role,
    });
    out.push({
      ...reference,
      view,
      viewSource: "judged",
      ...(probability !== undefined && { probability }),
    });
  }
  return out;
}

/** Loads the references and answers which view each shows; see `referenceViews`. */
export async function loadReferenceViews(
  call: Caller,
  references: BibleReference[],
  bibleDir: string,
  cache: ReferenceViewCache,
): Promise<ViewedReference[]> {
  const loaded = await Promise.all(
    references.map(async (r) => ({
      ...(await loadReference(r.path, r.role, bibleDir)),
      declared: r.view,
    })),
  );
  return referenceViews(call, loaded, cache);
}

/** What each reference was judged (or declared) to show, for an error or a reason. */
export function describeViews(references: ViewedReference[]): string {
  return references
    .map(
      (r) =>
        `${r.path} ("${r.role}"): ${r.view}` +
        (r.viewSource === "declared"
          ? " (declared)"
          : ` (judged${r.probability !== undefined ? `, p ${r.probability.toFixed(2)}` : ""}${r.viewSource === "cached" ? ", cached" : ""})`),
    )
    .join("; ");
}

/** Refuses a request whose references show no front view, naming what each was judged to show. */
export function requireFront(references: ViewedReference[]): void {
  if (references.some((r) => r.view === "front")) return;
  throw new InputError(
    `no approved reference shows the character's front view, so no paid 3D call was made: ` +
      `${describeViews(references)}. Add a front view, or declare "view": "front" on the reference that shows it`,
  );
}

/** The views as recorded in provenance, one per reference. */
export function viewRecord(references: ViewedReference[]) {
  return references.map((r) => ({
    role: r.role,
    path: r.path,
    sha256: r.sha256,
    view: r.view,
    viewSource: r.viewSource,
    ...(r.probability !== undefined && { probability: Math.round(r.probability * 1e4) / 1e4 }),
  }));
}
