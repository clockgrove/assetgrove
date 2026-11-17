/**
 * Which library clip a requested animation family is (#378). A family that is exactly a key of the
 * clip route's library for the gait is planned with no call. Any other family is put to one typed
 * choice decision: the family, the gait and the gait's library clips, answering which clip it is or
 * none. A clip chosen with probability of at least `CLIP_MAP_MIN_PROBABILITY` (or with none
 * reported) is planned under the requested family's name; none or a lower probability leaves the
 * family reported missing. A run decides each family once, whatever its candidate count.
 */
import type { Caller } from "../calls.ts";
import { ProviderError } from "../errors.ts";
import { CLIP_MAP_OPERATION } from "../routes.ts";
import type { Route } from "../routes.ts";
import type { ClipPlan } from "./qa.ts";
import type { CharacterSpec } from "./profile.ts";

export const CLIP_MAP_MIN_PROBABILITY = 0.5;
export const CLIP_MAP_NONE = "none";

type Library = NonNullable<Route["library"]>[string];

export interface MappedClip {
  family: string;
  key: string;
  clip: string;
  probability?: number;
  model: string;
}

export interface ClipPlans {
  planned: Array<ClipPlan & { clip: string }>;
  missing: Array<{ family: string; why: string }>;
  mapped: MappedClip[];
}

interface Decided {
  choice: string;
  probability?: number;
  model: string;
}

/** Decisions of a run by family, gait and clip route model; shared by the run's candidates. */
export class ClipMapCache {
  readonly #memory = new Map<string, Decided>();

  get(family: string, gait: string, routeModel: string): Decided | undefined {
    return this.#memory.get(JSON.stringify([family, gait, routeModel]));
  }

  set(family: string, gait: string, routeModel: string, decided: Decided): void {
    this.#memory.set(JSON.stringify([family, gait, routeModel]), decided);
  }
}

function libraryOf(route: Route | undefined, gait: string): Library {
  return route?.library?.[gait] ?? {};
}

function isClip(entry: Library[string] | undefined): entry is Library[string] {
  return entry !== undefined && typeof entry.clip === "string";
}

/** The requested families that need a clip-map decision: not a library key, in a gait with clips. */
export function familiesToMap(character: CharacterSpec, route: Route | undefined): string[] {
  const library = libraryOf(route, character.gait);
  if (Object.keys(library).length === 0) return [];
  return character.clips.filter(
    (family) => !(Object.hasOwn(library, family) && isClip(library[family])),
  );
}

/** Which requested families the library has by exact key; every other family is missing. */
export function clipPlan(
  character: CharacterSpec,
  route: Route | undefined,
): Pick<ClipPlans, "planned" | "missing"> {
  const library = libraryOf(route, character.gait);
  const planned: ClipPlans["planned"] = [];
  const missing: ClipPlans["missing"] = [];
  for (const family of character.clips) {
    const entry = Object.hasOwn(library, family) ? library[family] : undefined;
    if (isClip(entry)) planned.push({ family, clip: entry.clip, loop: entry.loop === true });
    else missing.push({ family, why: noClip(route, character.gait, family) });
  }
  return { planned, missing };
}

function noClip(route: Route | undefined, gait: string, family: string): string {
  return `the ${route?.model ?? "clip route"} library has no close ${gait} clip for "${family}"`;
}

function prompt(family: string, gait: string, library: Library): string {
  const clips = Object.entries(library)
    .map(([key, entry]) => `- ${key} (${entry.loop ? "loops" : "plays once"})`)
    .join("\n");
  return [
    `A 3D character game asset needs an animation of the requested family. Requested animation: "${family}". Gait: ${gait}.`,
    `The provider's ${gait} animation library has these clips:`,
    clips,
    `Which of these library clips is the requested animation, or none? Answer none when no clip is the same kind of motion.`,
  ].join("\n");
}

function options(library: Library): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(library)) {
    out[key] = `the library clip ${key}, which ${entry.loop ? "loops" : "plays once"}`;
  }
  out[CLIP_MAP_NONE] = "no library clip is the requested animation";
  return out;
}

/** The clips a request plans: exact keys as they are, every other family by a decision, cached per run. */
export async function resolveClipPlan(
  call: Caller,
  character: CharacterSpec,
  clipsOperation: string,
  cache: ClipMapCache,
): Promise<ClipPlans> {
  const route = call.route(clipsOperation);
  const library = libraryOf(route, character.gait);
  const planned: ClipPlans["planned"] = [];
  const missing: ClipPlans["missing"] = [];
  const mapped: MappedClip[] = [];
  for (const family of character.clips) {
    const exact = Object.hasOwn(library, family) ? library[family] : undefined;
    if (isClip(exact)) {
      planned.push({ family, clip: exact.clip, loop: exact.loop === true });
      continue;
    }
    const why = noClip(route, character.gait, family);
    if (Object.keys(library).length === 0) {
      missing.push({ family, why });
      continue;
    }
    let decided = cache.get(family, character.gait, route.model);
    if (!decided) {
      const { result, record } = await call.decide(
        CLIP_MAP_OPERATION,
        prompt(family, character.gait, library),
        [],
        {
          type: "choice",
          instructions: "Choose the library clip that is the requested animation, or none.",
          options: options(library),
        },
      );
      const choice = result.answer.type === "choice" ? result.answer.choice : undefined;
      if (choice === undefined || (choice !== CLIP_MAP_NONE && !Object.hasOwn(library, choice))) {
        throw new ProviderError(`the ${CLIP_MAP_OPERATION} decision gave no library clip or none`);
      }
      const probability = record.decision?.value;
      decided = {
        choice,
        ...(probability !== undefined && { probability }),
        model: record.model,
      };
      cache.set(family, character.gait, route.model, decided);
    }
    const entry = decided.choice === CLIP_MAP_NONE ? undefined : library[decided.choice];
    if (decided.choice === CLIP_MAP_NONE || !isClip(entry)) {
      missing.push({ family, why: `${why}; the ${CLIP_MAP_OPERATION} decision answered none` });
    } else if (
      decided.probability !== undefined &&
      decided.probability < CLIP_MAP_MIN_PROBABILITY
    ) {
      missing.push({
        family,
        why: `${why}; the ${CLIP_MAP_OPERATION} decision chose ${decided.choice} with probability ${decided.probability.toFixed(2)}, under ${CLIP_MAP_MIN_PROBABILITY}`,
      });
    } else {
      planned.push({ family, clip: entry.clip, loop: entry.loop === true });
      mapped.push({
        family,
        key: decided.choice,
        clip: entry.clip,
        ...(decided.probability !== undefined && { probability: decided.probability }),
        model: decided.model,
      });
    }
  }
  return { planned, missing, mapped };
}
