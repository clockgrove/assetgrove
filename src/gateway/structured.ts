/**
 * What the direct adapters (anthropic, openai, openai-compatible) share: the chat message of a
 * vision or decision call, the request ID of a result, and a typed decision through the AI SDK's
 * structured output (`Output.object`), recorded with `decisionSource: "structured-output"`.
 */
import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { ProviderError } from "../errors.ts";
import type { DecisionAnswer, DecisionRequest, DecisionResult, VisionRequest } from "./provider.ts";

/** The provider's request ID when it reports one, else a local one marked as such. */
export function requestIdOf(...candidates: unknown[]): {
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
export function userMessage(prompt: string, images: VisionRequest["images"]) {
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
 * A typed decision through structured output: the model answers a score (the index of one of the
 * question's levels), a probability that the statement holds, or the option that fits with its
 * probability. `guard` maps a thrown SDK error to
 * the adapter's own; `headerId` names the response header that carries the provider's request ID.
 */
export async function decideStructured(
  provider: string,
  model: LanguageModel,
  req: DecisionRequest,
  guard: <T>(label: string, call: () => Promise<T>) => Promise<T>,
  headerId?: string,
): Promise<DecisionResult> {
  const q = req.question;
  const top = q.type === "score" ? Math.max(1, q.levels.length - 1) : 1;
  const names = q.type === "choice" ? Object.keys(q.options) : [];
  const schema =
    q.type === "score"
      ? z.object({ score: z.number().min(0).max(top) })
      : q.type === "choice"
        ? z.object({
            choice: z.enum(names as [string, ...string[]]),
            probability: z.number().min(0).max(1),
          })
        : z.object({ probability: z.number().min(0).max(1) });
  const instructions =
    q.type === "score"
      ? `${q.instructions}\nAnswer with score, the index (0 to ${top}) of the level that fits: ${q.levels.map((l, i) => `${i}: ${l}`).join("; ")}.`
      : q.type === "choice"
        ? `${q.instructions}\nAnswer with choice, the one option that fits, and probability, from 0 to 1, that it is right. Options: ${Object.entries(q.options).map(([name, meaning]) => `${name}: ${meaning}`).join("; ")}.`
        : `${q.instructions}\nAnswer with probability, from 0 to 1, that this holds.` +
          `${q.whenTrue !== undefined ? ` True means: ${q.whenTrue}.` : ""}` +
          `${q.whenFalse !== undefined ? ` False means: ${q.whenFalse}.` : ""}`;
  const result = await guard("decide", () =>
    generateText({
      model,
      // One request per reservation: an SDK retry would resend a paid call.
      maxRetries: 0,
      messages: userMessage(`${req.prompt}\n\n${instructions}`, req.images),
      output: Output.object({ schema }),
    }),
  );
  const raw = result.output as
    | { score?: number; probability?: number; choice?: string }
    | undefined;
  let answer: DecisionAnswer;
  if (q.type === "score" && typeof raw?.score === "number")
    answer = { type: "score", score: raw.score };
  else if (
    q.type === "choice" &&
    typeof raw?.choice === "string" &&
    names.includes(raw.choice) &&
    typeof raw.probability === "number"
  )
    answer = { type: "choice", choice: raw.choice, probabilities: { [raw.choice]: raw.probability } };
  else if (q.type === "boolean" && typeof raw?.probability === "number")
    answer = { type: "boolean", probability: raw.probability };
  else throw new ProviderError(`${provider} decide: the answer did not match the question`);
  return {
    answer,
    decisionSource: "structured-output",
    ...requestIdOf(
      headerId !== undefined ? result.response.headers?.[headerId] : undefined,
      result.response.id,
    ),
  };
}
