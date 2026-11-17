/**
 * The prompt-policy model check's cuts per decisions route: `policy/prompt-policy-cuts.json`,
 * format `assetgrove-prompt-policy-cuts/1`, keyed `<adapter id>:<model>`. A probability under
 * `confirmAt` allows the request, from `confirmAt` up to `refuseAt` a person confirms it (exit 8),
 * and `refuseAt` or more refuses it (exit 9). A route with no entry has no measured rates, and the
 * check is not run on it. The `scripted` adapter, the test stand-in, takes the default gateway
 * route's entry. A developer's own route can record a cut measured on the red-team set in settings
 * `promptPolicy.cuts` (same keys, with the two rates measured), used in place of the file's when
 * its rates meet `PROMPT_POLICY_BAR_RATES`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InputError } from "../errors.ts";
import { defaultRoutes, PROMPT_POLICY_OPERATION } from "../routes.ts";

/** The cut of one route. */
export interface PromptPolicyCut {
  confirmAt: number;
  refuseAt: number;
}

/** The table's path: `policy/prompt-policy-cuts.json` at the package root (src/ and dist/ alike). */
export const PROMPT_POLICY_CUTS_PATH: string = fileURLToPath(
  new URL("../../policy/prompt-policy-cuts.json", import.meta.url),
);

/** The bars a settings cut's measured rates must meet (docs/decisions.md "Prompt-policy bars"). */
export const PROMPT_POLICY_BAR_RATES = { minRefusalRate: 0.9, maxFalseRefusalRate: 0.1 } as const;

/** A cut the developer measured on their own route, with the rates it was measured at. */
export interface MeasuredPromptPolicyCut extends PromptPolicyCut {
  refusalRate: number;
  falseRefusalRate: number;
}

/** Why a settings cut's rates miss the bars, or undefined when they meet them. */
export function barProblem(cut: MeasuredPromptPolicyCut): string | undefined {
  if (cut.refusalRate < PROMPT_POLICY_BAR_RATES.minRefusalRate)
    return `refusalRate ${cut.refusalRate} is under the bar ${PROMPT_POLICY_BAR_RATES.minRefusalRate}`;
  if (cut.falseRefusalRate > PROMPT_POLICY_BAR_RATES.maxFalseRefusalRate)
    return `falseRefusalRate ${cut.falseRefusalRate} is over the bar ${PROMPT_POLICY_BAR_RATES.maxFalseRefusalRate}`;
  return undefined;
}

const FORMAT = "assetgrove-prompt-policy-cuts/1";
const STAND_IN_ADAPTER = "scripted";
const GATEWAY_ADAPTER = "vercel-ai-gateway";

/** Reads and checks a cuts file. */
export function readPromptPolicyCuts(
  path: string = PROMPT_POLICY_CUTS_PATH,
): Map<string, PromptPolicyCut> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new InputError(`cannot read the prompt-policy cuts ${path}`, { cause: error });
  }
  const file = parsed as { format?: unknown; routes?: unknown };
  if (file === null || typeof file !== "object" || file.format !== FORMAT)
    throw new InputError(`${path}: format must be "${FORMAT}"`);
  const routes = file.routes;
  if (routes === null || typeof routes !== "object" || Array.isArray(routes))
    throw new InputError(`${path}: routes must be an object keyed <adapter>:<model>`);
  const cuts = new Map<string, PromptPolicyCut>();
  for (const [key, value] of Object.entries(routes)) {
    const { confirmAt, refuseAt, refusalRate, falseRefusalRate } = (value ??
      {}) as Partial<MeasuredPromptPolicyCut>;
    if (
      typeof confirmAt !== "number" ||
      typeof refuseAt !== "number" ||
      !(confirmAt >= 0 && confirmAt <= refuseAt && refuseAt <= 1)
    )
      throw new InputError(`${path}: ${key} needs 0 <= confirmAt <= refuseAt <= 1`);
    // The measured rates, once a real run has recorded them, are held to the bars as a settings
    // entry's are. Both or neither: one rate alone is not a measurement.
    if (refusalRate !== undefined || falseRefusalRate !== undefined) {
      if (
        typeof refusalRate !== "number" ||
        typeof falseRefusalRate !== "number" ||
        !(refusalRate >= 0 && refusalRate <= 1 && falseRefusalRate >= 0 && falseRefusalRate <= 1)
      )
        throw new InputError(`${path}: ${key} needs both refusalRate and falseRefusalRate, 0..1`);
      const problem = barProblem({ confirmAt, refuseAt, refusalRate, falseRefusalRate });
      if (problem !== undefined) throw new InputError(`${path}: ${key}: ${problem}`);
    }
    cuts.set(key, { confirmAt, refuseAt });
  }
  return cuts;
}

let cached: Map<string, PromptPolicyCut> | undefined;

/**
 * The cut measured for the decisions route on `adapter` with `model`: the developer's own
 * (`own`, settings `promptPolicy.cuts`) first, then the package file's; undefined when none is.
 */
export function promptPolicyCut(
  adapter: string,
  model: string,
  own: Readonly<Record<string, PromptPolicyCut>> = {},
): PromptPolicyCut | undefined {
  const mine = own[`${adapter}:${model}`];
  if (mine !== undefined) return { confirmAt: mine.confirmAt, refuseAt: mine.refuseAt };
  cached ??= readPromptPolicyCuts();
  const key =
    adapter === STAND_IN_ADAPTER
      ? `${GATEWAY_ADAPTER}:${defaultRoutes[PROMPT_POLICY_OPERATION]!.model}`
      : `${adapter}:${model}`;
  return cached.get(key);
}
