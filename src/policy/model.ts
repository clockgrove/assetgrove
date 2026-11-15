/**
 * The prompt policy's model check (design section 16). After confirmation, a run's first job is
 * one Boolean decide call on the `prompt-policy` operation (the decisions role) about the prompt
 * text the plan step collected. A probability of 0.5 or more refuses the request with exit 9
 * `prompt_refused`. The check fails closed: a call that fails or answers out of type exits 4
 * `provider_error`, and an operation no configured provider serves exits 2 `route_unavailable`,
 * at the plan step, before anything is spent.
 */
import type { Caller } from "../calls.ts";
import { classify } from "../commands/result.ts";
import { ProviderError } from "../errors.ts";
import type { DecisionQuestion } from "../gateway/provider.ts";
import { PROMPT_POLICY_OPERATION } from "../routes.ts";
import type { Route } from "../routes.ts";
import { PromptRefusedError } from "./text.ts";
import type { PromptPolicyRecord } from "./text.ts";

export { PROMPT_POLICY_OPERATION };

/** The probability at or above which the model check refuses a request. */
export const PROMPT_POLICY_THRESHOLD = 0.5;

/** The Boolean question the model answers about a request's prompt text. */
export const PROMPT_POLICY_QUESTION: DecisionQuestion = {
  type: "boolean",
  instructions:
    "Does this game-asset generation request ask to copy or imitate a specific living artist's style, a studio's or a named game's look, a copyrighted character, or a real person's likeness, by name or by an unmistakable description?",
  whenTrue:
    "it names or unmistakably describes a specific artist, studio, game, copyrighted character or real person whose work or likeness the output would copy",
  whenFalse:
    "it describes an original asset in plain visual words (genre, palette, medium, shapes), even when the words resemble a well-known work",
};

/** The text the model is given: the request's prompt text, set apart from the question. */
export function promptPolicyPrompt(text: string): string {
  return `Game-asset generation request (prompt text, verbatim between the markers):\n<<<\n${text}\n>>>`;
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
  text: string,
): Promise<PromptModelVerdict> {
  let result;
  try {
    result = await caller.decide(
      PROMPT_POLICY_OPERATION,
      promptPolicyPrompt(text),
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
 * The run's prompt-policy job: decides on `text` and returns the plan step's record with the
 * model and probability added; throws `PromptRefusedError` (exit 9) at 0.5 or more.
 */
export async function checkPromptModel(
  caller: Caller,
  text: string,
  record: PromptPolicyRecord,
): Promise<PromptPolicyRecord> {
  const verdict = await decidePromptPolicy(caller, text);
  const checked: PromptPolicyRecord = {
    ...record,
    verdict: verdict.refused ? "refused" : "allowed",
    model: verdict.model,
    probability: verdict.probability,
  };
  if (verdict.refused) throw new PromptRefusedError(checked, "the request's prompt text");
  return checked;
}
