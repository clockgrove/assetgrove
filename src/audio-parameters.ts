/**
 * The typed parameters of an audio call (docs/PRD-audio.md, core change 4): a closed set. A kind
 * passes `durationS`, `seed` and `promptInfluence`, and nothing else reaches a provider: any other
 * key is refused by name before anything is looked up, reserved or sent.
 */
import { InputError } from "./errors.ts";

/** Every audio call parameter, in the order core names them. */
export const AUDIO_PARAMETERS = ["durationS", "seed", "promptInfluence"] as const;

export type AudioParameterName = (typeof AUDIO_PARAMETERS)[number];

/** What a kind passes on one audio call. */
export interface AudioParameters {
  /** The requested duration in seconds, above 0. */
  durationS?: number;
  /** A whole number at or above 0; sent only on a route that has a seed. */
  seed?: number;
  /** How closely the output follows the prompt, 0 to 1. */
  promptInfluence?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The parameters `parameters` passes, each checked. Throws `InputError` (exit 2 `invalid_input`)
 * naming the key for one outside the closed set or of the wrong type.
 */
export function checkAudioParameters(parameters: unknown, operation: string): AudioParameters {
  if (parameters === undefined) return {};
  const what = `the ${operation} audio call's parameters`;
  if (!isRecord(parameters)) throw new InputError(`${what} must be an object`);
  const checked: AudioParameters = {};
  for (const [name, value] of Object.entries(parameters)) {
    if (!(AUDIO_PARAMETERS as readonly string[]).includes(name))
      throw new InputError(
        `${what} name "${name}", which is not an audio parameter (an audio call takes only ${AUDIO_PARAMETERS.join(", ")})`,
      );
    if (value === undefined) continue;
    if (name === "durationS") {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        throw new InputError(`${what}: durationS must be a number of seconds above 0`);
      checked.durationS = value;
    } else if (name === "seed") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw new InputError(`${what}: seed must be a whole number at or above 0`);
      checked.seed = value;
    } else {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
        throw new InputError(`${what}: promptInfluence must be a number from 0 to 1`);
      checked.promptInfluence = value;
    }
  }
  return checked;
}
