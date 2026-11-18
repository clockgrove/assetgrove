/**
 * init (design section 17): writes a target project's starter files and returns the steps a
 * person, or the agent for them, must take next. It never writes a key, the developer settings
 * file or a project-scope harness config, and it is idempotent: a second run changes nothing.
 */
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { ART_DIRECTION_SKILL, BIBLE_PRESETS, serializeBible } from "./bible.ts";
import { routeDataFlows, type RouteDataFlow } from "./dataflows.ts";
import type { Env } from "./env.ts";
import { InputError } from "./errors.ts";
import { formatLine } from "./formats.ts";
import { libraryConfig } from "./library/write.ts";
import { lfsHooksInstalled, lfsSize, lfsVersion, requireWorkTree, withBlock } from "./gitlfs.ts";
import { checkTrackedKeys, KeyTrackedError } from "./guard.ts";
import { adapterKeyEnv, HARNESSES, keyRecipe, type Harness } from "./keys.ts";
import { resolvePackage, SEARCH_PACKAGE, type ExtensionRegistry } from "./extensions/registry.ts";
import { CORE_PACKAGE } from "./extensions/version.ts";
import { CORE_ADAPTERS, type ProviderAdapter } from "./providers/adapter.ts";
import { suggestRoles, type SuggestedRole } from "./providers/set.ts";
import type { Settings } from "./settings.ts";
import type { TargetProfile } from "./types.ts";

/** Where init puts the art direction and prompt template, relative to the target. */
export const BIBLE_PATH = ".assetgrove/art-direction/BIBLE.md";
export const TEMPLATE_PATH = ".assetgrove/prompts/default.md";
export const PROFILE_PATH = ".assetgrove/profile.json";
/** The folders harnesses read skills from: Claude Code `.claude/skills`, Codex `.agents/skills`. */
export const SKILL_ROOTS = [".claude/skills", ".agents/skills"] as const;
/** The default output folders init keeps out of Git. */
export const GITIGNORE_RULES = [
  ".assetgrove/runs/",
  ".assetgrove/imports/",
  ".assetgrove/animation/",
] as const;

function spriteProfile(size: number, crisp: boolean): TargetProfile {
  return {
    format: formatLine("target-profile"),
    name: "my-game",
    license: "NOASSERTION",
    style: crisp
      ? { alpha: { mode: "binary", threshold: 128 }, color: { rule: "full" }, edges: "crisp" }
      : { alpha: { mode: "soft" }, color: { rule: "full" }, edges: "antialiased" },
    values: { creator: "" },
    frames: { width: size, height: size, maxEdge: size * 8, durationMs: 250 },
    layout: {
      media: "assets/source/{{spec.assetId}}/{{spec.animationFamily}}.{{output.extension}}",
      manifest: "assets/manifests/{{spec.assetId}}/{{spec.animationFamily}}.json",
    },
    manifest: {
      assetManifestVersion: 1,
      assetId: "{{spec.assetId}}",
      animationFamily: "{{spec.animationFamily}}",
      source: {
        kind: "generated",
        path: "{{output.path}}",
        mediaType: "{{output.mediaType}}",
        creator: "{{profile.creator}}",
        tool: "assetgrove",
      },
      license: "{{profile.license}}",
      provenance: { prompt: "{{provenance.prompt}}", references: "{{provenance.referenceHashes}}" },
      review: { status: "pending" },
      frames: "{{output.frames}}",
      anchor: "{{output.anchor}}",
      bounds: "{{output.bounds}}",
      palette: "{{output.palette?}}",
      contentHash: "{{output.sha256}}",
    },
    review: { path: "review.status", pending: "pending" },
  } as TargetProfile;
}

/** The target profile presets init starts from. */
export const PROFILE_PRESETS: Record<string, () => TargetProfile> = {
  "sprite-32": () => spriteProfile(32, true),
  "sprite-64": () => spriteProfile(64, false),
};

export interface InitOptions {
  directory: string;
  profilePreset: string;
  stylePreset: string;
  world: string;
  harness?: string;
  providers?: string[];
  overwrite?: boolean;
}

export type FileRole =
  "profile" | "bible" | "style-preset" | "template" | "skill" | "gitignore" | "gitattributes";
export type FileStatus = "written" | "unchanged" | "overwritten";

export interface InitFile {
  /** Absolute. */
  path: string;
  role: FileRole;
  status: FileStatus;
}

export type StepStatus = "done" | "refused" | "needs-person" | "to-run" | "notice";

export interface InitStep {
  id: string;
  status: StepStatus;
  detail: string;
  /** The MCP tool that does the step, when one does. */
  tool?: string;
  /** The CLI command that does the step, when one does. */
  command?: string;
  /** For a key step: the rules the recipe's step adds to the harness's user settings. */
  rules?: unknown;
  /** For the settings step: the roles proposed for `--providers`, to declare by hand. */
  suggestedRoles?: Record<string, SuggestedRole>;
}

export interface BibleQuestion {
  field: string;
  question: string;
}

/** One adapter a loaded extension pack brings, with where its data goes and the key it needs. */
export interface PackAdapter {
  adapter: string;
  extension: string;
  package: string;
  hosts: string[];
  endpointFromSettings: boolean;
  /**
   * The environment variable the adapter reads its key from: a configured provider's `keyEnv`,
   * else the adapter's default; null when neither names one.
   */
  keyEnv: string | null;
}

export interface InitResult {
  steps: InitStep[];
  adapters: PackAdapter[];
  bibleQuestions: BibleQuestion[];
  providers: RouteDataFlow[];
  files: InitFile[];
}

/** The questions the agent asks the developer to draft BIBLE.md with them. */
export const BIBLE_QUESTIONS: readonly BibleQuestion[] = [
  { field: "world", question: "What is the world called, and what is it about in one sentence?" },
  {
    field: "tone.audience",
    question: "Who is the game for: young kids, all ages, teens or adults?",
  },
  {
    field: "axes.rendering",
    question: "How is it drawn: pixel art, flat cartoon, painterly or stylised 3D?",
  },
  { field: "tokens.palette", question: "Which colours define the world? Name three to six." },
  { field: "tone.moodRange", question: "What moods should the art carry, and which never?" },
  {
    field: "anchors",
    question:
      "Which of your own images show the look to follow, and which show what to avoid? Paths inside this repository.",
  },
  { field: "tone.contentLimits", question: "What must never appear in the art?" },
  {
    field: "referenceLicense",
    question:
      "Under what licence are your reference images (an SPDX id, LicenseRef-* or NOASSERTION)?",
  },
];

interface Desired {
  path: string;
  role: FileRole;
  content: string;
}

function bibleProse(world: string): string {
  return `# ${world} art direction\n\nGenerate original work using the axes and tokens above. Add rationale and reference images here.\n\n## Do's and Don'ts\n\nDo follow the positive anchors. Don't reproduce the negative anchors or violate content limits.\n`;
}

function skillText(world: string): string {
  return `---\n${stringify({ name: ART_DIRECTION_SKILL, description: `Load when generating or reviewing art for ${world}.` })}---\n# Art direction\n\nRead [the style bible](../../../${BIBLE_PATH}), including its positive and negative anchor paths and Do's and Don'ts.\nSee [starting presets](../../../.assetgrove/art-direction/presets/) for visual alternatives. The bible is a constitution; briefs cannot override it.\n`;
}

/** Every project file init wants and its content, apart from .gitignore. */
async function desiredFiles(directory: string, options: InitOptions): Promise<Desired[]> {
  const profile = PROFILE_PRESETS[options.profilePreset];
  if (!profile)
    throw new InputError(
      `unknown profile preset ${options.profilePreset}; use one of ${Object.keys(PROFILE_PRESETS).join(", ")}`,
    );
  const style = BIBLE_PRESETS[options.stylePreset];
  if (!style)
    throw new InputError(
      `unknown style preset ${options.stylePreset}; use one of ${Object.keys(BIBLE_PRESETS).join(", ")}`,
    );
  if (!options.world.trim()) throw new InputError("world must be a non-empty string");
  const prose = bibleProse(options.world);
  const data = structuredClone(style);
  data.world = options.world;
  data.referenceLicense = "NOASSERTION";
  const biblePath = join(directory, BIBLE_PATH);
  const template = await readFile(
    new URL("../skills/art-direction/default.md", import.meta.url),
    "utf8",
  );
  return [
    {
      path: join(directory, PROFILE_PATH),
      role: "profile",
      content: `${JSON.stringify(profile(), null, 2)}\n`,
    },
    { path: biblePath, role: "bible", content: serializeBible(data, prose) },
    ...Object.entries(BIBLE_PRESETS).map(([name, value]) => ({
      path: join(dirname(biblePath), "presets", `${name}.md`),
      role: "style-preset" as const,
      content: serializeBible(value, prose, "style-preset"),
    })),
    { path: join(directory, TEMPLATE_PATH), role: "template", content: template },
    ...SKILL_ROOTS.map((root) => ({
      path: join(directory, root, ART_DIRECTION_SKILL, "SKILL.md"),
      role: "skill" as const,
      content: skillText(options.world),
    })),
  ];
}

async function existing(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new InputError(`refusing to overwrite ${path}: not a regular file`);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Writes the project files: each absent file is written, an identical one left alone, and a
 * differing one refused (exit 2, before anything is written) unless `overwrite`. .gitignore gains
 * the rules it lacks and keeps every other line.
 */
export async function writeProjectFiles(options: InitOptions): Promise<InitFile[]> {
  const directory = resolve(options.directory);
  const desired = await desiredFiles(directory, options);
  const current = await Promise.all(desired.map((file) => existing(file.path)));
  const differing = desired.filter(
    (file, i) => current[i] !== undefined && current[i] !== file.content,
  );
  if (differing.length > 0 && !options.overwrite)
    throw new InitConflictError(differing.map((f) => f.path));
  const gitignorePath = join(directory, ".gitignore");
  const gitignore = (await existing(gitignorePath)) ?? "";
  const present = new Set(gitignore.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_RULES.filter((rule) => !present.has(rule));

  const files: InitFile[] = [];
  for (const [i, file] of desired.entries()) {
    const before = current[i];
    if (before === file.content) {
      files.push({ path: file.path, role: file.role, status: "unchanged" });
      continue;
    }
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content);
    files.push({
      path: file.path,
      role: file.role,
      status: before === undefined ? "written" : "overwritten",
    });
  }
  if (missing.length > 0) {
    await mkdir(directory, { recursive: true });
    const separator = gitignore === "" || gitignore.endsWith("\n") ? "" : "\n";
    await writeFile(
      gitignorePath,
      `${gitignore}${separator}${gitignore === "" ? "" : "\n"}# Assetgrove output\n${missing.join("\n")}\n`,
    );
  }
  files.push({
    path: gitignorePath,
    role: "gitignore",
    status: missing.length === 0 ? "unchanged" : gitignore === "" ? "written" : "overwritten",
  });
  return files;
}

/** Puts the marked block in `<root>/.gitattributes`, keeping every other line; never commits. */
async function writeGitattributes(root: string): Promise<InitFile> {
  const path = join(root, ".gitattributes");
  const before = await existing(path);
  const after = withBlock(before ?? "");
  if (before === after) return { path, role: "gitattributes", status: "unchanged" };
  await mkdir(root, { recursive: true });
  await writeFile(path, after);
  return { path, role: "gitattributes", status: before === undefined ? "written" : "overwritten" };
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

/** The Git LFS steps: the install, the hooks, and the metering notice with the library's size. */
function gitSteps(root: string): InitStep[] {
  const version = lfsVersion(root);
  if (version === undefined) {
    return [
      {
        id: "git-lfs",
        status: "needs-person",
        command: "git lfs version",
        detail:
          "Git LFS is not installed. Install it (https://git-lfs.com), then run init again; library media goes through LFS and pick refuses media Git would not send there.",
      },
      {
        id: "notice.lfs-metering",
        status: "notice",
        detail:
          "Your Git host meters LFS storage and bandwidth. The library's current LFS size cannot be measured without git-lfs.",
      },
    ];
  }
  const steps: InitStep[] = [{ id: "git-lfs", status: "done", detail: `${version} is installed.` }];
  if (!lfsHooksInstalled(root)) {
    steps.push({
      id: "git-lfs-install",
      status: "needs-person",
      command: "git lfs install",
      detail:
        "Git LFS hooks are not installed in this repository. Run git lfs install yourself; init never does.",
    });
  }
  steps.push({
    id: "notice.lfs-metering",
    status: "notice",
    detail: `Your Git host meters LFS storage and bandwidth. This library currently holds ${mib(lfsSize(root))} in LFS (committed objects under ${root}).`,
  });
  return steps;
}

/** Project files that differ from what init writes, refused without `overwrite` (exit 2). */
export class InitConflictError extends InputError {
  /** Each differing file, absolute. */
  readonly conflicts: string[];

  constructor(conflicts: string[]) {
    super(
      `refusing to overwrite ${conflicts.join(", ")}: they differ from what init writes; pass --overwrite to replace them`,
    );
    this.name = "InitConflictError";
    this.conflicts = conflicts;
  }
}

/** A refused init: the guard's refusal, with the steps so far. */
export class InitRefusedError extends KeyTrackedError {
  readonly steps: InitStep[];

  constructor(cause: KeyTrackedError) {
    super(cause.message, cause.files);
    this.name = "InitRefusedError";
    this.steps = [{ id: "guard", status: "refused", detail: cause.message }];
  }
}

/** Checks the options that do not touch the disk: the harness and the providers. */
function checkOptions(options: InitOptions, adapters: readonly ProviderAdapter[]): Harness {
  const harness = options.harness ?? "claude-code";
  if (!(HARNESSES as readonly string[]).includes(harness))
    throw new InputError(`unknown harness ${harness}; use one of ${HARNESSES.join(", ")}`);
  const known = adapters.map((adapter) => adapter.id);
  for (const id of options.providers ?? [])
    if (!known.includes(id))
      throw new InputError(`unknown provider adapter ${id}; use one of ${known.join(", ")}`);
  return harness as Harness;
}

/**
 * The search steps (design sections 7.1 and 7.8): a needs-person step when the search package is
 * installed in the project but the settings do not list it, so installing it loads nothing; and,
 * with a shared remote store configured, the notice of what the bucket's readers can see.
 */
export function searchSteps(directory: string, settings: Settings): InitStep[] {
  const steps: InitStep[] = [];
  const listed = settings.extensions.includes(SEARCH_PACKAGE);
  if (!listed && resolvePackage(SEARCH_PACKAGE, directory) !== undefined) {
    steps.push({
      id: "search",
      status: "needs-person",
      detail: `${SEARCH_PACKAGE} is installed in the project but not listed, so it is not loaded: add "${SEARCH_PACKAGE}" to the extensions list in ${settings.path} by hand to search the library (find, search index), then run assetgrove search setup.`,
    });
  }
  const store = settings.search?.store;
  if (store !== undefined) {
    steps.push({
      id: "notice.shared-index",
      status: "notice",
      detail: `A shared index exposes embeddings to whoever can read the bucket: ${store.uri} will hold the card fields, text, paths and embeddings of every pick and bible reference (never images), readable by anyone with read access to it.`,
    });
  }
  return steps;
}

/**
 * Runs init: the tracked-key guard on the target (a refusal throws InitRefusedError before
 * anything is written), the project files, then the steps that remain.
 */
export async function initProject(
  options: InitOptions,
  context: { settings: Settings; env?: Env; extensions?: ExtensionRegistry },
): Promise<InitResult> {
  const adapters = context.extensions?.adapters ?? CORE_ADAPTERS;
  const harness = checkOptions(options, adapters);
  const directory = resolve(options.directory);
  requireWorkTree(directory);
  try {
    checkTrackedKeys(directory, {
      settings: context.settings,
      ...(context.env && { env: context.env }),
    });
  } catch (error) {
    if (error instanceof KeyTrackedError) throw new InitRefusedError(error);
    throw error;
  }
  const files = await writeProjectFiles({ ...options, directory });
  const root = libraryConfig(PROFILE_PRESETS[options.profilePreset]!(), directory).root;
  files.push(await writeGitattributes(root));
  const written = files.filter((f) => f.status !== "unchanged").length;
  const recipe = keyRecipe(
    harness,
    { configDir: context.settings.configDir, stateDir: context.settings.stateDir },
    adapters,
    context.settings.providers,
  );
  const packAdapters = (context.extensions?.loaded ?? [])
    .filter((extension) => extension.package !== CORE_PACKAGE)
    .flatMap((extension) =>
      extension.adapters.flatMap((id): PackAdapter[] => {
        const adapter = adapters.find((a) => a.id === id);
        if (adapter === undefined) return [];
        return [
          {
            adapter: id,
            extension: extension.name,
            package: extension.package,
            hosts: [...adapter.fixedHosts],
            endpointFromSettings: adapter.endpointFromSettings,
            keyEnv: adapterKeyEnv(adapter, context.settings.providers, adapters) ?? null,
          },
        ];
      }),
    );
  const providers = options.providers ?? [];
  const steps: InitStep[] = [
    {
      id: "guard",
      status: "done",
      detail: "No file the target's repository tracks holds a key.",
    },
    {
      id: "files",
      status: "done",
      detail:
        written === 0
          ? "Every project file is already in place; nothing changed."
          : `${written} project file${written === 1 ? "" : "s"} written; ${files.length - written} unchanged.`,
    },
    ...recipe.steps.map((step): InitStep => ({
      id: step.id,
      status: "needs-person",
      detail: `${step.title}. ${step.text}`,
      ...(step.rules && { rules: step.rules }),
    })),
    {
      id: "settings",
      status: "needs-person",
      tool: "settings_change",
      command: "settings change",
      detail: `The agent calls settings_change so the person declares the caps and the provider's limit; only their confirmation writes ${context.settings.path}. Provider endpoints and roles are hand edits per docs/settings.md${providers.length > 0 ? `; suggestedRoles lists the roles for ${providers.join(", ")}` : ""}.`,
      ...(providers.length > 0 && { suggestedRoles: suggestRoles(providers, adapters) }),
    },
    ...gitSteps(root),
    {
      id: "spend-check",
      status: "to-run",
      tool: "spend",
      command: "spend check",
      detail:
        "Run spend check once the limit is declared: it shows, per provider, whether a limit is declared and whether the provider's reading verifies it.",
    },
    ...searchSteps(directory, context.settings),
    {
      id: "notice.auto-answer",
      status: "notice",
      detail:
        "A harness can be set to answer confirmation prompts automatically. Assetgrove cannot prevent that; the record of each pick says how it was confirmed.",
    },
    {
      id: "notice.retention",
      status: "notice",
      detail:
        "Providers may retain what they receive, including prompts and reference images. providers lists each route's host, upstream vendor and the terms recorded for it.",
    },
  ];
  return {
    steps,
    adapters: packAdapters,
    bibleQuestions: [...BIBLE_QUESTIONS],
    providers: routeDataFlows(context.settings, {
      ...(context.env && { env: context.env }),
      adapters,
      ...(context.extensions && { operations: context.extensions.operations }),
    }),
    files,
  };
}
