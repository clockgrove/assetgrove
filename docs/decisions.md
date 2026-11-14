# Decisions

This file lists the decisions in force in Assetgrove and the reason for each.

## Language and tooling

Assetgrove is TypeScript on Node 24, managed with pnpm. Node runs the `.ts` sources directly with its built-in type stripping, so development has no build step, the code uses erasable syntax only (no enums, namespaces or parameter properties), and imports name their `.ts` files. A game that already uses Node, pnpm and TypeScript runs Assetgrove with no new runtime.

- **pnpm** is pinned through `packageManager` and enabled with corepack. CI installs with `pnpm install --frozen-lockfile --ignore-scripts`, so no dependency may need an install script.
- **Commands:** `pnpm check` runs Prettier, ESLint (typescript-eslint) and `tsc --noEmit`. `pnpm test` runs `node:test` over `test/**/*.test.ts`, offline, with the scripted provider. `pnpm test:real` runs the opt-in real-provider checks in `test/real/`, which skip without their keys (`AI_GATEWAY_API_KEY`, `TRIPO_API_KEY`).
- **Runtime dependencies:** `ai` (the Vercel AI SDK, imported only by `src/gateway/vercel.ts`), `pngjs` and `jpeg-js` (pure-JavaScript image codecs), `yaml` (the bible's front matter), `@modelcontextprotocol/server` (the MCP server), `gltf-validator` (the Khronos glTF validator in 3D QA) and `meshoptimizer` (mesh simplification for detail levels).
- **TypeScript** stays on 6.0, the newest version typescript-eslint supports.

## Release-age exclusion for the `ai` SDK

`pnpm-workspace.yaml` lists `ai@7.0.165` and its three `@ai-sdk/*` packages, at exact versions, under `minimumReleaseAgeExclude`. pnpm's default release-age policy refuses versions published too recently, and the gateway adapter is written and checked against this release. The exclusion names exact versions only, so any other version, including a later update, still waits out the window. Once these versions are older than the window, the exclusion can go; `pnpm install` must then leave the lockfile unchanged.

## Packaging

The package is `@clockgrove/assetgrove`. It ships compiled JavaScript, because Node refuses to strip types inside `node_modules`.

- `tsc -p tsconfig.build.json` builds `dist/`, with `rewriteRelativeImportExtensions` turning `.ts` imports into `.js`. The repository itself runs the sources directly.
- The package ships `dist/`, `skills/`, the README and the LICENSE.
- The version is `0.0.0` in the repository.
- Publishing (the npm org, trusted publishing and a release workflow) is a maintainer's step and is not in the repository. The package is published at 1.0.

## CLI contract

Every command follows one contract, so scripts and agents can drive Assetgrove without parsing prose.

- With `--json`, stdout is one JSON document: `ok`, `exitCode`, `command` and, on refusal, `error` with `code` and `message`. Logs go to stderr. Nothing prompts.
- Exit codes:
  - 0: success.
  - 1: unexpected internal error.
  - 2: invalid input.
  - 3: cap refused, by the run's cap or a cross-run spend limit, including a dry-run forecast over either.
  - 4: provider error.
  - 5: QA found nothing.
  - 6: the target's validator rejected what was written (`pick` or `write-families`).
  - 7: licence refused (`license_refused`): the provider's output grant does not let the target declare the output, and nothing is written.
- `--dry-run` (on `stage`, `generate-sheet`, `animation-qa`, `fix-frame` and `materials`) prints the planned calls and the forecast, spends nothing and needs no key.
- `--provider-script` runs a scripted provider for offline runs.

## MCP server on the official SDK

`assetgrove mcp` is served by the official TypeScript MCP SDK, `@modelcontextprotocol/server` 2.4.0 (Apache-2.0), over its stdio transport. The SDK negotiates the protocol revision, where hand-written protocol code would fall behind the protocol. It brings `@modelcontextprotocol/core` 2.4.0 (Apache-2.0) and `zod` (MIT); none of them has an install script, and 2.4.0 needs no release-age exclusion. Each tool's input schema is derived from its command's JSON Schema input by `toolInputSchema` (src/commands/runner.ts): it drops the CLI-only properties (`providerScript`, `dryRun`, `routes`, `autoApprove`) and the help `placeholder` keyword, and allows no other property. It is wrapped with the SDK's `fromJsonSchema`, and `tools/list` advertises it as derived. The SDK's own argument check is a pass-through: the tool handler validates the arguments against the same schema, so a bad argument comes back as the CLI's `invalid_input` result document with `isError` set, not as a protocol error.

## Generation constitutions

Art direction lives in a target-owned Markdown bible with validated YAML front matter, prose rationale, and Do's and Don'ts. Palette, outline, lighting, fog, saturation and value bounds use DTCG 2025.10 typed tokens; art-specific axes stay in the art schema. The JSON profile, spec and recipe formats stay JSON, and `yaml` is pinned to 2.9.1 because the bible format requires YAML.

The target owns an Agent Skill that links the bible and starting presets. DESIGN.md contributes UI colour context only; Assetgrove does not extend its format with art direction. Prompt templates are copied into the target repository on explicit initialization (`assetgrove bible init`) and versioned there. `plan` records the compilation and model inputs; `apply` checks their hashes and authorizes generation spend without approving an asset.

## Media transformation core

Operations are declared once, by name and parameter schema, in `src/transform/operations.ts`, and engines implement them behind the `ImageEngine` adapter. The in-house engine is `assetgrove-raster`; its version is bumped whenever an operation's output bytes change, so provenance names what made each file.

- Recipes are JSON (`format: "assetgrove-recipe/1"`). The parameter schemas use a small JSON Schema subset kept in the repository, so recipes need no parser or validator dependency.
- Provenance steps are chained by pixel hashes, so intermediate images are never encoded. Sources and written files also record their file SHA-256. The record holds no time, so reruns are byte-identical.
- WebP output is lossless VP8L from an in-house encoder, because it is deterministic and needs no native dependency.
- The sheet import runs on these operations.

## Sheet generation first

The model generates a whole animation cycle as one contact sheet, because a whole sheet keeps identity consistent; a per-frame reference edit is the fallback for fixing a single frame. Sheets made by other tools take the same import path. A vision model proposes the families, order and mirror pairs, and the author confirms them by setting the grouping file's status to `confirmed`, which Assetgrove never does itself. Registration pins the feet baseline and centre of mass to the anchor with one common scale, and refuses a family whose measured jitter exceeds the bound (1 px by default). Details are in [sheet-import.md](sheet-import.md).

## Style profile

Assetgrove is not tied to one visual style. The target profile's optional `style` (alpha mode, colour rule, edges) decides post-processing: soft 8-bit alpha and full colour for a painterly world, binary alpha, crisp edges or a palette for flat-cartoon and pixel-art worlds. Without a style, the sheet import uses soft alpha and full colour. `stage` post-processes still and strip candidates to binary alpha and the bible palette whatever the style says.

## Animation from an approved key pose

A strip starts from a key pose, and each frame is a reference-guided edit of it. A sprite-strip spec must name an author-approved `keyPose` and an `animationFamily`, and Assetgrove refuses a strip spec without them before any spend. To make one, stage a `still` of the pose, choose one of the staged candidates (or any author-made image), then stage the strip with that file as `keyPose`. The author approves the pose before any frame is edited, so frames inherit an identity a person has accepted.

## Picking

The person picks. `assetgrove stage` stages only QA-passing candidates with their reasons, and `assetgrove pick` writes the chosen one with the review field at the profile's pending value. Assetgrove never writes any other review value, because approval is human.

## Decision models for QA

Identity scoring uses a typed decision model. Other image checks do not:

- **Strips:** a whole cycle is generated as one sheet and checked with pixel QA, one vision check for identity flicker and a budgeted per-frame fix, so per-frame checks need no decision model.
- **Perspective:** perspective stays in the candidate's vision QA. That call costs a small fraction of a candidate, authors rely on its written reason, and there is no labelled perspective data to choose a decision model or cutoff from.
- **Identity flicker:** stays a vision check until enough labelled flicker data exists to choose a decision model for it.

## Identity lock scoring

Every candidate of a character with an identity lock is scored against its identity record by a typed decision model (a five-level Score question) through the gateway's `identity` route. The default model is `perplexity/pplx-decider-v1.2`, with `openai/gpt-6-luna-decisions` as the alternate; pplx is the more accurate of the two and costs a fraction as much. The default threshold of the `score` and `boolean` questions is 0.68, set where wrong-character crops stop passing on a labelled identity set. The threshold applies to the score, not to the model's confidence, because decision-model confidence sits between 0.5 and 0.8 even on correct answers; confidence is logged.

## Shadow mode is the identity default

Scoring runs in shadow mode by default: it records the score beside QA and filters nothing. Filtering (`identity.mode: "enforce"`) is opt-in per target profile, and the default stays shadow until a question meets the [identity lock bar](#identity-lock-bar). Enforce never applies to 3D characters ([3D identity results are provisional](#3d-identity-results-are-provisional)). Scoring never approves.

## No enforce mode for look-alike casts

Do not use enforce mode for a cast of look-alike characters. A lock with one reference can tell a character's kind from something else, but not one look-alike cast member from another: on a labelled look-alike set its scores separate them no better than chance, whichever decision or vision model answers.

## Identity records are checked against their references

In enforce mode, each identity record is first checked on the `identity-check` route: does its written signature agree with its own approved references? A record that disagrees is untrusted: its candidates are scored in shadow and never filtered until a person fixes the text or the references. A check that cannot run fails closed. Models trust the text, so a wrong record rejects the real character and accepts a look-alike.

## Identity lock bar

Enforce mode needs a measured bar: ROC AUC ≥ 0.95, false accepts ≤ 5% and false rejects ≤ 10% (`IDENTITY_ENFORCE_BAR`, reported by `identity-eval`). Every negative kind (drift, generic, look-alike) and every cast must meet it on 2D cases of trusted records, at a threshold fixed before the run. Only held-out cases count: positives and drift added after the prompt was last worded, never used to word it. No question meets the bar on held-out cases yet, so shadow mode stays the default, and enforce mode and the cast question are not recommended for a look-alike cast.

## Identity cast question: only what the animation implies is excused

`identity.question: "cast"` is opt-in. It judges a candidate as a choice among the whole cast (every identity record in the same bible) and also asks whether it is on-model for the subject against the subject's approved references, which win where the written record disagrees. The score is p(subject) × p(on-model). With no threshold in the profile, `cast` uses 0.5, the threshold it is measured at, because its score is a product of probabilities, not a rubric level, and `score` and `boolean` use 0.68. A threshold in the profile applies to whichever question runs. One call sends at most 16 images (`IDENTITY_CAST_MAX_IMAGES`), so a bible with more than 15 identity records is refused.

The on-model step excuses only what the pose and the named animation imply, and its wording names no species or cast:

- **Excused:** a back arched or hunched; a tail lowered, raised, swung or curled; a head turned, tilted or lowered; limbs bent, lifted, stretched out or overlapping; wings spread or folded; eyes closed in a blink; a crest or ears swept by motion; a body that looks deeper or shorter-legged because the legs bend or it turns; parts hidden or foreshortened by the view; background between the limbs. A held prop or food, or an open mouth, is excused only when the named animation implies it (eating, carrying, calling). The model lists these as `poseDifferences`, which never lower the score.
- **Deviations:** a region in a different hue, or clearly lighter, darker or more muted as if repainted (shading and lighting are not a colour change); a marking missing, added or moved; a see-through hole; a different count of repeated marks on a part fully in view; proportions the pose does not produce; a signature feature missing, added or changed.
- **Stretch:** a pose bends the body at the spine and joints but never rescales the figure. A whole body, or a rigid part such as the head, an eye or a beak, longer or shorter in one direction than the references show is a stretch, however the figure is tilted.

Animation posture is not drift, while a change of hue, marking or proportion is. A body stretched about 1.3× in a strongly posed frame can still pass.

## Characters are real-time 3D

Characters are rigged real-time 3D models with an animation clip per family. Zoom, lighting and camera come from the game's renderer, and a new animation is a clip on the same rig rather than new art. The 2D path (sheet generation and import, the transformation core, loop QA, identity lock) serves props, terrain, effects, UI and targets that use sprites.

## Missing clips are reported, not faked

Without a skeleton template, a character uses the provider's auto-rig and its clip library, retargeted per family. A family the library has no close clip for is reported as missing. It is never faked, and the candidate is not refused for it.

## Shared rig and generated gait

Characters of one kind can share a skeleton template fitted to each model, with locomotion generated from a gait profile the target declares. QA checks foot contact, joint limits and skinning. For any kind whose target declares a template, this replaces the provider's auto-rig and clip library, because a provider's library walk does not move the way each species moves.

## `lookdev-markings` is advisory

`lookdev-markings` runs and records every measurement, but it never filters a look-dev candidate, and a drift does not make the run exit 5. Its reason is marked `shadow` and starts by saying the check is advisory and why; the run summary shows its verdict as "not filtered". The check measures each marking in boxes a vision model draws, and on the same code it names a different set of drifting markings on each run, so it cannot make a pass or fail call. It filters only once repeated measurements on the same renders name the same drifting markings, which takes stable boxes, not a looser threshold. A person judges the compare images.

## 3D identity results are provisional

`identity-eval` reports 3D cases apart and marks them provisional: no threshold or bar rests on them. Identity never filters a 3D character (`stage` of a `character-3d` spec, `look-dev`), because no question separates lit renders of the right character from their drift. With `enforce`, a 3D character is scored in shadow mode, its reason says why, and no record check runs.

## Licence of generated output

Assetgrove writes the licence the target profile declares and records the models, route and provider terms in provenance.

## Provider output grants

Provider terms differ on who owns an output, so each route declares its `outputGrant` (`license`, `plan`, `commercial`, `relabel`, `attribution`), every call records it, and the provenance carries the most restrictive combination over its calls. The provenance's `license` is the target's licence only when the grant allows relabelling; otherwise it is the granted licence, when that licence is commercial and the target lists it in `acceptedLicenses`. Anything else is refused at hand-off (`pick`, `write-families`) with exit 7 (`license_refused`) before a file is written. Staging is unaffected, so free-credit trials that never reach a target still run.

## Settings are validated with zod; command inputs stay JSON Schema

The developer settings file is validated with zod, which is a direct dependency pinned to the version `ai` already brings in. Its strict objects refuse unknown fields at every level and report every issue together with its path. Command input schemas stay JSON Schema, because they are the published contract that the skill reference and MCP clients read.

## The tracked-key scan is hand-written

The tracked-key guard (`src/guard.ts`) reads `git ls-files -z --cached`, reads each tracked file's staged blob and its working-tree content, skips Git LFS pointers and files over 4 MB, and refuses (exit 2 `key_tracked`, naming the file and never the value) a tracked file that holds the exact value, 16 characters or more, of a configured key variable, or that assigns a non-empty value to one by name: `NAME=value` or `export NAME=value` at the start of a line, a JSON member `"NAME": "value"`, or a YAML member `NAME: value` in a `.yml` or `.yaml` file. An empty value, a variable reference (`$NAME`, `${...}`, `${{ ... }}`) and a placeholder (`...`, `<your key>`) do not count. The configured key variables are the adapters' defaults (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TRIPO_API_KEY`) and every `keyEnv` in the settings. It runs at MCP server start and at each paid command's start against the working directory's repository, and on the `pick` and `write-families` target's repository. With no `.git` entry at or above the directory, nothing is tracked and the guard passes; inside one, a git that cannot list or read the tracked files (missing, or refusing the checkout as unsafe) is a `key_tracked` refusal naming the git step, never a pass.

It is hand-written because no library fits: secret scanners such as gitleaks and TruffleHog are native binaries this repository avoids, and they detect keys by pattern and entropy rather than by the configured variable names and the values in this process's environment, which is what the rule checks. The scan is a short loop over the Git index with three regular expressions per name.

`redact(text)` (`src/redact.ts`) replaces each configured key variable's value (8 characters or more) with `[redacted:<ENV>]` and masks Authorization, Bearer, `Key <token>` and x-api-key values. It runs in `ProviderError`, the result builder (`classify`, `refusal`, `resultDocument`) and the log each command is given.

## Shared files carry a format line; migrate adds it

Shared files travel between developers and between Assetgrove versions, so a loader refuses or upgrades a file instead of misreading it. Each carries `format: "assetgrove-<kind>/<n>"` as its first field: `assetgrove-target-profile/1`, `assetgrove-style-bible/1` (the JSON bible and the front matter of `BIBLE.md`), `assetgrove-style-preset/1` and `assetgrove-recipe/1`. `readFormat` exits 2 with `format_unsupported` and a reason: `missing` (the message names the line to add), `too_new`, or `unknown` for an unrecognised or mismatched line. An older version migrates in memory. `assetgrove migrate <file> --kind <kind>` adds the line to an unversioned file and moves an older one forward; a current file is reported and not written. Loaders still refuse unversioned files, so a file is never changed by reading it. Specs, briefs, groupings and other request inputs are written per request and carry no format line.

The target profile is validated with zod for its top-level fields, so an unknown field or a wrong type is invalid input rather than silently ignored.

A bible that lists references requires `referenceLicense` (an SPDX identifier, `LicenseRef-*` or `NOASSERTION`, checked as non-empty text), and a reference may set its own `license`. Provenance records `referenceLicenses`, each the reference's own licence or the bible's. They record terms and gate nothing, because Assetgrove cannot know whether a stated licence is true.

Reference paths in shared files must resolve, with symlinks resolved, inside the project root: the nearest ancestor of the bible's directory holding `.git` or `.assetgrove`, else the bible's own directory. The walk stops below the home directory, which is never a project root (as in settings), so a dotfiles repository at the home directory does not open every file under it; a bible with no project marker may reference only files beside or below it. A shared file from another developer cannot then make Assetgrove read or send an image from elsewhere on the machine; the refusal is invalid input before any provider call.

## Record paths use /; case-only collisions are refused

Assetgrove runs on Linux, macOS and Windows, and its records and JSON output travel between them. `src/paths.ts` is the one place paths take record form: a relative path in a record (a run's candidate files and artifacts, a pick's `files`) or in JSON output uses `/`, whatever the OS separator is, and readers accept `/` only (node:path takes `/` on Windows too). Absolute paths, such as a pick's `target` or a command's `runDir`, stay in the OS's own form.

Before a hand-off writes anything, its write set (media, manifest, sidecars, provenance) is checked: two paths that differ only by case, or a path segment with `:` in it, exit 2 `invalid_input` with nothing written, on every OS. A case-insensitive file system (macOS and Windows by default) would let the second write replace the first, and Windows refuses `:` in a file name. Files already in the target are not compared. Run IDs, and so run directories, replace the `:` of their timestamp with `-`.

Long paths need no code: on Windows, node:fs turns every absolute path into its `\\?\` form, so Assetgrove's own file I/O works past 260 characters. A target's validator is the target's own process and inherits whatever limits its program has.
