/**
 * Model routes (design section 12): which provider and model serve each operation. Routes come
 * only from the developer settings: `settings.routes[op]` over `settings.roles[role]` over the
 * configured adapters' `defaultRoutes`. Grants and terms belong to the (provider, model) pair.
 */
import { SettingsError } from "./env.ts";
import type { Settings } from "./settings.ts";
import type { OutputGrant } from "./types.ts";

export const IDENTITY_CAST_OPERATION = "identity-cast";
export const LOOKDEV_OPERATION = "lookdev";
export const LOOKDEV_LOCATE_OPERATION = "lookdev-locate";
export const LOOKDEV_GROOM_OPERATION = "lookdev-groom";
export const LOOKDEV_MARKINGS_OPERATION = "lookdev-markings";
export const IDENTITY_CHECK_OPERATION = "identity-check";
/**
 * Hosted search embeddings (design section 7.7): one operation for images and texts alike, so both
 * always land in one model's space. No adapter routes it by default: the `embeddings` role does.
 */
export const EMBED_OPERATION = "embed";
/** The prompt policy's model check: one Boolean decision on a request's prompt text. */
export const PROMPT_POLICY_OPERATION = "prompt-policy";
/** The brief policy's model check: Boolean decisions on whether text departs from the style bible. */
export const BRIEF_POLICY_OPERATION = "brief-policy";
/** Which view a 3D request's reference image shows: one typed choice decision per image. */
export const REFERENCE_VIEW_OPERATION = "reference-view";
/** Which way a generated 3D model faces (#365): one typed choice decision per candidate. */
export const MODEL3D_FACING_OPERATION = "model3d-facing";
/** Whether a look-dev identity marking is kept (#365): one typed choice decision per marking and render. */
export const LOOKDEV_MARKING_OPERATION = "lookdev-marking";

/** A model route: which provider and model serve an operation, its per-call estimate and its terms. */
export interface Route {
  /** The settings id of the provider that serves it; set on every resolved route. */
  provider?: string;
  model: string;
  /** Upper estimate of one call's cost in USD; reserved against the cap before the call. */
  estimatedCostUsd: number;
  /**
   * The provider terms the output was made under, recorded in provenance. Absent on a route whose
   * provider or model was overridden without its own terms.
   */
  providerTerms?: string;
  /**
   * What the provider grants for this route's outputs on the plan it is called on, recorded on
   * every call. A call without one is refused at hand-off (exit 7 `license_refused`).
   */
  outputGrant?: OutputGrant;
  size?: string;
  /** Whether the model accepts a seed; only then is one sent and recorded. */
  supportsSeed?: boolean;
  providerOptions?: Record<string, Record<string, unknown>>;
  /**
   * 3D routes: the axis the provider's models face (`+z` when unset). Assetgrove turns each model
   * to the target profile's `model3d.forward`.
   */
  forward?: "+x" | "-x" | "+z" | "-z";
  /**
   * 3D clip routes: the provider's animation library, by gait then family: the library clip that
   * is retargeted for the family and whether the family loops. A family not listed has no close
   * library clip and is reported as missing.
   */
  library?: Record<string, Record<string, { clip: string; loop: boolean }>>;
  /** 3D rig routes: the provider's rig type for each gait (the gait itself when unlisted). */
  rigTypes?: Record<string, string>;
}

export interface Routes {
  /** Text-and-reference stills and key poses. */
  still: Route;
  /** Reference-guided edits: each animation frame is an edit of the key pose. */
  edit: Route;
  /** Vision QA, and the grouping proposal of an imported sheet. */
  vision: Route;
  /** A whole animation cycle as one contact sheet. */
  sheet: Route;
  /** Identity scoring: a typed decision model compares a candidate with an identity record. */
  identity: Route;
  /** Identity-flicker judgement between consecutive animation frames. */
  flicker: Route;
  /** Whether a see-through area inside an animation frame's outline is a hole or an opening. */
  holes: Route;
  /** Image-to-3D: a textured character model from the approved turnaround. */
  model3d: Route;
  /** The provider's auto-rig for the spec's gait. */
  rig3d: Route;
  /** Library clips retargeted onto the rig, one per requested family, in one call. */
  clips3d: Route;
  [operation: string]: Route;
}

/**
 * Tripo on paid credits: the account owns its outputs, so they ship under the target's licence
 * (owner decision on #72). Credits are about $0.01 each.
 */
const tripoGrant = {
  license: "LicenseRef-tripo-paid",
  plan: "paid",
  commercial: true,
  relabel: true,
};
const tripoTerms = "Tripo API Terms of Service, paid credits (as of 2026-11-10)";

const googleGrant: OutputGrant = {
  license: "LicenseRef-google-api",
  plan: "api",
  commercial: true,
  relabel: true,
};
const googleTerms =
  "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-07)";

/**
 * The core default routes, each with the grant its terms give: the gateway survey of 2026-11-07
 * (docs/models.md) for the 2D operations, Tripo for the 3D ones. Each adapter's `defaultRoutes`
 * is its part of this table; the scripted adapter, the test stand-in, serves all of it.
 */
export const defaultRoutes: Routes = {
  still: {
    model: "openai/gpt-image-2",
    estimatedCostUsd: 0.25,
    size: "1024x1024",
    outputGrant: {
      license: "LicenseRef-openai-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "OpenAI Services Agreement and Usage Policies, via Vercel AI Gateway (as of 2026-11-07)",
  },
  edit: {
    model: "bfl/flux-kontext-pro",
    estimatedCostUsd: 0.05,
    supportsSeed: true,
    outputGrant: {
      license: "LicenseRef-bfl-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "Black Forest Labs API Terms of Service, via Vercel AI Gateway (as of 2026-11-07)",
  },
  sheet: {
    model: "openai/gpt-image-2",
    estimatedCostUsd: 0.3,
    size: "1536x1024",
    outputGrant: {
      license: "LicenseRef-openai-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "OpenAI Services Agreement and Usage Policies, via Vercel AI Gateway (as of 2026-11-07)",
  },
  vision: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    outputGrant: {
      license: "LicenseRef-google-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-07)",
  },
  identity: {
    // #27's image eval: best on identity with reference images; `openai/gpt-6-luna-decisions`
    // is the alternate. About $0.00003 per answer; the estimate is a deliberate upper bound.
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-08)",
  },
  // The prompt policy's model check (#185): one Boolean decision on a request's prompt text,
  // text only, on the same typed decision model and upper bound as identity.
  [PROMPT_POLICY_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-15)",
  },
  // The brief policy's model check (#324): one Boolean decision per protected bible field on
  // whether a brief's or the compiler's text departs from the bible; same model and bound.
  [BRIEF_POLICY_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-15)",
  },
  // Which view a 3D request's reference shows (#325): one typed choice decision per image, on the
  // same typed decision model and upper bound as identity.
  [REFERENCE_VIEW_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-15)",
  },
  // Which way a generated 3D model faces (#365): one typed choice decision per candidate on four
  // free renders of the raw mesh, on the same typed decision model and upper bound.
  [MODEL3D_FACING_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-15)",
  },
  // Whether each look-dev identity marking is kept, drifted or missing (#365): one typed choice
  // decision per marking, view and season render, on the same typed decision model and bound.
  [LOOKDEV_MARKING_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-15)",
  },
  // Identity as a choice among the whole cast's references (#92): one vision call per candidate.
  [IDENTITY_CAST_OPERATION]: {
    model: "openai/gpt-6.1-terra",
    estimatedCostUsd: 0.02,
    outputGrant: {
      license: "LicenseRef-openai-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "OpenAI Services Agreement and Usage Policies, via Vercel AI Gateway (as of 2026-11-11)",
  },
  // Whether an identity record's written signature agrees with its own approved references (#92).
  [IDENTITY_CHECK_OPERATION]: {
    model: "openai/gpt-6.1-terra",
    estimatedCostUsd: 0.02,
    outputGrant: {
      license: "LicenseRef-openai-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "OpenAI Services Agreement and Usage Policies, via Vercel AI Gateway (as of 2026-11-11)",
  },
  // Identity-flicker judgement between consecutive animation frames.
  flicker: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    outputGrant: {
      license: "LicenseRef-google-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-07)",
  },
  // Image-to-3D on Tripo: multiview (or single-image) to a textured PBR model, 30 credits with
  // texture and PBR (#72's probe); the estimate is an upper bound. Its models face +x: measured
  // on a real run (#72), head at +x in the raw multiview output and after the rig.
  model3d: {
    model: "tripo/v2.5-20250123",
    estimatedCostUsd: 0.5,
    forward: "+x",
    outputGrant: tripoGrant,
    providerTerms: tripoTerms,
    providerOptions: {
      tripo: { modelVersion: "v2.5-20250123", texture: true, pbr: true },
    },
  },
  // Tripo's auto-rig, 25 credits (#72's probe). Quadruped rigs need the v2 rigger; v1 refuses them.
  rig3d: {
    model: "tripo/animate-rig-v2.0-20250506",
    estimatedCostUsd: 0.3,
    outputGrant: tripoGrant,
    providerTerms: tripoTerms,
    rigTypes: { quadruped: "quadruped", biped: "biped" },
    providerOptions: {
      tripo: { spec: "tripo", modelVersion: "v2.0-20250506" },
    },
  },
  // Tripo's animation library retargeted onto the rig.
  clips3d: {
    model: "tripo/animate-retarget",
    estimatedCostUsd: 0.2,
    outputGrant: tripoGrant,
    providerTerms: tripoTerms,
    library: {
      biped: {
        idle: { clip: "preset:idle", loop: true },
        walk: { clip: "preset:walk", loop: true },
        run: { clip: "preset:run", loop: true },
        jump: { clip: "preset:jump", loop: false },
        turn: { clip: "preset:turn", loop: false },
        hurt: { clip: "preset:hurt", loop: false },
        fall: { clip: "preset:fall", loop: false },
        climb: { clip: "preset:climb", loop: false },
        dive: { clip: "preset:dive", loop: false },
        slash: { clip: "preset:slash", loop: false },
        shoot: { clip: "preset:shoot", loop: false },
      },
      // Tripo's library has one quadruped clip (probed 2026-11-10: `preset:quadruped:idle`,
      // `:run`, `:trot` and others are refused as invalid animation names).
      quadruped: {
        walk: { clip: "preset:quadruped:walk", loop: true },
      },
    },
  },
  // Look-dev (#82): each flat-lit render of a picked 3D character repainted in the look its
  // approved references and the bible define, then projected back onto the model's own UVs.
  [LOOKDEV_OPERATION]: {
    model: "openai/gpt-image-2",
    estimatedCostUsd: 0.25,
    size: "1024x1024",
    outputGrant: {
      license: "LicenseRef-openai-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "OpenAI Services Agreement and Usage Policies, via Vercel AI Gateway (as of 2026-11-07)",
  },
  // Look-dev (#82): where the eyes and nose are on a close-up render, as pixel points and radii.
  [LOOKDEV_LOCATE_OPERATION]: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    outputGrant: {
      license: "LicenseRef-google-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-07)",
  },
  // Look-dev (#82): one season's groom (lengths, densities, tip tint) read from the target's traits.
  [LOOKDEV_GROOM_OPERATION]: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    outputGrant: {
      license: "LicenseRef-google-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-07)",
  },
  // Look-dev (#122): where each identity marking and the coat beside it are, in a turnaround view
  // and the lit renders of the same view, for the deterministic markings check.
  // Low thinking (assetgrove#122): boxing markings needs no long reasoning, and at the default
  // level the call ran long enough to time out at the gateway relay in two real runs.
  [LOOKDEV_MARKINGS_OPERATION]: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } },
    outputGrant: {
      license: "LicenseRef-google-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-12)",
  },
  // Holes: one enlarged frame with its enclosed see-through areas marked. $0.003 to $0.008 a call
  // (#51's proof); the estimate is an upper bound.
  holes: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.01,
    outputGrant: googleGrant,
    providerTerms:
      "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-09)",
  },
  // Prompt compilation for plan (the planning role) and material QA: the vision model.
  compiler: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    outputGrant: googleGrant,
    providerTerms: googleTerms,
  },
  "material-qa": {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    outputGrant: googleGrant,
    providerTerms: googleTerms,
  },
};

/** The 3D operations, served by Tripo; every other core default is a gateway route. */
const MODEL3D_OPERATIONS = new Set(["model3d", "rig3d", "clips3d"]);

function pick(keep: (operation: string) => boolean): Record<string, Route> {
  return Object.fromEntries(Object.entries(defaultRoutes).filter(([op]) => keep(op)));
}

/** The gateway adapter's default routes: the 2D operations of the core defaults. */
export const GATEWAY_DEFAULT_ROUTES: Readonly<Record<string, Route>> = pick(
  (op) => !MODEL3D_OPERATIONS.has(op),
);
/** The Tripo adapter's default routes: the 3D operations of the core defaults. */
export const TRIPO_DEFAULT_ROUTES: Readonly<Record<string, Route>> = pick((op) =>
  MODEL3D_OPERATIONS.has(op),
);

/** The role each operation maps to (design section 12). */
export const OPERATION_ROLES: Readonly<Record<string, string>> = {
  still: "image",
  sheet: "image",
  edit: "edit",
  [LOOKDEV_OPERATION]: "edit",
  fix: "edit",
  vision: "vision",
  flicker: "vision",
  holes: "vision",
  [LOOKDEV_LOCATE_OPERATION]: "vision",
  [LOOKDEV_GROOM_OPERATION]: "vision",
  [LOOKDEV_MARKINGS_OPERATION]: "vision",
  [IDENTITY_CAST_OPERATION]: "vision",
  [IDENTITY_CHECK_OPERATION]: "vision",
  "material-qa": "vision",
  identity: "decisions",
  [PROMPT_POLICY_OPERATION]: "decisions",
  [BRIEF_POLICY_OPERATION]: "decisions",
  [REFERENCE_VIEW_OPERATION]: "decisions",
  [MODEL3D_FACING_OPERATION]: "decisions",
  [LOOKDEV_MARKING_OPERATION]: "decisions",
  compiler: "planning",
  model3d: "model3d",
  rig3d: "rig3d",
  clips3d: "clips3d",
  [EMBED_OPERATION]: "embeddings",
};

/** The adapter capability each role needs. */
export const ROLE_CAPABILITY: Readonly<Record<string, string>> = {
  image: "image",
  edit: "edit",
  vision: "vision",
  decisions: "decide",
  planning: "vision",
  model3d: "model",
  rig3d: "rig",
  clips3d: "animate",
  embeddings: "embed",
};

/** The role of an operation; undefined for an operation outside the table. */
export function roleOf(operation: string): string | undefined {
  return Object.hasOwn(OPERATION_ROLES, operation) ? OPERATION_ROLES[operation] : undefined;
}

/** The settings fields that route an operation: its route, then its role. */
export function routeFields(operation: string): string[] {
  const role = roleOf(operation);
  return [`routes.${operation}`, ...(role !== undefined ? [`roles.${role}`] : [])];
}

/** No configured provider serves an operation. Exit 2 `route_unavailable`, before any reservation. */
export class RouteUnavailableError extends Error {
  readonly code = "route_unavailable";
  readonly operation: string;
  constructor(operation: string, message: string) {
    super(message);
    this.name = "RouteUnavailableError";
    this.operation = operation;
  }
}

/**
 * More than one configured provider could serve an operation and no route or role picks one.
 * Exit 2 `settings_invalid`: which provider serves it is the developer's choice, not an order.
 */
export class RouteAmbiguousError extends SettingsError {
  readonly operation: string;
  readonly candidates: readonly string[];
  readonly field: string;
  constructor(operation: string, candidates: readonly string[], field: string) {
    super(
      `settings.${field} is not set, and ${candidates.length} configured providers (${candidates.join(", ")}) could serve the ${operation} operation; set settings.${field} to the provider and model that should`,
    );
    this.name = "RouteAmbiguousError";
    this.operation = operation;
    this.candidates = candidates;
    this.field = field;
  }
}

/** A configured provider as resolution sees it: its settings id, its adapter and its entry. */
export interface RouteProvider {
  id: string;
  adapter: {
    id: string;
    capabilities: readonly string[];
    defaultRoutes?: Readonly<Record<string, Route>>;
    /** Which of its models embed images and text in one space; every model when absent. */
    embedsModel?: (model: string) => boolean;
  };
  /** The provider's settings entry; `free` lets an override leave out its estimate. */
  settings?: { free?: boolean };
}

/** A route or role entry of the settings. */
type Override = Settings["routes"][string];

/**
 * The adapter of the test stand-in. Its default routes mirror the core defaults, so it serves an
 * operation only when no other configured provider has a default route for it.
 */
const STAND_IN_ADAPTER = "scripted";

/**
 * The route of one operation: `settings.routes[op]` over `settings.roles[role]` over the default
 * route of the one configured provider whose adapter lists the operation, the scripted stand-in
 * serving only when no other does. When more than one provider could serve it and no route or role
 * picks one, throws `RouteAmbiguousError` (`settings_invalid`) naming the field to set: no order of
 * ids chooses. An override that names the default's provider and model (the default of the
 * override's own provider) keeps the whole default route. One that changes either belongs to
 * another (provider, model) pair, so it takes nothing from the default: it carries only its own `estimatedCostUsd`, `outputGrant` and `providerTerms`,
 * and it must set `estimatedCostUsd` unless its provider is `free` or the scripted stand-in
 * (`settings_invalid` otherwise). Throws `RouteUnavailableError` when the result names no
 * configured provider whose adapter has the role's capability.
 */
export function resolveRoute(
  settings: Pick<Settings, "roles" | "routes">,
  operation: string,
  providers: readonly RouteProvider[],
): Route {
  const role = roleOf(operation);
  const capability = role !== undefined ? ROLE_CAPABILITY[role] : undefined;
  const fields = routeFields(operation)
    .map((f) => `settings.${f}`)
    .join(" or ");
  const what = `the ${operation} operation${role !== undefined ? ` (role ${role})` : ""}`;
  const candidates = providers
    .filter((p) => p.adapter.id !== STAND_IN_ADAPTER && p.adapter.defaultRoutes?.[operation])
    .map((p) => p.id)
    .sort();
  const field = Object.hasOwn(settings.routes, operation)
    ? `routes.${operation}`
    : role !== undefined && Object.hasOwn(settings.roles, role)
      ? `roles.${role}`
      : undefined;
  const override: Override | undefined =
    field === undefined
      ? undefined
      : field.startsWith("routes.")
        ? settings.routes[operation]
        : settings.roles[role!];
  const defaultOf = (id: string | undefined): Route | undefined => {
    const p = providers.find((q) => q.id === id);
    const base = p?.adapter.defaultRoutes?.[operation];
    return p !== undefined && base !== undefined
      ? { ...structuredClone(base), provider: p.id }
      : undefined;
  };
  let fallback: Route | undefined;
  if (override !== undefined) {
    fallback = defaultOf(override.provider);
  } else if (candidates.length > 1) {
    throw new RouteAmbiguousError(
      operation,
      candidates,
      role !== undefined ? `roles.${role}` : `routes.${operation}`,
    );
  } else {
    fallback = defaultOf(
      candidates[0] ?? providers.find((p) => p.adapter.defaultRoutes?.[operation])?.id,
    );
  }
  let route: Route;
  /** The settings field of an override that changes the pair and sets no estimate. */
  let missingEstimate: string | undefined;
  if (override !== undefined) {
    const same = fallback?.provider === override.provider && fallback?.model === override.model;
    if (same) {
      route = {
        ...fallback!,
        ...(override.estimatedCostUsd !== undefined && {
          estimatedCostUsd: override.estimatedCostUsd,
        }),
        ...(override.outputGrant !== undefined && {
          outputGrant: structuredClone(override.outputGrant) as OutputGrant,
        }),
        ...(override.providerTerms !== undefined && { providerTerms: override.providerTerms }),
      };
    } else {
      missingEstimate = override.estimatedCostUsd === undefined ? field : undefined;
      route = {
        provider: override.provider,
        model: override.model,
        estimatedCostUsd: override.estimatedCostUsd ?? 0,
        ...(override.outputGrant !== undefined && {
          outputGrant: structuredClone(override.outputGrant) as OutputGrant,
        }),
        ...(override.providerTerms !== undefined && { providerTerms: override.providerTerms }),
      };
    }
  } else if (fallback !== undefined) {
    route = fallback;
  } else {
    throw new RouteUnavailableError(
      operation,
      `route unavailable: no configured provider serves ${what}; set ${fields} in the developer settings to a configured provider${capability !== undefined ? ` whose adapter has the ${capability} capability` : ""}`,
    );
  }
  const provider = providers.find((p) => p.id === route.provider);
  if (provider === undefined) {
    throw new RouteUnavailableError(
      operation,
      `route unavailable: ${what} names provider "${route.provider}", which is not in the developer settings' providers`,
    );
  }
  if (capability !== undefined && !provider.adapter.capabilities.includes(capability)) {
    throw new RouteUnavailableError(
      operation,
      `route unavailable: ${what} names provider "${provider.id}", whose ${provider.adapter.id} adapter has no ${capability} capability; set ${fields} in the developer settings to a provider that has it`,
    );
  }
  if (capability === "embed" && provider.adapter.embedsModel?.(route.model) === false) {
    throw new RouteUnavailableError(
      operation,
      `route unavailable: ${what} names model "${route.model}" of provider "${provider.id}", which its ${provider.adapter.id} adapter cannot embed images and text with in one space; set ${fields} in the developer settings to a model that can`,
    );
  }
  if (
    missingEstimate !== undefined &&
    provider.settings?.free !== true &&
    provider.adapter.id !== STAND_IN_ADAPTER
  ) {
    throw new SettingsError(
      `settings.${missingEstimate} routes ${what} to provider "${route.provider}" and model "${route.model}", which is not that operation's default (provider, model) pair, and sets no estimatedCostUsd; set settings.${missingEstimate}.estimatedCostUsd to the most one call can cost, since every paid call reserves its estimate before it is made`,
    );
  }
  return route;
}

/** Every operation the settings could route: the role table's and the settings' own routes. */
export function knownOperations(settings: Pick<Settings, "routes">): string[] {
  return [...new Set([...Object.keys(OPERATION_ROLES), ...Object.keys(settings.routes)])];
}

/**
 * The routes of the settings, by operation. An operation no configured provider serves is absent,
 * and reading it throws its `RouteUnavailableError` (exit 2 `route_unavailable`), so a command
 * that plans a call on it stops before any reservation. An ambiguous operation is absent too, and
 * reading it throws `RouteAmbiguousError` (exit 2 `settings_invalid`).
 */
export function resolveRoutes(
  settings: Pick<Settings, "roles" | "routes">,
  providers: readonly RouteProvider[],
): Routes {
  const resolved: Record<string, Route> = {};
  const unavailable = new Map<string, RouteUnavailableError | RouteAmbiguousError>();
  for (const operation of knownOperations(settings)) {
    try {
      resolved[operation] = resolveRoute(settings, operation, providers);
    } catch (error) {
      if (!(error instanceof RouteUnavailableError || error instanceof RouteAmbiguousError)) {
        throw error;
      }
      unavailable.set(operation, error);
    }
  }
  return new Proxy(resolved, {
    get(target, key, receiver) {
      if (typeof key === "string" && !Object.hasOwn(target, key)) {
        const error = unavailable.get(key);
        if (error instanceof RouteAmbiguousError) {
          throw new RouteAmbiguousError(error.operation, error.candidates, error.field);
        }
        if (error !== undefined) throw new RouteUnavailableError(error.operation, error.message);
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
  }) as Routes;
}

const anthropicGrant: OutputGrant = {
  license: "LicenseRef-anthropic-api",
  plan: "api",
  commercial: true,
  relabel: true,
};
const anthropicTerms = "Anthropic Commercial Terms of Service and Usage Policy (as of 2026-11-14)";
const openaiGrant: OutputGrant = {
  license: "LicenseRef-openai-api",
  plan: "api",
  commercial: true,
  relabel: true,
};
const openaiTerms = "OpenAI Services Agreement and Usage Policies (as of 2026-11-14)";

/** A direct adapter's model for one role, with its own per-call estimates. */
interface DirectModel {
  model: string;
  /** The most one call on this model can cost, in USD (a deliberate upper bound). */
  estimatedCostUsd: number;
  /** A larger bound for the operations that send or return more (e.g. a 1536x1024 sheet). */
  byOperation?: Readonly<Record<string, number>>;
}

/**
 * A direct adapter's default routes: every operation of the core defaults whose role is in
 * `models`, on that role's model at that model's own estimate, with the adapter's grant and terms.
 * The size is the core default's for the same operation; provider options are the gateway's and
 * are not carried.
 */
function directRoutes(
  models: Readonly<Record<string, DirectModel>>,
  grant: OutputGrant,
  terms: string,
): Readonly<Record<string, Route>> {
  const routes: Record<string, Route> = {};
  for (const [operation, route] of Object.entries(defaultRoutes)) {
    const role = roleOf(operation);
    const direct = role !== undefined ? models[role] : undefined;
    if (direct === undefined) continue;
    routes[operation] = {
      model: direct.model,
      estimatedCostUsd: direct.byOperation?.[operation] ?? direct.estimatedCostUsd,
      ...(route.size !== undefined && { size: route.size }),
      outputGrant: { ...grant },
      providerTerms: terms,
    };
  }
  return routes;
}

/**
 * The anthropic adapter's default routes (design section 12): vision, decisions and planning.
 * Anthropic has no image models, so image and edit stay with another adapter.
 */
export const ANTHROPIC_DEFAULT_ROUTES: Readonly<Record<string, Route>> = directRoutes(
  {
    // Up to 16 images a call (identity-cast) at Sonnet's input price, with room for the answer.
    vision: { model: "claude-sonnet-5-5", estimatedCostUsd: 0.1 },
    planning: { model: "claude-sonnet-5-5", estimatedCostUsd: 0.1 },
    // Two images and a short structured answer at Haiku's price.
    decisions: { model: "claude-haiku-5-5", estimatedCostUsd: 0.01 },
  },
  anthropicGrant,
  anthropicTerms,
);

/** The openai adapter's default routes (design section 12): every 2D role. */
export const OPENAI_DEFAULT_ROUTES: Readonly<Record<string, Route>> = directRoutes(
  {
    // gpt-image-2 with references: the bounds the gateway default sets for the same model.
    image: { model: "gpt-image-2", estimatedCostUsd: 0.25, byOperation: { sheet: 0.3 } },
    edit: { model: "gpt-image-2", estimatedCostUsd: 0.25 },
    // gpt-6.1-terra: the gateway default's bound for the same model, which covers 16 images.
    vision: { model: "gpt-6.1-terra", estimatedCostUsd: 0.02 },
    planning: { model: "gpt-6.1-terra", estimatedCostUsd: 0.02 },
    decisions: { model: "gpt-6.1-terra", estimatedCostUsd: 0.02 },
  },
  openaiGrant,
  openaiTerms,
);
