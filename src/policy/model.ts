/**
 * The prompt policy's model check (design section 16). After confirmation, a run's first job is
 * one Choice decide call per ambiguous name a person-written part holds (the protected name, an
 * ordinary word or an unrelated name; only the first refuses), then one Boolean decide call on the `prompt-policy` operation (the decisions role) about the prompt
 * text the plan step collected, given as labelled parts with the blocklist's phrase and
 * ambiguous-name hits and the words around them. The probability is cut per decisions route
 * (src/policy/cuts.ts): under `confirmAt` the run goes on, from `confirmAt` to `refuseAt` a person
 * confirms it (exit 8, the record is `borderline`), and `refuseAt` or more refuses the request
 * with exit 9 `prompt_refused`, unless it objects only to text the prompt compiler wrote: a second
 * call on the person's parts alone then decides, and when it allows, the run uses the template's
 * prompt and records why. The check fails closed: a call that fails or answers out of type exits 4
 * `provider_error`, and an operation no configured provider serves exits 2 `route_unavailable`,
 * at the plan step, before anything is spent.
 */
import type { Caller } from "../calls.ts";
import { classify } from "../commands/result.ts";
import { ProviderError } from "../errors.ts";
import type { DecisionQuestion } from "../gateway/provider.ts";
import { PROMPT_POLICY_OPERATION } from "../routes.ts";
import type { Route } from "../routes.ts";
import type { PromptPolicyCut } from "./cuts.ts";
import { asParts, modelWritten, PromptRefusedError, readingTerms } from "./text.ts";
import type {
  NameReading,
  PolicyHit,
  PolicyReading,
  PromptPart,
  PromptPartLabel,
  PromptPolicyCheck,
  PromptPolicyRecord,
} from "./text.ts";

export { PROMPT_POLICY_OPERATION };

/** The Boolean question the model answers about a request's prompt text. */
export const PROMPT_POLICY_QUESTION: DecisionQuestion = {
  type: "boolean",
  instructions:
    "Does this game-asset generation request ask to copy or imitate a specific living artist's style, a studio's or a named game's look, a copyrighted character, or a real person's likeness, by name or by an unmistakable description? Judge what the request asks for, not the words in it. The parts are labelled: the bible's Do's and Don'ts are rules the art must follow, so a rule that forbids imitating a work asks for originality; text marked model-written was written by the prompt compiler, not the person, and a negative prompt lists what the image must not show. A genre, medium or era, the developer's own game named as such, and a fix note that recreates part of the asset's own earlier frame do not ask for a copy. A flagged word that is also an ordinary word or a given name counts only when it is used here as that name.",
  whenTrue:
    "it names or unmistakably describes a specific artist, studio, game, copyrighted character or real person whose work or likeness the output would copy",
  whenFalse:
    "it describes an original asset in plain visual words (genre, palette, medium, shapes), even when the words resemble a well-known work",
};

/** What each part is, as the model is told. */
const PART_TITLES: Readonly<Record<PromptPartLabel, string>> = {
  spec: "asset spec (the developer's strings)",
  brief: "brief (the developer's request)",
  tone: "art bible tone fields",
  rules: "art bible Do's and Don'ts: rules the art must follow, not requests",
  template: "prompt template body (the repository's wording)",
  text: "other request text (a note, a subject or a profile's text)",
  "model-prompt": "compiled prompt: model-written by the prompt compiler, not by the person",
  "model-negative":
    "compiled negative prompt: model-written by the prompt compiler, what the image must not show",
};

/**
 * The text the model is given: each part of the request's prompt text, labelled and set apart
 * between markers, then the blocklist's hits with the words around them. A plain string is one
 * unlabelled part.
 */
export function promptPolicyPrompt(
  text: string | readonly PromptPart[],
  hits: readonly PolicyHit[] = [],
  readings: readonly PolicyReading[] = [],
): string {
  if (typeof text === "string")
    return `Game-asset generation request (prompt text, verbatim between the markers):\n<<<\n${text}\n>>>`;
  const sections = text
    .filter((p) => p.text.trim().length > 0)
    .map((p) => `[${p.label}] ${PART_TITLES[p.label]}:\n<<<\n${p.text}\n>>>`);
  // A reading covers the person-written hits it was asked about; the compiler's use of the same
  // name was never read, so it stays on the Boolean call's flagged words.
  const read = new Set(readings.map((r) => r.term));
  const flagged = hits
    .filter((h) => !(read.has(h.term) && !modelWritten({ label: h.part })))
    .map(
      (h) =>
        `- "${h.term}" (${h.ambiguous ? `${h.kind} name that is also an ordinary word or a given name` : h.kind}) in [${h.part}]: "... ${h.context} ..."`,
    );
  return [
    "Game-asset generation request, in labelled parts (each verbatim between the markers):",
    ...sections,
    ...(flagged.length > 0
      ? [
          "Words the blocklist flagged, with the words around them; none refuses by itself, decide what each asks for:",
          ...flagged,
        ]
      : []),
    ...(readings.length > 0
      ? [
          "Flagged names already read in the person-written parts as not the protected name (do not count those uses as one; a model-written use listed above is still to be decided):",
          ...readings.map(
            (r) =>
              `- "${r.term}": ${r.reading === "word" ? "an ordinary word" : "an unrelated name"}`,
          ),
        ]
      : []),
  ].join("\n");
}

/** The Choice question an ambiguous name's reading call answers: what the word refers to here. */
export function nameReadingQuestion(term: string, kind: string): DecisionQuestion {
  return {
    type: "choice",
    instructions: `The blocklist flagged "${term}", the name of a ${kind} whose work, look or likeness generated art must not copy, and also an ordinary word or a given name. Read the sentences it appears in and the labelled request. Which does "${term}" refer to in this request?`,
    options: {
      protected: `the protected ${kind} "${term}" itself: the request names it to copy or evoke its work, look or likeness`,
      word: `an ordinary word with its everyday meaning (for example weather, a size or a kind of thing), not the ${kind}`,
      "other-name": `an unrelated name: a different person, character, place or thing that happens to share the name, not the ${kind}`,
    },
  };
}

/** The text a reading call is given: the term, its kind, its sentences and the labelled parts. */
export function nameReadingPrompt(
  hits: readonly PolicyHit[],
  parts: readonly PromptPart[],
): string {
  const first = hits[0]!;
  return [
    `Flagged word: "${first.term}" (blocklist kind: ${first.kind}; also an ordinary word or a given name).`,
    "Where it appears, with the words around it:",
    ...hits.map((h) => `- in [${h.part}]: "... ${h.context} ..."`),
    promptPolicyPrompt(parts),
  ].join("\n");
}

/** The term a reading call asks about; for scripted providers and tests. */
export function nameReadingAsked(prompt: string): string | undefined {
  return /^Flagged word: "([^"]*)"/m.exec(prompt)?.[1];
}

/**
 * One Choice decide call on `prompt-policy` per ambiguous name a person-written part holds
 * (`readingTerms`). A call that fails or answers out of type throws (exit 4).
 */
export async function readAmbiguousNames(
  caller: Caller,
  parts: readonly PromptPart[],
  hits: readonly PolicyHit[] | undefined,
): Promise<PolicyReading[]> {
  const readings: PolicyReading[] = [];
  for (const group of readingTerms(hits)) {
    const { term, kind } = group[0]!;
    let result;
    try {
      result = await caller.decide(
        PROMPT_POLICY_OPERATION,
        nameReadingPrompt(group, parts),
        [],
        nameReadingQuestion(term, kind),
      );
    } catch (error) {
      if (classify(error).code !== "internal_error") throw error;
      throw new ProviderError(
        `the prompt-policy check could not read "${term}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const { answer } = result.result;
    if (answer.type !== "choice")
      throw new ProviderError(`the prompt-policy check did not choose a reading of "${term}"`);
    const probability = result.record.decision?.value;
    readings.push({
      term,
      kind,
      reading: answer.choice as NameReading,
      model: result.record.route,
      ...(probability !== undefined && { probability }),
    });
  }
  return readings;
}

/** The route the model check would run on; throws `RouteUnavailableError` when none serves it. */
export function promptPolicyRoute(routes: Readonly<Record<string, Route>>): Route {
  return routes[PROMPT_POLICY_OPERATION]!;
}

/** The model check's verdict on one text: its probability and the call's route. */
export interface PromptModelVerdict {
  probability: number;
  /** `<provider>:prompt-policy:<model>`. */
  model: string;
  /** `allow` under the cut's `confirmAt`, `confirm` up to its `refuseAt`, `refuse` from it. */
  band: "allow" | "confirm" | "refuse";
  refused: boolean;
}

/**
 * One Boolean decide call on `prompt-policy` about `text`. A call that fails or answers out of
 * type throws (a provider failure is exit 4); a refused route or budget keeps its own error.
 */
export async function decidePromptPolicy(
  caller: Caller,
  text: string | readonly PromptPart[],
  hits: readonly PolicyHit[] = [],
  readings: readonly PolicyReading[],
  cut: PromptPolicyCut,
): Promise<PromptModelVerdict> {
  let result;
  try {
    result = await caller.decide(
      PROMPT_POLICY_OPERATION,
      promptPolicyPrompt(text, hits, readings),
      [],
      PROMPT_POLICY_QUESTION,
    );
  } catch (error) {
    // An error with its own exit (a refused route, budget, limit or input) keeps it; anything
    // else is the check failing to run: fail closed, exit 4.
    if (classify(error).code !== "internal_error") throw error;
    throw new ProviderError(
      `the prompt-policy check could not run: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const { answer } = result.result;
  if (answer.type !== "boolean" || !Number.isFinite(answer.probability))
    throw new ProviderError("the prompt-policy check did not answer with a probability");
  const probability = Math.min(1, Math.max(0, answer.probability));
  const band =
    probability >= cut.refuseAt ? "refuse" : probability >= cut.confirmAt ? "confirm" : "allow";
  return { probability, model: result.record.route, band, refused: band === "refuse" };
}

/**
 * The run's prompt-policy job. First, one reading call per ambiguous name a person-written part
 * holds (`readAmbiguousNames`): a `protected` reading throws `PromptRefusedError` with the
 * readings recorded, and no other call runs. Then it decides on the labelled `parts` with the
 * record's hits (minus the names read as not protected) and returns
 * the plan step's record with the model and probability added; throws `PromptRefusedError` (exit
 * 9) at the cut's `refuseAt` or more. An answer from `confirmAt` up returns the record allowed
 * with `borderline`: the run asks a person before it goes on. When the parts hold model-written
 * text and the check does not allow, a second call on the person-written parts alone decides: if
 * it allows or is borderline, the record carries `fallback` saying why, and the command uses the
 * template's prompt in place of the compiler's.
 */
export async function checkPromptModel(
  caller: Caller,
  parts: string | readonly PromptPart[],
  given: PromptPolicyRecord,
  cut: PromptPolicyCut,
): Promise<PromptPolicyRecord> {
  const all = asParts(parts);
  // Each ambiguous name a person wrote is read in its sentence first; a protected reading refuses.
  const readings = await readAmbiguousNames(caller, all, given.hits);
  const record: PromptPolicyRecord = {
    ...(readings.length > 0 ? { ...given, readings } : given),
    cut,
  };
  if (readings.some((r) => r.reading === "protected"))
    throw new PromptRefusedError({ ...record, verdict: "refused" }, "the request's prompt text");
  const verdict = await decidePromptPolicy(caller, all, record.hits, readings, cut);
  const first = answer("all", verdict);
  const checked = (
    decided: PromptModelVerdict,
    checks: PromptPolicyCheck[],
    fallback?: string,
  ): PromptPolicyRecord => ({
    ...record,
    verdict: decided.refused && !fallback ? "refused" : "allowed",
    model: decided.model,
    probability: decided.probability,
    checks,
    ...(fallback !== undefined && { fallback }),
    ...(decided.band === "confirm" && { borderline: true as const }),
  });
  if (verdict.band === "allow") return checked(verdict, [{ ...first, decided: true }]);
  const person = all.filter((p) => !modelWritten(p));
  if (person.length === all.length) {
    const decided = checked(verdict, [{ ...first, decided: true }]);
    if (verdict.refused) throw new PromptRefusedError(decided, "the request's prompt text");
    return decided;
  }
  // Compiler-written text is never the reason a person's request is refused: a second call, on the
  // person's parts and the bible's rules alone with the same question and cut, decides.
  const personHits = record.hits?.filter((h) => !modelWritten({ label: h.part })) ?? [];
  const second = person.some((p) => p.text.trim())
    ? await decidePromptPolicy(caller, person, personHits, readings, cut)
    : undefined;
  if (second?.refused)
    throw new PromptRefusedError(
      checked(second, [first, { ...answer("person", second), decided: true }]),
      "the request's prompt text",
    );
  const fallback = `the prompt-policy model check objected only to text the prompt compiler wrote (${verdict.probability.toFixed(2)} with it, ${second ? `${second.probability.toFixed(2)} on the person's text alone` : "no person-written text"}): the repository template's prompt is used in its place`;
  if (second)
    return checked(second, [first, { ...answer("person", second), decided: true }], fallback);
  // No person wrote any of the text, so no one is asked to clear it.
  const unasked = checked(verdict, [{ ...first, decided: true }], fallback);
  delete unasked.borderline;
  return unasked;
}

function answer(scope: PromptPolicyCheck["scope"], v: PromptModelVerdict): PromptPolicyCheck {
  return { scope, model: v.model, probability: v.probability, refused: v.refused };
}
