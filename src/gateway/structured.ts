/**
 * What the direct adapters (anthropic, openai, openai-compatible) share: the request ID of a
 * response, the user message of a vision call, and a typed decision asked of a chat model through
 * the AI SDK's structured output (`decisionSource: "structured-output"`).
 */
import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { ProviderError } from "../errors.ts";
import type { DecisionAnswer, DecisionRequest, DecisionResult, ImageInput } from "./provider.ts";

/** The provider's request ID when it reported one, else a generated `local-…` ID marked local. */
export function requestId(...candidates: unknown[]): {
  requestId: string;
  requestIdSource: "provider" | "local";
} {
  for (const c of candidates) {
    if (typeof c === "string" && c !== "") return { requestId: c, requestIdSource: "provider" };
  }
  return {
    requestId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    requestIdSource: "local",
  };
}

/** One user message: the prompt, then the images in order. */
export function userMessage(prompt: string, images: readonly ImageInput[]) {
  return [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: prompt },
        ...images.map((i) => ({ type: "image" as const, image: i.bytes, mediaType: i.mediaType })),
      ],
    },
  ];
}

/**
 * A typed decision through structured output: the model answers a score (one of the question's
 * levels, by index) or a probability that the statement holds. `guard` maps a failed call to the
 * adapter's error. The answer records `decisionSource: "structured-output"`.
 */
export async function structuredDecision(
  provider: string,
  model: LanguageModel,
  req: DecisionRequest,
  guard: <T>(label: string, call: () => Promise<T>) => Promise<T>,
): Promise<DecisionResult> {
  const q = req.question;
  const top = q.type === "score" ? Math.max(1, q.levels.length - 1) : 1;
  const schema =
    q.type === "score"
      ? z.object({ score: z.number().min(0).max(top) })
      : z.object({ probability: z.number().min(0).max(1) });
  const instructions =
    q.type === "score"
      ? `${q.instructions}\nAnswer with score, the index (0 to ${top}) of the level that fits: ${q.levels.map((l, i) => `${i}: ${l}`).join("; ")}.`
      : `${q.instructions}\nAnswer with probability, from 0 to 1, that this holds.` +
        `${q.whenTrue !== undefined ? ` True means: ${q.whenTrue}.` : ""}` +
        `${q.whenFalse !== undefined ? ` False means: ${q.whenFalse}.` : ""}`;
  const result = await guard("decide", () =>
    generateText({
      model,
      messages: userMessage(`${req.prompt}\n\n${instructions}`, req.images),
      output: Output.object({ schema }),
    }),
  );
  const raw = result.output as { score?: number; probability?: number } | undefined;
  let answer: DecisionAnswer;
  if (q.type === "score" && typeof raw?.score === "number")
    answer = { type: "score", score: raw.score };
  else if (q.type === "boolean" && typeof raw?.probability === "number")
    answer = { type: "boolean", probability: raw.probability };
  else throw new ProviderError(`${provider} decide: the answer did not match the question`);
  return { answer, decisionSource: "structured-output", ...requestId(result.response.id) };
}
