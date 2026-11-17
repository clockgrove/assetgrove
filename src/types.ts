/** Core data types. Everything game-specific reaches Assetgrove as one of these, as data. */
import type { DigitalSourceType } from "./metadata.ts";
import type { MaterialProfile } from "./material/profile.ts";
import type { TransformStep } from "./transform/types.ts";

export type Rgb = readonly [number, number, number];

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point, Size {}

/** One requested asset. `kind` selects the generator; generators read the fields they need. */
export interface AssetSpec {
  kind: string;
  assetId: string;
  /** The bible subject (character, prop) this asset depicts; defaults to `assetId`. */
  subject?: string;
  /**
   * The bible look this asset follows, for example `character` or `environment`, when the bible
   * declares looks per domain. Unset uses only the bible's shared style.
   */
  look?: string;
  animationFamily?: string;
  /**
   * How the subject moves, for example `biped` or `quadruped`; animation QA uses the motion
   * template's rule for it (docs/animation.md). Overrides the profile's `animation.gait`.
   */
  gait?: string;
  /**
   * The motion template `animationFamily` is judged by (a template's name, or `none` when no
   * template applies). Unset: the template named like the family, else a `motion-template`
   * decision chooses (docs/animation.md).
   */
  template?: string;
  frames?: { count?: number; width?: number; height?: number; durationMs?: number };
  anchor?: Point;
  /** Path (relative to the spec file) of an author-approved key pose; frames are edits of it. */
  keyPose?: string;
  /** Extra values the target profile's manifest template may read, such as `semantic`. */
  fields?: Record<string, unknown>;
  /** `character-3d`: the animation families to retarget onto the rig, for example `["idle"]`. */
  clips?: string[];
  /** `character-3d`: the standing height in metres the model is scaled to; unset keeps its size. */
  heightM?: number;
}

export interface BibleReference {
  /** Path relative to the bible file. */
  path: string;
  /** For example `character`, `turnaround`, `prop`, `perspective`. */
  role: string;
  /** The bible subject this reference shows, if any. */
  subject?: string;
  /** The look this reference belongs to; it is sent only for assets of that look. Unset: every look. */
  look?: string;
  /**
   * For a 3D character's references: which view the image shows (`front`, `left`, `right`, `back`,
   * `three-quarter`, `sheet` or `detail`). Unset: a model judges it from the image (#325).
   */
  view?: string;
  /** This reference's licence (SPDX, `LicenseRef-*` or `NOASSERTION`); the bible's `referenceLicense` otherwise. */
  license?: string;
}

/** A named look in the bible (characters, environment...): style notes for assets of that look. */
export interface BibleLook {
  notes?: string[];
}

export interface StyleBible {
  /** `assetgrove-style-bible/<n>`; required in a file, optional in memory. */
  format?: string;
  version: string;
  /** The licence of the listed references (SPDX, `LicenseRef-*` or `NOASSERTION`); required when it lists any. */
  referenceLicense?: string;
  palette: string[];
  references: BibleReference[];
  /** Path (relative to the bible file) of the perspective sample. */
  perspective: string;
  /** How the perspective sample's view is described, for example `isometric, three-quarter view`. */
  perspectiveDescription?: string;
  subjects?: Record<string, { description: string }>;
  mood?: string[];
  /** Style notes for every asset. */
  notes?: string[];
  /** Looks per domain, keyed by name; a spec's `look` adds that look's notes and references. */
  looks?: Record<string, BibleLook>;
}

/** One bible reference's licence, as provenance records it. */
export interface ReferenceLicense {
  path: string;
  role: string;
  license: string;
}

/** A reference image loaded from disk and sent to a model as an image input. */
export interface LoadedReference {
  role: string;
  path: string;
  mediaType: string;
  bytes: Uint8Array;
  sha256: string;
}

/**
 * The world's style profile, read as part of the target profile. It
 * decides post-processing: soft 8-bit alpha and full colour for a painterly world, binary alpha,
 * crisp edges or a fixed palette for a flat-cartoon or pixel-art one. Every field is optional.
 */
export interface StyleProfile {
  /** Relightable material channels, renditions and target rendering commands; defaults apply when absent. */
  materials?: MaterialProfile;
  /** `soft` keeps 8-bit alpha; `binary` writes only 0 or 255. `threshold` is the opacity bounds use. */
  alpha?: { mode: "soft" | "binary"; threshold?: number };
  /** `full` keeps every colour; `palette` snaps to `palette` (or the bible's palette). */
  color?: { rule: "full" | "palette"; palette?: string[] };
  /** `crisp` resamples nearest-neighbour (pixel art); `antialiased` filters. */
  edges?: "antialiased" | "crisp";
}

export interface TargetProfile {
  /** `assetgrove-target-profile/<n>`; required in a file, optional in memory. */
  format?: string;
  name: string;
  /** The world's style profile; post-processing of imported sheets follows it. */
  style?: StyleProfile;
  /** The license value the target accepts for generated output (for example `MIT`). */
  license: string;
  /**
   * Licences the target accepts on purpose beyond its own, for outputs whose provider grant does
   * not let the target relabel them (for example `["CC-BY-4.0"]`). Non-commercial grants are
   * refused whatever this lists (docs/target-profile.md).
   */
  acceptedLicenses?: string[];
  /** Free values for the manifest template, for example `{ "creator": "My Studio" }`. */
  values?: Record<string, unknown>;
  frames: { width: number; height: number; maxEdge?: number; durationMs?: number };
  /**
   * Path templates relative to the target directory, with `{{a.b}}` placeholders (the same values
   * as the manifest template, for example `{{spec.assetId}}` and `{{output.extension}}`).
   * `provenance` writes the full provenance record as its own file; when it is unset and the
   * manifest template does not embed `{{provenance}}`, the record goes beside the media file as
   * `<media path>.provenance.json`, so every picked file carries its provenance.
   */
  layout: { media: string; manifest: string; provenance?: string };
  /** JSON manifest template: `"{{path}}"` inserts any value, `"a {{path}} b"` interpolates. */
  manifest: unknown;
  /** Where the review status sits in the manifest, and the only value Assetgrove writes there. */
  review: { path: string; pending: string };
  /**
   * The asset library written at hand-off (docs/library.md). `root`: path inside the target,
   * defaults to the static directory prefix of `layout.media`, else the target root. `game`: the
   * game id, the first segment of `asset://` addresses, default a slug of `name`. `log`: `false`
   * turns `log.md` off, default true.
   */
  library?: { root?: string; game?: string; log?: boolean };
  /** Command run in the target directory after hand-off; `{{manifest}}` and `{{media}}` are replaced. */
  validator?: { command: string[] };
  /**
   * Identity scoring of characters with an identity lock (docs/generation-knobs.md). `mode`:
   * `shadow` (default) scores and records without filtering, `enforce` filters candidates below
   * `threshold` (0..1), `off` skips scoring. `question` picks the typed decision (default `score`);
   * `cast` judges the candidate as a choice among every identity in the bible.
   */
  identity?: {
    mode?: "off" | "shadow" | "enforce";
    threshold?: number;
    question?: "score" | "boolean" | "cast";
  };
  /**
   * Provider spend limits across runs (docs/target-profile.md#spend): USD over the last 24 hours,
   * and USD per work item. The stricter of these and the environment's applies.
   */
  spend?: { dailyLimitUsd?: number; workItemLimitUsd?: number };
  /** 3D characters: format, budgets, forward axis, units and turntable (docs/characters-3d.md). */
  model3d?: import("./model3d/profile.ts").Model3dProfile;
  /** Motion templates the target adds or overrides, and the animation QA thresholds. */
  animation?: import("./animation/types.ts").AnimationProfile;
  /**
   * The hand-off presets, in order (docs/target-profile.md#hand-off-presets); each entry's
   * `options` is validated against its preset's schema. Default `[{ preset: "manifest" }]`.
   */
  handoff?: Array<{ preset: string; options?: Record<string, unknown> }>;
}

export interface Reason {
  check: string;
  passed: boolean;
  reason: string;
  source: "deterministic" | "vision" | "decision";
  /** Set on a shadow-mode check: recorded beside QA, never used to filter. */
  shadow?: true;
}

export interface QaResult {
  passed: boolean;
  reasons: Reason[];
}

/** One provider call as recorded in provenance. */
export interface CallRecord {
  operation: string;
  model: string;
  route: string;
  prompt: string;
  parameters: Record<string, unknown>;
  referenceHashes: string[];
  seed?: number;
  requestId: string;
  /** `provider` when the gateway reported the ID; `local` when Assetgrove had to generate one. */
  requestIdSource: "provider" | "local";
  startedAt: string;
  finishedAt: string;
  costUsd: number;
  costSource: "provider" | "estimate";
  /** The provider terms of its route; absent when the route records none. */
  providerTerms?: string;
  /** The date (YYYY-MM-DD) those terms were read, from its route. */
  providerTermsAsOf?: string;
  /** What the provider grants for this call's output, from its route. */
  outputGrant?: OutputGrant;
  /** For a typed decision call: what it answered, how sure and how long it took. */
  decision?: DecisionLog;
}

/**
 * What a provider grants for an output, on the plan or route it was made on. Field names are a
 * contract shared with the target's asset manifest.
 */
export interface OutputGrant {
  /** An SPDX ID (`CC-BY-4.0`), or `LicenseRef-<provider>-<plan>` when the terms are not one. */
  license: string;
  /** The provider plan or route the output was made on (`free`, `pro`, `api`, ...). */
  plan: string;
  /** Whether the grant allows commercial use. */
  commercial: boolean;
  /** Whether the target may declare its own licence (the grant gives ownership). */
  relabel: boolean;
  /** The credit line the grant requires, when it requires one. */
  attribution?: string;
}

/** One typed decision call's answer, as logged in its call record. */
export type DecisionLog = DecisionLogBase &
  (
    | {
        question: "score" | "boolean";
        /** The answer on 0..1: a Score normalised over its levels, or a Boolean's probability of true. */
        value: number;
        /** The raw answer: a Score's position on its levels or a Boolean's probability. */
        raw: number;
      }
    | {
        question: "choice";
        /** The chosen option's probability on 0..1, when the model reports one; unset otherwise. */
        value?: number;
        /** The chosen option's probability as reported, when the model reports one. */
        raw?: number;
        /** A Choice's probability per option, when the model reports them. */
        probabilities?: Record<string, number>;
      }
  );

interface DecisionLogBase {
  /** The answer's label: the nearest Score level's description, `true`/`false`, or the Choice. */
  label: string;
  /** The provider's confidence, else the selected level's probability, when either is known. */
  confidence?: number;
  /** How the answer was made: `decision-model` or `structured-output`, when the provider says. */
  decisionSource?: "decision-model" | "structured-output";
  latencyMs: number;
}

/** One step applied to a frame on its way from the source sheet to the strip. */
export interface Transform {
  op: string;
  [parameter: string]: unknown;
}

/** Where a strip's frame came from and what was done to it. */
export interface FrameProvenance {
  /** Zero-based position in the written strip. */
  index: number;
  /** The frame's number in the import (1-based, reading order on the sheet). */
  frame: number;
  /** The grid cell (or, without a grid, the row and column in reading order) and its box. */
  cell: { row: number; column: number; box: Box };
  /** The model or tool that made the sheet, for example "ChatGPT image generation". */
  tool: string;
  sheetSha256: string;
  transforms: Transform[];
}

/** The source contact sheet of an imported strip. */
export interface SheetSource {
  path: string;
  sha256: string;
  mediaType: string;
  /** The model or tool that made the sheet. */
  tool: string;
}

export interface Provenance {
  digitalSourceType?: DigitalSourceType;
  /** The prompt policy's check of the prompts that made the file (design section 16). */
  promptPolicy?: import("./policy/text.ts").PromptPolicyRecord;
  sourceDeclaration?: import("./metadata.ts").SourceDeclaration;
  generator: string;
  route: string;
  models: string[];
  prompt: string;
  parameters: Record<string, unknown>;
  seed?: number;
  requestIds: string[];
  referenceHashes: string[];
  bibleVersion: string;
  /** The licence of each bible reference listed, as the bible declares it; it gates nothing. */
  referenceLicenses?: ReferenceLicense[];
  /**
   * The licence the output is declared under: the target's licence when the output grant allows
   * relabelling (or there is none), else the granted licence the target accepts.
   */
  license: string;
  /** The combined grant of every call (the most restrictive wins), when any call records one. */
  outputGrant?: OutputGrant;
  providerTerms: string[];
  startedAt: string;
  finishedAt: string;
  costUsd: number;
  calls: CallRecord[];
  /** For strips imported from a contact sheet: the sheet, and each frame's cell and transforms. */
  sheet?: SheetSource;
  frames?: FrameProvenance[];
  /**
   * The transformation steps (PRD §5.11) that made the output, in order: operation, parameters,
   * engine and version, and input and output pixel hashes.
   */
  steps?: TransformStep[];
  /** The identity score against the character's identity lock, when the character has one. */
  identity?: import("./identity.ts").IdentityScore;
  /** Each command a developer wrote that ran for this output: its hash and approval method. */
  commands?: import("./approvals.ts").CommandStep[];
  /** The person's confirmation of the pick that wrote this output (design section 7). */
  confirmation?: ConfirmationRecord;
  /** Which certificate signed the C2PA content credentials of the images hand-off wrote. */
  contentCredentials?: import("./credentials.ts").SignerRecord;
  /**
   * Set when the media was made outside Assetgrove: its record came with no model call, and the
   * media's mark neither records calls nor names a model; never on a strip imported from a sheet
   * whose mark names its sheet tool (src/provenance-binding.ts).
   */
  madeOutsideAssetgrove?: true;
  /**
   * Set beside `madeOutsideAssetgrove` when the media's mark (another tool's) says a model made it:
   * that digital source type, and that Assetgrove checked no licence grant for it. It stays when a
   * later step (look-dev, fix-frame) adds a call: the grant of that call says nothing of the source.
   */
  modelMadeOutsideAssetgrove?: ModelMadeOutsideAssetgrove;
  /** The record's tie to the bytes it describes, written last by each writer (src/provenance-binding.ts). */
  binding?: ProvenanceBinding;
}

/** Media another tool marked as made by a model: no licence grant was checked for it. */
export interface ModelMadeOutsideAssetgrove {
  digitalSourceType: string;
  licenceGrantChecked: false;
}

/** The sha256 of the exact media bytes a record describes, and of the record without `binding`. */
export interface ProvenanceBinding {
  mediaSha256: string;
  recordSha256: string;
}

/** How a confirmation was given (design section 7). */
export type ConfirmationMethod = "headless" | "tty" | "terminal" | "elicitation";

/**
 * A person's confirmation of a spend, pick or write, as written to
 * `<configDir>/confirmations/<hex>.json` and copied into `run.json` and the pick's provenance.
 */
export interface ConfirmationRecord {
  kind: "spend" | "pick" | "write" | "policy";
  /** The request digest the confirmation covers; the record's file is named by it. */
  digest: string;
  method: ConfirmationMethod;
  at: string;
  /** The confirmed forecast in USD; 0 for a pick or write. */
  forecastUsd: number;
  capUsd: number;
  /** The confirmed request's input hashes, by name. */
  inputs: Record<string, string>;
  /** A pick's chosen candidate. */
  choice?: string;
  /** A pick's note, when the person gave one through a form. */
  note?: string;
  client?: string;
  protocolVersion?: string;
  /** Whether the tool asked was marked as requiring a user; false on the CLI. */
  toolMarkedRequiresUser: boolean;
  /** The headless operator, for method `headless`. */
  operator?: string;
  /** The method is what the channel reported; Assetgrove cannot prove a person answered. */
  selfReported: true;
  /** A spend's command, from the confirmed request. */
  command?: string;
  /** The run a spend confirmation pays for: bound by its first run, it pays for no other. */
  run?: RunBinding;
  /** A plan's spend confirmation: the `digest` of the plan file its run saved. */
  savedPlan?: string;
  /** A plan's spend confirmation: the one apply run of that saved plan it covers. */
  coveredRun?: RunBinding;
}

/** The run directory a confirmation is bound to, and when that run finished (then it pays for none). */
export interface RunBinding {
  runDir: string;
  consumedAt?: string;
}

/** A file a generator produced. Each output declares its own media type and extension. */
export interface MediaOutput {
  mediaType: string;
  extension: string;
  bytes: Uint8Array;
  /** Values the manifest template may read as `{{output.*}}`, for example `bounds` and `palette`. */
  fields: Record<string, unknown>;
}
