import type { ModelDeclarations } from "./model-declarations.ts";
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
/**
 * Whether a library asset made under another style bible version should be redone: one Boolean
 * decision per asset and version pair, made only by `library judge-stale` (src/library/stale.ts).
 */
export const STALENESS_OPERATION = "bible-staleness";
/**
 * Which motion template describes an animation family (#364): one typed choice decision per
 * family with no declared template and no template of its exact name, text only.
 */
export const MOTION_TEMPLATE_OPERATION = "motion-template";
/**
 * Whether a member of a set is drawn in a different art style from the rest: one Boolean decision
 * per member among the five most distant of the set's ranking, made only by `find --outliers`
 * (src/search/style-outliers.ts).
 */
export const STYLE_OUTLIER_OPERATION = "style-outlier";
/**
 * Whether stage's background removal cut part of the subject away or left background attached
 * (#364): one Boolean decision per still or sprite-strip candidate, shown the source image and the
 * cut-out over a contrasting colour.
 */
export const CUTOUT_OPERATION = "cutout";
/**
 * What an ambiguous blob on a contact sheet is (#364): a figure, part of the figure next to it, a
 * label or a speck. One choice decision per blob the slicer cannot tell by area, at sheet import.
 */
export const SHEET_BLOB_OPERATION = "sheet-blob";
/**
 * Whether a planned run's candidate violates the constitution or asset spec (#378): one Boolean
 * decision per candidate, shown the candidate and the references.
 */
export const STYLE_VERDICT_OPERATION = "style-verdict";
/**
 * Which allowed mood (or enumerated adjustment value) is closest to the one a brief requested
 * (#378): a typed choice, at most once per field per plan, only when the request is out of bounds.
 */
export const BRIEF_CLAMP_OPERATION = "brief-clamp";
/**
 * Whether an asset is part of the game's user interface (#378): one Boolean decision per plan,
 * asked only when DESIGN.md has colours and the brief does not declare `ui`.
 */
export const UI_ASSET_OPERATION = "ui-asset";
/**
 * Whether a material map flickers between two frames (#364): one choice decision (same, follows
 * the pose, flickers) per channel and frame pair whose map the pixel comparison could not clear.
 */
export const MAP_FLICKER_OPERATION = "map-flicker";
/**
 * Which library clip of a 3D clip route is a requested animation family (#378): one choice
 * decision per family that is not exactly a library key, at most once per family per run, made
 * only on the provider-rig path.
 */
export const CLIP_MAP_OPERATION = "clip-map";
/**
 * Audio generation (docs/PRD-audio.md): the operation that holds each audio adapter's default
 * route. A kind's own audio operation (role `audio`) takes this default when it has none.
 */
export const AUDIO_OPERATION = "audio";

/** A model route: which provider and model serve an operation, its per-call estimate and its terms. */
export interface Route {
  /** The settings id of the provider that serves it; set on every resolved route. */
  provider?: string;
  model: string;
  modelDeclarations?: ModelDeclarations;
  /** Upper estimate of one call's cost in USD; reserved against the cap before the call. */
  estimatedCostUsd: number;
  /**
   * The provider terms the output was made under, recorded in provenance. Absent on a route whose
   * provider or model was overridden without its own terms.
   */
  providerTerms?: string;
  /** The date (YYYY-MM-DD) the provider terms were read, beside `providerTerms`. */
  providerTermsAsOf?: string;
  /**
   * What the provider grants for this route's outputs on the plan it is called on, recorded on
   * every call. A call without one is refused at hand-off (exit 7 `license_refused`).
   */
  outputGrant?: OutputGrant;
  size?: string;
  /** Whether the model accepts a seed; only then is one sent and recorded. */
  supportsSeed?: boolean;
  /**
   * The vendor's training opt-out as the developer declared it in settings for this route, with
   * the date it was set; recorded on each call as declared by the developer.
   */
  trainingOptOut?: { optedOut: boolean; since: string };
  providerOptions?: Record<string, Record<string, unknown>>;
  /**
   * The route's provider options when they differ from the default route of the route's own
   * provider for the operation (its adapter's `defaultRoutes[operation]`); absent when they match
   * or the route has none. It enters the call key (src/runs/journal.ts) and the request digest
   * (jobs in src/runs/plan.ts), so a route on default options keeps today's keys.
   */
  keyedProviderOptions?: Record<string, Record<string, unknown>>;
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
  "fix-scale": Route;
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
const tripoTermsAsOf = "2026-11-10";

const googleGrant: OutputGrant = {
  license: "LicenseRef-google-api",
  plan: "api",
  commercial: true,
  relabel: true,
};
const googleTerms =
  "Google Gemini API Additional Terms of Service, via Vercel AI Gateway (as of 2026-11-07)";
const googleTermsAsOf = "2026-11-07";

/**
 * Stability's terms for Stable Audio, read 2026-11-18 (docs/PRD-audio.md, "Routes"). Stability
 * assigns its rights in output, so the target may declare its own licence.
 */
const stabilityAudioGrant: OutputGrant = {
  license: "LicenseRef-stability-api",
  plan: "api",
  commercial: true,
  relabel: true,
};
const stabilityAudioTerms =
  "Stability AI API Terms of Service (as of 2026-11-18): Stability assigns its rights in output to you; commercial use allowed. Training on inputs and outputs is on by default, with an opt-out. Its watermark, content credentials and other AI markings may not be removed, and output may not be presented as human-made.";
const stabilityAudioTermsAsOf = "2026-11-18";
/** Stability's published price: 8 credits a successful generation at $0.01 a credit. */
const STABLE_AUDIO_USD = 0.08;

/** Stable Audio 2.5: direct and synchronous, 1 to 190 s, with a seed. Serves every audio kind. */
const stableAudio25Route: Route = {
  model: "stable-audio-2.5",
  estimatedCostUsd: STABLE_AUDIO_USD,
  supportsSeed: true,
  outputGrant: stabilityAudioGrant,
  providerTerms: stabilityAudioTerms,
  providerTermsAsOf: stabilityAudioTermsAsOf,
};

/**
 * The Stability adapter's routes by model beyond its default: Stable Audio 3.0, asynchronous with a
 * job id, up to 380 s, results kept 24 h; for ambience and music. A settings route naming the
 * Stability provider and this model takes its terms, grant and estimate.
 */
export const STABILITY_MODEL_ROUTES: Readonly<Record<string, Route>> = {
  "stable-audio-3.0": {
    model: "stable-audio-3.0",
    estimatedCostUsd: STABLE_AUDIO_USD,
    supportsSeed: true,
    outputGrant: stabilityAudioGrant,
    providerTerms: stabilityAudioTerms,
    providerTermsAsOf: stabilityAudioTermsAsOf,
  },
};

/** The Stability adapter's default routes: audio on Stable Audio 2.5. */
export const STABILITY_DEFAULT_ROUTES: Readonly<Record<string, Route>> = {
  audio: stableAudio25Route,
};

/**
 * ElevenLabs Sound Effects v3, direct, on a paid plan (read 2026-11-18). The grant's plan is
 * replaced on each call by the account's tier as the adapter reads it; the output is non-exclusive.
 * Its estimate is the published $0.12 a minute for the longest clip the API makes (30 s); each
 * call reserves the rate times its own requested duration.
 */
export const ELEVENLABS_DEFAULT_ROUTES: Readonly<Record<string, Route>> = {
  audio: {
    model: "eleven_text_to_sound_v3",
    estimatedCostUsd: 0.06,
    providerOptions: { elevenlabs: { sampleRate: 44100 } },
    outputGrant: {
      license: "LicenseRef-elevenlabs-paid",
      plan: "paid",
      commercial: true,
      relabel: true,
      exclusive: false,
    },
    providerTerms:
      'ElevenLabs Terms of Service, paid plan (as of 2026-11-18): paid plans may use output commercially; free plans are non-commercial only. You keep the rights in output. Output is non-exclusive: it may not be unique across users. ElevenLabs may use content to improve its services, with a "Data use" opt-out that applies from the day it is set.',
    providerTermsAsOf: "2026-11-18",
  },
};

/**
 * Audio routes the design refuses, each with its reason (docs/PRD-audio.md, "Routes"): a route of
 * the `audio` role that matches one is unavailable, naming the reason, before any reservation.
 */
export const REFUSED_AUDIO_ROUTES: readonly {
  reason: string;
  matches: (route: Route, adapter: string) => boolean;
}[] = [
  {
    reason: "its model is licensed CC BY-NC (non-commercial), and a sold game is commercial use",
    matches: (route) =>
      /(^|-)NC(-|$)/.test(route.outputGrant?.license ?? "") ||
      /(^|[/_-])(musicgen|audiogen)([._-]|$)/i.test(route.model),
  },
  {
    reason:
      "it is open-weight Stable Audio hosted by a third party: the Stability AI Community License needs registration, ends above $1,000,000 of revenue and does not say how a host's outputs are covered",
    // The scripted stand-in serves the core defaults, Stability's included, and reaches no host.
    matches: (route, adapter) =>
      adapter !== "stability" &&
      adapter !== STAND_IN_ADAPTER &&
      /stable[-_ ]?audio/i.test(route.model),
  },
  {
    reason:
      "it reaches ElevenLabs through the AI Gateway, whose terms do not say which ElevenLabs rights tier applies",
    matches: (route, adapter) =>
      adapter === "vercel-ai-gateway" && /^elevenlabs\//i.test(route.model),
  },
  {
    reason:
      "it is Eleven Music, whose plans below Enterprise exclude games outside its Indie Game definition, which Assetgrove cannot verify",
    // Only ElevenLabs' own ids: `eleven_music*` anywhere, a bare `music_v1` only on ElevenLabs
    // (its adapter, or an `elevenlabs/` model id). Another vendor's `music-…` model is not this.
    matches: (route, adapter) => {
      const model = route.model.replace(/^elevenlabs\//i, "");
      const eleven = adapter === "elevenlabs" || /^elevenlabs\//i.test(route.model);
      return /^eleven[-_]?music([-_]|$)/i.test(model) || (eleven && /^music([-_]|$)/i.test(model));
    },
  },
  {
    reason: "its vendor has no public API",
    matches: (route) => /(^|\/)(suno|udio)([/_-]|$)/i.test(route.model),
  },
];

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
    providerTermsAsOf: "2026-11-07",
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
    providerTermsAsOf: "2026-11-07",
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
    providerTermsAsOf: "2026-11-07",
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
    providerTermsAsOf: "2026-11-07",
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
    providerTermsAsOf: "2026-11-08",
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
    providerTermsAsOf: "2026-11-15",
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
    providerTermsAsOf: "2026-11-15",
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
    providerTermsAsOf: "2026-11-15",
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
  // Whether an asset made under another bible version should be redone (#366): one Boolean
  // decision per asset and version pair, shown its thumbnail; same model and bound as identity.
  [STALENESS_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-16)",
    providerTermsAsOf: "2026-11-16",
  },
  // Which motion template describes an animation family (#364): one typed choice decision per
  // undecided family, text only, on the same typed decision model and upper bound as identity.
  [MOTION_TEMPLATE_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-16)",
    providerTermsAsOf: "2026-11-16",
  },
  // Whether a set member is drawn in another art style (#366): one Boolean decision per member
  // among the five most distant, shown it and a contact sheet; same model and bound as identity.
  [STYLE_OUTLIER_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-16)",
    providerTermsAsOf: "2026-11-16",
  },
  // Whether stage's cut-out lost part of the subject or kept background (#364): one Boolean
  // decision per still or sprite-strip candidate, on the same typed decision model and bound.
  [CUTOUT_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-17)",
    providerTermsAsOf: "2026-11-17",
  },
  // What an ambiguous blob on a sheet is (#364): one choice decision per blob slicing cannot tell
  // by area, at most 24 per sheet (SHEET_BLOB_LIMIT), on the same typed decision model and bound.
  [SHEET_BLOB_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-17)",
    providerTermsAsOf: "2026-11-17",
  },
  // Whether a planned run's candidate violates the constitution or asset spec (#378): one Boolean
  // decision per candidate, on the same typed decision model and upper bound as identity.
  [STYLE_VERDICT_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-16)",
    providerTermsAsOf: "2026-11-16",
  },
  // Plan-time brief decisions (#378), on the same typed decision model and upper bound as identity.
  [BRIEF_CLAMP_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-16)",
    providerTermsAsOf: "2026-11-16",
  },
  [UI_ASSET_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-16)",
    providerTermsAsOf: "2026-11-16",
  },
  // Whether a material map flickers between two frames (#364): one choice decision per channel and
  // frame pair still over the flicker bound where the albedo is unchanged, same model and bound.
  [MAP_FLICKER_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-17)",
    providerTermsAsOf: "2026-11-17",
  },
  // Which library clip a requested animation family is (#378): one choice decision per family that
  // is not exactly a library key, same model and bound.
  [CLIP_MAP_OPERATION]: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-17)",
    providerTermsAsOf: "2026-11-17",
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
    providerTermsAsOf: "2026-11-11",
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
    providerTermsAsOf: "2026-11-11",
  },
  // Identity flicker (#376): one typed Boolean decision per consecutive frame pair and the loop
  // seam, on the typed decision model and its upper bound.
  flicker: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-15)",
    providerTermsAsOf: "2026-11-15",
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
    providerTermsAsOf: tripoTermsAsOf,
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
    providerTermsAsOf: tripoTermsAsOf,
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
    providerTermsAsOf: tripoTermsAsOf,
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
    providerTermsAsOf: "2026-11-07",
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
    providerTermsAsOf: "2026-11-07",
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
    providerTermsAsOf: "2026-11-07",
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
    providerTermsAsOf: "2026-11-12",
  },
  // Holes (#376): one typed Boolean decision per frame (the frame before and after background
  // removal, or its enclosed see-through areas marked), on the typed decision model.
  holes: {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-15)",
    providerTermsAsOf: "2026-11-15",
  },
  // Fix-frame's scale (#376): one typed choice among candidate sizes, on the typed decision model.
  "fix-scale": {
    model: "perplexity/pplx-decider-v1.2",
    estimatedCostUsd: 0.001,
    outputGrant: {
      license: "LicenseRef-perplexity-api",
      plan: "api",
      commercial: true,
      relabel: true,
    },
    providerTerms: "Perplexity API Terms of Service, via Vercel AI Gateway (as of 2026-11-15)",
    providerTermsAsOf: "2026-11-15",
  },
  // Prompt compilation for plan (the planning role) and material QA: the vision model.
  compiler: {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    outputGrant: googleGrant,
    providerTerms: googleTerms,
    providerTermsAsOf: googleTermsAsOf,
  },
  "material-qa": {
    model: "google/gemini-3-flash",
    estimatedCostUsd: 0.02,
    outputGrant: googleGrant,
    providerTerms: googleTerms,
    providerTermsAsOf: googleTermsAsOf,
  },
  // Audio (docs/PRD-audio.md): Stability's default, served by the Stability adapter.
  [AUDIO_OPERATION]: stableAudio25Route,
};

/** The 3D operations, served by Tripo; every other core default is a gateway route. */
const MODEL3D_OPERATIONS = new Set(["model3d", "rig3d", "clips3d"]);

function pick(keep: (operation: string) => boolean): Record<string, Route> {
  return Object.fromEntries(Object.entries(defaultRoutes).filter(([op]) => keep(op)));
}

/** The gateway adapter's default routes: the 2D operations of the core defaults. */
export const GATEWAY_DEFAULT_ROUTES: Readonly<Record<string, Route>> = pick(
  (op) => !MODEL3D_OPERATIONS.has(op) && op !== AUDIO_OPERATION,
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
  [LOOKDEV_LOCATE_OPERATION]: "vision",
  [LOOKDEV_GROOM_OPERATION]: "vision",
  [LOOKDEV_MARKINGS_OPERATION]: "vision",
  [IDENTITY_CAST_OPERATION]: "vision",
  [IDENTITY_CHECK_OPERATION]: "vision",
  "material-qa": "vision",
  identity: "decisions",
  flicker: "decisions",
  holes: "decisions",
  "fix-scale": "decisions",
  [PROMPT_POLICY_OPERATION]: "decisions",
  [BRIEF_POLICY_OPERATION]: "decisions",
  [REFERENCE_VIEW_OPERATION]: "decisions",
  [MODEL3D_FACING_OPERATION]: "decisions",
  [LOOKDEV_MARKING_OPERATION]: "decisions",
  [STALENESS_OPERATION]: "decisions",
  [MOTION_TEMPLATE_OPERATION]: "decisions",
  [STYLE_OUTLIER_OPERATION]: "decisions",
  [CUTOUT_OPERATION]: "decisions",
  [SHEET_BLOB_OPERATION]: "decisions",
  [STYLE_VERDICT_OPERATION]: "decisions",
  [BRIEF_CLAMP_OPERATION]: "decisions",
  [UI_ASSET_OPERATION]: "decisions",
  [MAP_FLICKER_OPERATION]: "decisions",
  [CLIP_MAP_OPERATION]: "decisions",
  compiler: "planning",
  model3d: "model3d",
  rig3d: "rig3d",
  clips3d: "clips3d",
  [EMBED_OPERATION]: "embeddings",
  [AUDIO_OPERATION]: "audio",
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
  audio: "audio",
};

/**
 * The core operation whose default route serves a role's operations that have no default of their
 * own: a kind's `pixel:still` (role image) starts from the default of `still`.
 */
export const ROLE_DEFAULT_OPERATION: Readonly<Record<string, string>> = {
  image: "still",
  edit: "edit",
  vision: "vision",
  decisions: "identity",
  planning: "compiler",
  model3d: "model3d",
  rig3d: "rig3d",
  clips3d: "clips3d",
  embeddings: EMBED_OPERATION,
  audio: AUDIO_OPERATION,
};

/**
 * The role of an operation in `operations` (core's table by default, or core's plus the loaded
 * kinds'); undefined for an operation outside it.
 */
export function roleOf(
  operation: string,
  operations: Readonly<Record<string, string>> = OPERATION_ROLES,
): string | undefined {
  return Object.hasOwn(operations, operation) ? operations[operation] : undefined;
}

/** The settings fields that route an operation: its route, then its role. */
export function routeFields(
  operation: string,
  operations: Readonly<Record<string, string>> = OPERATION_ROLES,
): string[] {
  const role = roleOf(operation, operations);
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
    /** Its routes by model beyond its defaults (`ProviderAdapter.modelRoutes`). */
    modelRoutes?: Readonly<Record<string, Route>>;
  };
  /** The provider's settings entry; `free` lets an override leave out its estimate. */
  settings?: { free?: boolean };
}

/** JSON with object keys sorted, so equal options compare equal whatever their key order. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
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
 * (`settings_invalid` otherwise). `providerOptions` follow the same rule: an override of the same
 * pair that names them replaces the default's whole, one that names none keeps the default's; a
 * changed pair carries only the ones it names. A route whose options differ from the default of its
 * own provider also gets them as `keyedProviderOptions`. Throws `RouteUnavailableError` when the result names no
 * configured provider whose adapter has the role's capability.
 */
export function resolveRoute(
  settings: Pick<Settings, "roles" | "routes">,
  operation: string,
  providers: readonly RouteProvider[],
  operations: Readonly<Record<string, string>> = OPERATION_ROLES,
): Route {
  const role = roleOf(operation, operations);
  const capability = role !== undefined ? ROLE_CAPABILITY[role] : undefined;
  const fields = routeFields(operation, operations)
    .map((f) => `settings.${f}`)
    .join(" or ");
  const what = `the ${operation} operation${role !== undefined ? ` (role ${role})` : ""}`;
  // An operation of a kind, outside core's table, takes its role's default where its adapter has none of its own.
  const defaultFor = (p: RouteProvider): Route | undefined =>
    p.adapter.defaultRoutes?.[operation] ??
    (role !== undefined && !Object.hasOwn(OPERATION_ROLES, operation)
      ? p.adapter.defaultRoutes?.[ROLE_DEFAULT_OPERATION[role] ?? ""]
      : undefined);
  const candidates = providers
    .filter((p) => p.adapter.id !== STAND_IN_ADAPTER && defaultFor(p))
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
    const base = p !== undefined ? defaultFor(p) : undefined;
    return p !== undefined && base !== undefined
      ? { ...structuredClone(base), provider: p.id }
      : undefined;
  };
  let fallback: Route | undefined;
  if (override !== undefined) {
    fallback = defaultOf(override.provider);
    // A model the adapter knows beyond its default carries its own terms, grant and estimate.
    const p = providers.find((q) => q.id === override.provider);
    const known =
      fallback?.model === override.model ? undefined : p?.adapter.modelRoutes?.[override.model];
    if (p !== undefined && known !== undefined)
      fallback = { ...structuredClone(known), provider: p.id };
  } else if (candidates.length > 1) {
    throw new RouteAmbiguousError(
      operation,
      candidates,
      role !== undefined ? `roles.${role}` : `routes.${operation}`,
    );
  } else {
    fallback = defaultOf(candidates[0] ?? providers.find((p) => defaultFor(p))?.id);
  }
  let route: Route;
  /** The settings field of an override that changes the pair and sets no estimate. */
  let missingEstimate: string | undefined;
  if (override !== undefined) {
    const same = fallback?.provider === override.provider && fallback?.model === override.model;
    if (same) {
      // A date belongs to the terms text it was recorded for: new text without its own date
      // drops the default's date rather than claiming it.
      const { providerTermsAsOf: inheritedAsOf, ...base } = fallback!;
      const keepAsOf =
        override.providerTerms === undefined && inheritedAsOf !== undefined
          ? { providerTermsAsOf: inheritedAsOf }
          : {};
      route = {
        ...base,
        ...keepAsOf,
        ...(override.estimatedCostUsd !== undefined && {
          estimatedCostUsd: override.estimatedCostUsd,
        }),
        ...(override.outputGrant !== undefined && {
          outputGrant: structuredClone(override.outputGrant) as OutputGrant,
        }),
        ...(override.modelDeclarations !== undefined && {
          modelDeclarations: structuredClone(override.modelDeclarations),
        }),
        ...(override.providerTerms !== undefined && { providerTerms: override.providerTerms }),
        ...(override.providerTermsAsOf !== undefined && {
          providerTermsAsOf: override.providerTermsAsOf,
        }),
        ...(override.providerOptions !== undefined && {
          providerOptions: structuredClone(override.providerOptions),
        }),
        ...(override.trainingOptOut !== undefined && {
          trainingOptOut: { ...override.trainingOptOut },
        }),
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
        ...(override.modelDeclarations !== undefined && {
          modelDeclarations: structuredClone(override.modelDeclarations),
        }),
        ...(override.providerTerms !== undefined && { providerTerms: override.providerTerms }),
        ...(override.providerTermsAsOf !== undefined && {
          providerTermsAsOf: override.providerTermsAsOf,
        }),
        ...(override.providerOptions !== undefined && {
          providerOptions: structuredClone(override.providerOptions),
        }),
        ...(override.trainingOptOut !== undefined && {
          trainingOptOut: { ...override.trainingOptOut },
        }),
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
  if (route.providerOptions !== undefined) {
    const base = defaultOf(route.provider)?.providerOptions;
    if (base === undefined || sortedJson(route.providerOptions) !== sortedJson(base)) {
      route.keyedProviderOptions = structuredClone(route.providerOptions);
    }
  }
  const provider = providers.find((p) => p.id === route.provider);
  if (provider === undefined) {
    throw new RouteUnavailableError(
      operation,
      `route unavailable: ${what} names provider "${route.provider}", which is not in the developer settings' providers`,
    );
  }
  if (role === "audio") {
    const refused = REFUSED_AUDIO_ROUTES.find((r) => r.matches(route, provider.adapter.id));
    if (refused !== undefined)
      throw new RouteUnavailableError(
        operation,
        `route unavailable: ${what} names model "${route.model}" of provider "${provider.id}" (${provider.adapter.id} adapter), a refused audio route: ${refused.reason}`,
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
export function knownOperations(
  settings: Pick<Settings, "routes">,
  operations: Readonly<Record<string, string>> = OPERATION_ROLES,
): string[] {
  return [...new Set([...Object.keys(operations), ...Object.keys(settings.routes)])];
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
  operations: Readonly<Record<string, string>> = OPERATION_ROLES,
): Routes {
  const resolved: Record<string, Route> = {};
  const unavailable = new Map<string, RouteUnavailableError | RouteAmbiguousError>();
  for (const operation of knownOperations(settings, operations)) {
    try {
      resolved[operation] = resolveRoute(settings, operation, providers, operations);
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
const anthropicTermsAsOf = "2026-11-14";
const openaiGrant: OutputGrant = {
  license: "LicenseRef-openai-api",
  plan: "api",
  commercial: true,
  relabel: true,
};
const openaiTerms = "OpenAI Services Agreement and Usage Policies (as of 2026-11-14)";
const openaiTermsAsOf = "2026-11-14";

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
  termsAsOf: string,
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
      providerTermsAsOf: termsAsOf,
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
  anthropicTermsAsOf,
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
  openaiTermsAsOf,
);
