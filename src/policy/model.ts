/**
 * The prompt policy's model check (design section 16). After confirmation, a run's first job is
 * one Boolean decide call on the `prompt-policy` operation (the decisions role) about the prompt
 * text the plan step collected, given as labelled parts with the blocklist's phrase and
 * ambiguous-name hits and the words around them. A probability of 0.5 or more refuses the request
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
import { asParts, modelWritten, PromptRefusedError } from "./text.ts";
import type { PolicyHit, PromptPart, PromptPartLabel, PromptPolicyRecord } from "./text.ts";

export { PROMPT_POLICY_OPERATION };

/** The probability at or above which the model check refuses a request. */
export const PROMPT_POLICY_THRESHOLD = 0.5;

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
): string {
  if (typeof text === "string")
    return `Game-asset generation request (prompt text, verbatim between the markers):\n<<<\n${text}\n>>>`;
  const sections = text
    .filter((p) => p.text.trim().length > 0)
    .map((p) => `[${p.label}] ${PART_TITLES[p.label]}:\n<<<\n${p.text}\n>>>`);
  const flagged = hits.map(
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
  ].join("\n");
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
): Promise<PromptModelVerdict> {
  let result;
  try {
    result = await caller.decide(
      PROMPT_POLICY_OPERATION,
      promptPolicyPrompt(text, hits),
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
  return {
    probability,
    model: result.record.route,
    refused: probability >= PROMPT_POLICY_THRESHOLD,
  };
}

/**
 * The run's prompt-policy job: decides on the labelled `parts` with the record's hits and returns
 * the plan step's record with the model and probability added; throws `PromptRefusedError` (exit
 * 9) at 0.5 or more. When the parts hold model-written text and the check refuses, a second call
 * on the person-written parts alone decides: if it allows, the record is allowed with `fallback`
 * saying why, and the command uses the template's prompt in place of the compiler's.
 */
export async function checkPromptModel(
  caller: Caller,
  parts: string | readonly PromptPart[],
  record: PromptPolicyRecord,
): Promise<PromptPolicyRecord> {
  const all = asParts(parts);
  const verdict = await decidePromptPolicy(caller, all, record.hits);
  const checked: PromptPolicyRecord = {
    ...record,
    verdict: verdict.refused ? "refused" : "allowed",
    model: verdict.model,
    probability: verdict.probability,
  };
  if (!verdict.refused) return checked;
  const person = all.filter((p) => !modelWritten(p));
  if (person.length === all.length)
    throw new PromptRefusedError(checked, "the request's prompt text");
  // Compiler-written text is never the reason a person's request is refused: ask about theirs.
  const personHits = record.hits?.filter((h) => !modelWritten({ label: h.part })) ?? [];
  const second = person.some((p) => p.text.trim())
    ? await decidePromptPolicy(caller, person, personHits)
    : undefined;
  if (second?.refused)
    throw new PromptRefusedError(
      { ...checked, probability: second.probability },
      "the request's prompt text",
    );
  return {
    ...checked,
    verdict: "allowed",
    ...(second && { probability: second.probability }),
    fallback: `the prompt-policy model check objected only to text the prompt compiler wrote (${verdict.probability.toFixed(2)} with it, ${second ? `${second.probability.toFixed(2)} on the person's text alone` : "no person-written text"}): the repository template's prompt is used in its place`,
  };
}
