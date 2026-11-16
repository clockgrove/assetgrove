/**
 * Which motion template describes an animation family (#364). A template declared for the family
 * (the asset spec's `template`, or a grouping family's) wins and needs no call; so does a template
 * named exactly like the family. Any other family is asked once per run: one `motion-template`
 * choice decision, given the family name, the subject and each template's name and description,
 * chooses a template or `none`. On `none`, or with no caller to ask, the checks that need a
 * template's contact, footprint and loop rules say "not applicable" (src/animation/qa.ts).
 */
import type { Caller } from "../calls.ts";
import { InputError } from "../errors.ts";
import type { PlannedCall } from "../generators/generator.ts";
import { MOTION_TEMPLATE_OPERATION } from "../routes.ts";
import type { Routes } from "../routes.ts";
import { NO_TEMPLATE, templateFor } from "./templates.ts";
import type { MotionTemplate } from "./types.ts";

/**
 * How a family's template was known: `declared` by its spec or grouping, `named` (the family is a
 * template's name), `judged` by a motion-template decision, or `undecided` (no declaration, no
 * template of that name and no call made).
 */
export type TemplateSource = "declared" | "named" | "judged" | "undecided";

export interface TemplateChoice {
  /** The template the strip is judged by; undefined when none applies or none was decided. */
  template?: MotionTemplate;
  source: TemplateSource;
  /** The judged answer's probability, when the model reports one. */
  probability?: number;
}

/**
 * The template a family has without a call: the declared one (`none` declares that none applies),
 * else the one named exactly like the family. Undefined when only a decision can say. Throws for a
 * declared template that is not one of the templates.
 */
export function knownTemplate(
  family: string,
  templates: readonly MotionTemplate[],
  declared?: string,
): TemplateChoice | undefined {
  if (declared !== undefined) {
    if (declared === NO_TEMPLATE) return { source: "declared" };
    const template = templateFor(declared, templates);
    if (!template) {
      throw new InputError(
        `family ${family} declares motion template ${JSON.stringify(declared)}, which is not one of ` +
          `${[...templates.map((t) => t.name), NO_TEMPLATE].join(", ")}`,
      );
    }
    return { template, source: "declared" };
  }
  const named = templateFor(family, templates);
  return named ? { template: named, source: "named" } : undefined;
}

/** The choice of a family nothing declared and no call decided. */
export const UNDECIDED: TemplateChoice = { source: "undecided" };

/** The template without a call, or undecided. */
export function templateWithoutCall(
  family: string,
  templates: readonly MotionTemplate[],
  declared?: string,
): TemplateChoice {
  return knownTemplate(family, templates, declared) ?? UNDECIDED;
}

/** What a template describes, for the decision: its own description, else its rules in words. */
export function describeTemplate(t: MotionTemplate): string {
  if (t.description) return t.description;
  const contact =
    t.contact === "all"
      ? "every frame on the ground"
      : t.contact === "beats"
        ? "on the ground at its contact beats only"
        : "not on the ground";
  return `${t.loop ? "a looping cycle" : "a one-shot motion"}, ${contact}; beats ${t.beats.map((b) => b.name).join(", ")}`;
}

function templatePrompt(family: string, subject: string): string {
  return [
    `An animation family of a 2D sprite is named "${family}"; its subject is "${subject}".`,
    "Each option is a motion template the family's frames would be checked against: whether it loops, which frames keep the feet on the ground and how the footprint moves.",
    "Which template describes the motion this family names? Judge the motion, not the spelling: a family whose name starts like a template's may be a different motion. Answer none when no template describes it.",
  ].join("\n");
}

/** One family's decision request: who is asked, about what. */
export interface TemplateRequest {
  family: string;
  subject: string;
  /** The template the spec or grouping declares for this family, if any. */
  declared?: string;
}

/**
 * The motion-template calls a run forecasts: one per family and subject that declares no template
 * and has no template of its name.
 */
export function planTemplateDecisions(
  requests: readonly TemplateRequest[],
  templates: readonly MotionTemplate[],
  routes: Routes,
): PlannedCall[] {
  const asked = new Set(
    requests
      .filter((r) => knownTemplate(r.family, templates, r.declared) === undefined)
      .map((r) => JSON.stringify([r.family, r.subject])),
  );
  if (asked.size === 0) return [];
  const route = Object.hasOwn(routes, MOTION_TEMPLATE_OPERATION)
    ? routes[MOTION_TEMPLATE_OPERATION]
    : undefined;
  if (!route) throw new InputError(`no model route for operation "${MOTION_TEMPLATE_OPERATION}"`);
  return [...asked].map(() => ({
    operation: MOTION_TEMPLATE_OPERATION,
    model: route.model,
    estimatedCostUsd: route.estimatedCostUsd,
  }));
}

/**
 * Chooses each family's template for one run: the declared or named one with no call, else one
 * motion-template decision through `call`, made once per family and subject and remembered for
 * the run. With no caller an undeclared family stays undecided.
 */
export class TemplateChooser {
  readonly #templates: readonly MotionTemplate[];
  readonly #call: Caller | undefined;
  readonly #asked = new Map<string, Promise<TemplateChoice>>();

  constructor(templates: readonly MotionTemplate[], call?: Caller) {
    this.#templates = templates;
    this.#call = call;
  }

  async choose(request: TemplateRequest): Promise<TemplateChoice> {
    const known = knownTemplate(request.family, this.#templates, request.declared);
    if (known) return known;
    const call = this.#call;
    if (!call) return UNDECIDED;
    const key = JSON.stringify([request.family, request.subject]);
    let answer = this.#asked.get(key);
    if (!answer) {
      answer = this.#decide(call, request.family, request.subject);
      this.#asked.set(key, answer);
    }
    return answer;
  }

  async #decide(call: Caller, family: string, subject: string): Promise<TemplateChoice> {
    const options: Record<string, string> = {};
    for (const t of this.#templates) options[t.name] = describeTemplate(t);
    options[NO_TEMPLATE] = "no template describes this motion";
    const { result, record } = await call.decide(
      MOTION_TEMPLATE_OPERATION,
      templatePrompt(family, subject),
      [],
      { type: "choice", instructions: "Choose the template that describes the motion.", options },
    );
    const choice = result.answer.type === "choice" ? result.answer.choice : undefined;
    if (choice === undefined || !Object.hasOwn(options, choice)) {
      throw new InputError(
        `the ${MOTION_TEMPLATE_OPERATION} decision for ${family} gave no template`,
      );
    }
    const probability = record.decision?.value;
    const template = choice === NO_TEMPLATE ? undefined : templateFor(choice, this.#templates);
    return {
      ...(template && { template }),
      source: "judged",
      ...(probability !== undefined && { probability }),
    };
  }
}

/** The choice in words, for a report reason. */
export function describeChoice(family: string, choice: TemplateChoice): string {
  const name = choice.template?.name;
  switch (choice.source) {
    case "declared":
      return name
        ? `family ${family} declares the ${name} template`
        : `family ${family} declares that no motion template applies`;
    case "named":
      return `family ${family} is the ${name} template`;
    case "judged": {
      const p = choice.probability !== undefined ? `, p ${choice.probability.toFixed(2)}` : "";
      return name
        ? `the motion-template decision chose ${name} for family ${family}${p}`
        : `the motion-template decision found no template that describes family ${family}${p}`;
    }
    case "undecided":
      return `no motion template is declared for family ${family} and none is named ${family}; no motion-template decision was made in this run`;
  }
}
