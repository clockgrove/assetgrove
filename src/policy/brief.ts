/**
 * The brief policy's model check (#324): whether free text asks to change or ignore a protected
 * field of the style bible (its palette, a character's identity text, the audience, the
 * proportions) or to show something a content limit forbids. It is read by a model, never matched
 * by word patterns: one Boolean decide call on the `brief-policy` operation (the decisions role)
 * per protected field, so a refusal names the field. `createPlan` runs it, inside the confirmed
 * spend, on the brief's free text before the compiler call and on the compiler's own text after
 * it; the free plan step only forecasts the calls.
 */
import type { Caller } from "../calls.ts";
import type { ArtBible } from "../bible.ts";
import { classify } from "../commands/result.ts";
import { ProviderError } from "../errors.ts";
import type { DecisionQuestion } from "../gateway/provider.ts";
import { BRIEF_POLICY_OPERATION } from "../routes.ts";

export { BRIEF_POLICY_OPERATION };

/**
 * The probability at or above which the check says the text departs from the bible: the same
 * cut as the prompt policy's model check (docs/decisions.md, "Brief policy threshold").
 */
export const BRIEF_POLICY_THRESHOLD = 0.5;

/** The protected fields the check asks about, in the order it asks. */
export const BRIEF_POLICY_FIELDS = [
  "palette",
  "identity",
  "audience",
  "proportions",
  "contentLimits",
] as const;
export type BriefPolicyField = (typeof BRIEF_POLICY_FIELDS)[number];

/** Whose text is checked: the author's brief, or the prompt compiler's output. */
export type BriefPolicyTarget = "brief" | "compiler";

/** The bible's protected values, as the model is given them. */
export interface ProtectedFields {
  palette: string[];
  audience: string;
  proportions: string;
  /** The subject's identity lock, when it has one. */
  identity?: { subject: string; signatureFeatures: string[]; proportions: string };
  contentLimits: string[];
}

/** The protected fields of a bible for a subject (its identity lock, if any). */
export function protectedFields(
  bible: ArtBible,
  palette: readonly string[],
  subject: string,
): ProtectedFields {
  const lock = Object.hasOwn(bible.identities, subject) ? bible.identities[subject] : undefined;
  return {
    palette: [...palette],
    audience: bible.tone.audience,
    proportions: bible.axes.proportions,
    ...(lock && {
      identity: {
        subject,
        signatureFeatures: [...lock.signatureFeatures],
        proportions: lock.proportions,
      },
    }),
    contentLimits: [...bible.tone.contentLimits],
  };
}

/** The fields there is something to ask about: identity only with a lock, limits only when listed. */
export function briefPolicyFields(fields: ProtectedFields): BriefPolicyField[] {
  return BRIEF_POLICY_FIELDS.filter(
    (field) =>
      (field !== "identity" || fields.identity !== undefined) &&
      (field !== "contentLimits" || fields.contentLimits.length > 0),
  );
}

const ASKS: Record<BriefPolicyField, string> = {
  palette:
    "Does the text ask to change, replace, extend or ignore the bible's palette, for example by asking for colours outside it or by naming other colours to paint the asset in?",
  identity:
    "Does the text ask to change or ignore the character's locked identity: its signature features or its locked proportions?",
  audience:
    "Does the text ask to change or ignore the bible's audience, for example by asking for content meant for an older audience than the bible's?",
  proportions: "Does the text ask to change or ignore the bible's proportions?",
  contentLimits: "Does the text ask to show something one of the bible's content limits forbids?",
};

/** The Boolean question the model answers about one protected field. */
export function briefPolicyQuestion(field: BriefPolicyField): DecisionQuestion {
  return {
    type: "boolean",
    instructions: `${ASKS[field]} Judge what the text asks for, not which words it uses: a word that merely sits near the field's name is not a request.`,
    whenTrue: "the text asks the asset to depart from this protected field of the style bible",
    whenFalse:
      "the text describes the asset, its use or its surroundings without asking to depart from this protected field, even when it uses words such as change, use or set, or names the field",
  };
}

const FIELD_LINE = "Protected field in question: ";
const TARGET_LINE = "Text checked: ";
const TARGET_LABEL: Record<BriefPolicyTarget, string> = {
  brief: "the author's brief (its free-text fields)",
  compiler: "the prompt compiler's own prompt text",
};

/** The labelled parts of a text the check reads: `[label, text]`. */
export type LabelledText = Array<[string, string]>;

/** The text the model is given: the protected fields, the field in question and the labelled text. */
export function briefPolicyPrompt(
  fields: ProtectedFields,
  field: BriefPolicyField,
  target: BriefPolicyTarget,
  text: LabelledText,
): string {
  return [
    "Style bible, protected fields (immutable):",
    JSON.stringify(fields),
    `${FIELD_LINE}${field}`,
    `${TARGET_LINE}${target} (${TARGET_LABEL[target]}), each part verbatim between the markers:`,
    ...text.map(([label, value]) => `${label}:\n<<<\n${value}\n>>>`),
  ].join("\n");
}

/** The field and target a brief-policy prompt asks about; for scripted providers and tests. */
export function briefPolicyAsked(
  prompt: string,
): { field: BriefPolicyField; target: BriefPolicyTarget } | undefined {
  const field = new RegExp(`^${FIELD_LINE}(\\w+)$`, "m").exec(prompt)?.[1];
  const target = new RegExp(`^${TARGET_LINE}(\\w+) `, "m").exec(prompt)?.[1];
  if (
    !(BRIEF_POLICY_FIELDS as readonly string[]).includes(field ?? "") ||
    (target !== "brief" && target !== "compiler")
  )
    return undefined;
  return { field: field as BriefPolicyField, target };
}

/** One field's verdict on one text. */
export interface BriefPolicyVerdict {
  target: BriefPolicyTarget;
  field: BriefPolicyField;
  probability: number;
  /** `<provider>:brief-policy:<model>`. */
  model: string;
  /** The probability is at or above `BRIEF_POLICY_THRESHOLD`. */
  objects: boolean;
}

/**
 * One Boolean decide call per field about `text`. A call that fails or answers out of type throws
 * `ProviderError` (exit 4: the check fails closed); a refused route or budget keeps its own error.
 */
export async function decideBriefPolicy(
  caller: Caller,
  fields: ProtectedFields,
  target: BriefPolicyTarget,
  text: LabelledText,
): Promise<BriefPolicyVerdict[]> {
  const verdicts: BriefPolicyVerdict[] = [];
  for (const field of briefPolicyFields(fields)) {
    let result;
    try {
      result = await caller.decide(
        BRIEF_POLICY_OPERATION,
        briefPolicyPrompt(fields, field, target, text),
        [],
        briefPolicyQuestion(field),
      );
    } catch (error) {
      if (classify(error).code !== "internal_error") throw error;
      throw new ProviderError(
        `the brief-policy check could not run: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const { answer } = result.result;
    if (answer.type !== "boolean" || !Number.isFinite(answer.probability))
      throw new ProviderError("the brief-policy check did not answer with a probability");
    const probability = Math.min(1, Math.max(0, answer.probability));
    verdicts.push({
      target,
      field,
      probability,
      model: result.record.route,
      objects: probability >= BRIEF_POLICY_THRESHOLD,
    });
  }
  return verdicts;
}
