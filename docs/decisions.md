# Decisions

This file lists the decisions in force in Assetgrove and the reason for each.

## Language and tooling

Assetgrove is TypeScript on Node 24, managed with pnpm. Node runs the `.ts` sources directly with its built-in type stripping, so development has no build step, the code uses erasable syntax only (no enums, namespaces or parameter properties), and imports name their `.ts` files. A game that already uses Node, pnpm and TypeScript runs Assetgrove with no new runtime.

- **pnpm** is pinned through `packageManager` and enabled with corepack. CI installs with `pnpm install --frozen-lockfile --ignore-scripts`, so no dependency may need an install script.
- **Commands:** `pnpm check` runs Prettier, ESLint (typescript-eslint) and `tsc --noEmit`. `pnpm test` runs `node:test` over `test/**/*.test.ts`, offline, with the scripted provider. `pnpm test:real` runs the opt-in real-provider checks in `test/real/`, which skip without their keys (`AI_GATEWAY_API_KEY`, `TRIPO_API_KEY`).
- **Runtime dependencies:** `ai` (the Vercel AI SDK, imported only by `src/gateway/vercel.ts`) with `@ai-sdk/anthropic`, `@ai-sdk/openai` and `@ai-sdk/openai-compatible` (its provider packages), `zod` (settings and format validation), `jsonc-parser` (JSONC), `pngjs` and `jpeg-js` (pure-JavaScript image codecs), `yaml` (the bible's front matter), `@modelcontextprotocol/server` (the MCP server), `gltf-validator` (the Khronos glTF validator in 3D QA), `meshoptimizer` (mesh simplification for detail levels), and for C2PA content credentials `@contentauth/c2pa-wasm`, `@auth0/cose`, `pkijs` and `asn1js` ([below](#c2pa-content-credentials-on-the-cais-webassembly-sdk)).
- **TypeScript** stays on 6.0, the newest version typescript-eslint supports.

## Release-age exclusion for the `ai` SDK

`pnpm-workspace.yaml` lists `ai@7.0.173`, its three `@ai-sdk/*` packages and the three provider packages of the direct routes (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible`), at exact versions, under `minimumReleaseAgeExclude`. pnpm's default release-age policy refuses versions published too recently, and the adapters are written and checked against these releases. The exclusion names exact versions only, so any other version, including a later update, still waits out the window. Once these versions are older than the window, the exclusion can go; `pnpm install` must then leave the lockfile unchanged.

## Packaging

The package is `@clockgrove/assetgrove`. It ships compiled JavaScript, because Node refuses to strip types inside `node_modules`.

- `tsc -p tsconfig.build.json` builds `dist/`, with `rewriteRelativeImportExtensions` turning `.ts` imports into `.js`. The repository itself runs the sources directly.
- The package ships `package.json`, the README, the LICENSE, `dist/`, `skills/` and `policy/` (the prompt-policy data), and nothing else; `test/package.test.ts` checks the `npm pack --dry-run --json` listing.
- The version is `0.1.0`, the Phase 1 release candidate.
- The package must install and run from its tarball on every system. `test/package.test.ts` packs this checkout, or installs the tarball `ASSETGROVE_TEST_TARBALL` names, and runs the installed `assetgrove --help --json`, `--version`, the extension API and a dry-run `stage`.
- The release workflow is dispatch only. It packs once, records the tarball's sha256, runs `npm publish --dry-run`, refuses a version or tag that already exists, attests the tarball, verifies it on Linux, macOS and Windows and uploads the tarball, its hash and its attestation. Publishing waits for the owner's approval and runs only for a package already on the registry, so the first publish (0.1.0) is the owner's manual step in [release.md](release.md).

## CLI contract

Every command follows one contract, so scripts and agents can drive Assetgrove without parsing prose.

- With `--json`, stdout is one JSON document: `ok`, `exitCode`, `command` and, on refusal, `error` with `code` and `message`. Logs go to stderr. A command prompts only when stdin and stderr are a terminal.
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
- `--provider-script` gives the developer settings' `scripted` provider its module, for offline runs; when no route names a scripted provider, the first call exits 2 `invalid_input` before any spend, so the script is never silently ignored.

## MCP server on the official SDK

`assetgrove mcp` is served by the official TypeScript MCP SDK, `@modelcontextprotocol/server` 2.4.0 (Apache-2.0), over its stdio transport. The SDK negotiates the protocol revision, where hand-written protocol code would fall behind the protocol. It brings `@modelcontextprotocol/core` 2.4.0 (Apache-2.0) and `zod` (MIT); none of them has an install script, and 2.4.0 needs no release-age exclusion. Each tool's input schema is derived from its command's JSON Schema input by `toolInputSchema` (src/commands/runner.ts): it drops the CLI-only properties (`providerScript`, `dryRun`, `routes`) and the help `placeholder` keyword, and allows no other property. It is wrapped with the SDK's `fromJsonSchema`, and `tools/list` advertises it as derived. The SDK's own argument check is a pass-through: the tool handler validates the arguments against the same schema, so a bad argument comes back as the CLI's `invalid_input` result document with `isError` set, not as a protocol error.

## Generation constitutions

Art direction lives in a target-owned Markdown bible with validated YAML front matter, prose rationale, and Do's and Don'ts. Palette, outline, lighting, fog, saturation and value bounds use DTCG 2025.10 typed tokens; art-specific axes stay in the art schema. The JSON profile, spec and recipe formats stay JSON, and `yaml` is pinned to 2.9.1 because the bible format requires YAML.

The target owns an Agent Skill that links the bible and starting presets. DESIGN.md contributes UI colour context only; Assetgrove does not extend its format with art direction. Prompt templates are copied into the target repository on explicit initialization (`assetgrove init`) and versioned there. `plan` records the compilation and model inputs; `apply` checks their hashes and authorizes generation spend without approving an asset.

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

## Model-backed checks advisory at 0.1

A model-backed QA check can give different answers on the same input, so it filters only where it is measured stable. Each check declares whether it is model-backed (`src/qa/stability.ts`), and `src/qa/stability.json` holds measured entries `{checkId, version, model, cases, repeats, agreement, measuredAt}`. A model-backed check filters only with an entry for its id, its version and the model its route resolves to on the run, with `cases >= 30`, `repeats >= 3` and `agreement >= 0.95`. Otherwise its reasons are advisory: marked `shadow`, recorded beside QA and shown as "not filtered", never used to filter or to fail a run. The result says why in `filtering: [{check, state: "filtering" | "advisory", cause?: "no-entry" | "model-differs"}]`: `no-entry` when no qualifying entry exists for the check's id and version, `model-differs` when one exists only for another model. So a run on a model other than the default turns filtering off for every check measured only on the default.

These model-backed checks are advisory at 0.1, with no qualifying entry on the core default vision model. A test fails on a model-backed check with neither such an entry nor a place in this list; a check leaves it once its measured entry lands.

```json
[
  "transparency",
  "frame-count",
  "identity",
  "perspective",
  "identity-flicker",
  "holes",
  "lookdev-markings",
  "style-score",
  "flat-albedo",
  "normal-orientation",
  "emissive-placement",
  "dusk-rain",
  "night",
  "audit-style",
  "audit-identity"
]
```

`transparency`, `frame-count`, `identity` and `perspective` are the vision verdict's checks of a still or strip; the deterministic `transparency` and `frame-count` checks of the same names always filter. `identity-flicker` and `holes` are animation QA's vision checks. `lookdev-markings` measures each marking in boxes a vision model draws, and on the same code it names a different set of drifting markings on each run; while advisory, its reason starts by saying so, and a person judges the compare images. `style-score` is a planned run's vision verdict on each candidate (`apply`): while advisory, a candidate below the strictness is kept, its reason marked `shadow`. `flat-albedo`, `normal-orientation`, `emissive-placement`, `dusk-rain` and `night` are the material pipeline's lit checks (`materials`): while advisory, a failing lit verdict is recorded in `materials.json` but no longer fails the maps. `audit-style` and `audit-identity` are the set-level audit's style and identity scores (`audit`): they never filter or reject, and while advisory each score in `audit.json` says `advisory: true`.

## 3D identity results are provisional

`identity-eval` reports 3D cases apart and marks them provisional: no threshold or bar rests on them. Identity never filters a 3D character (`stage` of a `character-3d` spec, `look-dev`), because no question separates lit renders of the right character from their drift. With `enforce`, a 3D character is scored in shadow mode, its reason says why, and no record check runs.

## Licence of generated output

Assetgrove writes the licence the target profile declares and records the models, route and provider terms in provenance.

## Routes come only from developer settings; grants belong to provider and model

Which provider and model serve an operation decides what is spent and what the output may become, so routes come only from the developer settings: `routes.<operation>` over `roles.<role>` over the configured adapters' default routes. Shared files, run options and plans carry no route, and there is no routes file or `--routes` option. A route must name a configured provider whose adapter has the role's capability, or the command exits 2 `route_unavailable` before any reservation. An output grant and provider terms describe one (provider, model) pair, so an override that changes either carries only the grant and terms it declares itself. A `ProviderSet` built from the settings serves each call on its route's provider, and the call records its route as `<providerId>:<operation>:<model>`. The direct routes use the AI SDK's own provider packages, pinned exactly: the `anthropic` adapter `@ai-sdk/anthropic` 4.0.105, the `openai` adapter `@ai-sdk/openai` 4.0.118 and the `openai-compatible` adapter `@ai-sdk/openai-compatible` 3.0.92, all Apache-2.0 like `ai` and on the same `@ai-sdk/provider` 4.0.38 and `@ai-sdk/provider-utils` 5.0.81 (Apache-2.0); none has an install script. Each is given its key and its endpoint explicitly, so no `*_BASE_URL` variable applies. Typed decisions on these routes go through the SDK's structured output (`Output.object`), and the call's `decision.decisionSource` says so (`structured-output`, where the gateway's decision models record `decision-model`).

## Provider output grants

Provider terms differ on who owns an output, so each route declares its `outputGrant` (`license`, `plan`, `commercial`, `relabel`, `attribution`), every call records it, and the provenance carries the most restrictive combination over its calls. No grant, no hand-off: a provenance with a call that records no grant is refused at `pick` and `write-families` with exit 7 (`license_refused`), naming the call's route and the settings field (`routes.<operation>.outputGrant` or `roles.<role>.outputGrant`) that declares it. Core defaults carry the grant their terms give, or none. The provenance's `license` is the target's licence only when the grant allows relabelling; otherwise it is the granted licence, when that licence is commercial and the target lists it in `acceptedLicenses`. Anything else is refused at hand-off (`pick`, `write-families`) with exit 7 (`license_refused`) before a file is written. Staging is unaffected, so free-credit trials that never reach a target still run.

## Settings are validated with zod; command inputs stay JSON Schema

The developer settings file is validated with zod, which is a direct dependency pinned to the version `ai` already brings in. Its strict objects refuse unknown fields at every level and report every issue together with its path. Command input schemas stay JSON Schema, because they are the published contract that the skill reference and MCP clients read.

## Settings changes are written with jsonc-parser

`settings change` (src/settings-write.ts) edits the developer settings in place with `jsonc-parser` 3.3.1 (MIT, Microsoft; no install script, no dependencies). Its `modify` and `applyEdits` change one JSON path at a time; the edit is made without `modify`'s own formatting (which re-lays out the whole line an edit starts on) and only the formatter's changes inside the new span are kept, so every other byte stays as it was, which a person confirming a cap needs: the file they wrote by hand keeps its layout and every field they did not confirm. Parsing with `JSON.parse` and writing back with `JSON.stringify` would rewrite the whole file. The `yaml` library already here reads JSON, but it writes JSON back in its own layout.

## The tracked-key scan is hand-written

The tracked-key guard (`src/guard.ts`) reads `git ls-files -z --cached`, reads each tracked file's staged blob and its working-tree content, skips Git LFS pointers and files over 4 MB, and refuses (exit 2 `key_tracked`, naming the file and never the value) a tracked file that holds the exact value, 16 characters or more, of a configured key variable, or that assigns a non-empty value to one by name: `NAME=value` or `export NAME=value` at the start of a line, a JSON member `"NAME": "value"`, or a YAML member `NAME: value` in a `.yml` or `.yaml` file. An empty value, a variable reference (`$NAME`, `${...}`, `${{ ... }}`) and a placeholder (`...`, `<your key>`) do not count. The configured key variables are the adapters' defaults (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TRIPO_API_KEY`) and every `keyEnv` in the settings. It runs at MCP server start and at each paid command's start against the working directory's repository, and on the `pick` and `write-families` target's repository. With no `.git` entry at or above the directory, nothing is tracked and the guard passes; inside one, a git that cannot list or read the tracked files (missing, or refusing the checkout as unsafe) is a `key_tracked` refusal naming the git step, never a pass.

It is hand-written because no library fits: secret scanners such as gitleaks and TruffleHog are native binaries this repository avoids, and they detect keys by pattern and entropy rather than by the configured variable names and the values in this process's environment, which is what the rule checks. The scan is a short loop over the Git index with three regular expressions per name.

`redact(text)` (`src/redact.ts`) replaces each configured key variable's value (8 characters or more) with `[redacted:<ENV>]` and masks Authorization, Bearer, `Key <token>` and x-api-key values. The configured key variables are the adapters' defaults and every provider's `keyEnv`, registered when the run context is made, so redaction never depends on the tracked-key guard having run. It runs in `ProviderError`, the result builder (`classify`, `refusal`, `resultDocument`), the log each command is given, and the output of a validator or material command.

## Shared files carry a format line; migrate adds it

Shared files travel between developers and between Assetgrove versions, so a loader refuses or upgrades a file instead of misreading it. Each carries `format: "assetgrove-<kind>/<n>"` as its first field: `assetgrove-target-profile/2`, `assetgrove-style-bible/1` (the JSON bible and the front matter of `BIBLE.md`), `assetgrove-style-preset/1` and `assetgrove-recipe/1`. `readFormat` exits 2 with `format_unsupported` and a reason: `missing` (the message names the line to add), `too_new`, or `unknown` for an unrecognised or mismatched line. An older version migrates in memory. `assetgrove migrate <file> --kind <kind>` adds the line to an unversioned file and moves an older one forward; a current file is reported and not written. Loaders still refuse unversioned files, so a file is never changed by reading it. Specs, briefs, groupings and other request inputs are written per request and carry no format line.

The target profile is validated with zod for its top-level fields, so an unknown field or a wrong type is invalid input rather than silently ignored.

A bible that lists references requires `referenceLicense` (an SPDX identifier, `LicenseRef-*` or `NOASSERTION`, checked as non-empty text), and a reference may set its own `license`. Provenance records `referenceLicenses`, each the reference's own licence or the bible's. They record terms and gate nothing, because Assetgrove cannot know whether a stated licence is true.

Reference paths in shared files must resolve, with symlinks resolved, inside the project root: the nearest ancestor of the bible's directory holding `.git` or `.assetgrove`, else the bible's own directory. The walk stops below the home directory, which is never a project root (as in settings), so a dotfiles repository at the home directory does not open every file under it; a bible with no project marker may reference only files beside or below it. A shared file from another developer cannot then make Assetgrove read or send an image from elsewhere on the machine; the refusal is invalid input before any provider call.

## Record paths use /; case-only collisions are refused

Runs, targets and shared files move between Linux, macOS and Windows, so relative paths in records and JSON output use `/` on every OS, and readers accept `/` only: `pick` refuses a staged record path that holds `\` as invalid input. `src/paths.ts` holds the rules. Before a hand-off or a staged candidate (from `stage`, `lod`, `look-dev` or `rig`) writes anything, its whole write set is checked; look-dev's per-view renders, whose names Assetgrove fixes, are written as each view finishes and are checked with the candidate's set before it is staged. Two paths that differ only by case would be one file on a case-insensitive file system, so they are refused with exit 2 `invalid_input` on every OS. So is a path segment that holds `:`, which names an alternate data stream on Windows. No file Assetgrove writes has `:` in its name, and run IDs replace it. Long paths need no wrapper: on Windows, Node's fs namespaces absolute paths itself, so Assetgrove's own file I/O works past 260 characters. A target's validator is the target's process, and Windows cannot start a process in a working directory past that length.

## Real checks share one 25 USD budget

Real-provider checks cost money, so each one runs through Assetgrove's own spend controls under one fixed total of 25 USD: 15 USD for CI runs, 8 USD for local runs and 2 USD held in reserve. `test/real/budget.ts` writes temporary developer settings. Their `stateDir` is a persistent ledger directory: `ASSETGROVE_REAL_LEDGER` when set (a CI cache entry), else `<state home>/assetgrove/real-checks/<leg>`. Their `caps.workItemUsd` and `caps.dailyUsd` are the leg's share, and `caps.runUsd` is 1.50 USD. One `pnpm test:real` invocation is one run: it runs every check in one process (`--test-isolation=none`), and the 1.50 USD run cap bounds the spend of all its checks together, counted in the ledger from the invocation's first check. The core paid providers declare a `key-budget` limit of the same share. The leg is `ci` when `CI` is set, else `local`. Every real check imports that module and calls through the product (`Caller`, `Budget` and the spend ledger) under the work item `real-checks`. Because the ledger persists, the remainder under the work-item cap is the budget left. Before any call, a check forecasts its spend, and a forecast above what is left of the run cap or the budget left is refused (exit-3 family) before a provider is reached. `test/real/routes.real.ts` calls each configured core route once. A route whose key is unset, or whose adapter this build lacks, skips with the reason. `pnpm test:real` is the one command, and with no keys every check skips and it exits 0.

## Command approvals are hashed relative to the Git top level; shims are refused

A shared file must never make Assetgrove run code a person did not approve. The gated commands are a target profile's `validator`, its style's `material-compression` and `material-preview` commands, and the CLI's `--provider-script` test seam (kind `provider-script`). There is no material encode operation, so a recipe cannot run a command.

`commandHash` (`src/approvals.ts`) is the sha256 hex of the canonical JSON `{kind, argv, cwd, files}`: `argv` is the template before placeholders are filled; `cwd` is the directory the command runs in (the target directory for a validator, the profile's directory for material commands, the module's directory for a provider script), relative to its Git top level (the nearest ancestor holding a `.git` entry), with `/`, or absolute outside a repository; `files` maps each argv element that names a regular file under `cwd` (or the provider-script module) to its sha256. So one repository checked out at two paths gives one hash, and changing argv, a named file or the kind gives another. The canonical form is `JSON.stringify` of that fixed-shape object with `files` sorted by path; no canonical-JSON library is needed for four fields of strings.

A gated command runs only when its hash is in `settings.commands.approved` (method `settings`) or a record at `<configDir>/approvals/<hex>.json` names it and lists the command's project in `roots` (that record's method: `tty`, `elicitation` or `terminal`). The project is the real path of the cwd's Git top level, or of the cwd outside one; it is not in the hash, so another checkout asks once and its accept adds its project to the record, while a command that names no file (`npm run validate`) approved in one project is asked again in another. Otherwise a CLI on a TTY asks inline and writes the record (method `tty`); with no one to ask, the request is saved to `<stateDir>/pending/<hex>.json` and the command exits 8 `confirmation_required` with `error.confirmation = {kind: "command", id, summary, confirmCommand, command: {kind, hash, argv, cwd, files, root}}`; `assetgrove confirm <hex>` (CLI only, exit 2 without a TTY) approves it (method `terminal`). Headless settings honour only `commands.approved`. Approval is checked before anything is written (pick, write-families) or any model is called (materials, the provider script before its module loads). Provenance records each command step as `{kind, hash, method}` in `commands`. Over MCP, a client that declares form elicitation is asked in a form (kind `command`) and an accept writes the record with method `elicitation`; a client without it gets exit 8 the same way.

Commands never run through a shell. A gated command starts with every key variable removed from its environment. On Windows a bare `argv[0]` is resolved through PATH and PATHEXT only, never the cwd, whose program no hash covers: one found only in the cwd exits 2 `command_refused`. A `.cmd` or `.bat` result exits 2 `command_refused`, telling the developer to name the program itself (`node <script>`): such a shim runs through `cmd.exe`, whose argument parsing a profile could exploit.

## Every paid command has a free plan step; its request digest names the run

Confirmation, the run journal, estimates and the gate need to know what a request will do and cost before anything is spent. So `plan`, `apply`, `stage`, `generate-sheet`, `import`, `materials`, `look-dev`, `animation-qa`, `fix-frame`, `identity-eval` and `identity-check` each have a plan step (`CommandSpec.plan`) that makes no provider call, adds no ledger entry and writes nothing. It returns a WorkPlan (`src/runs/plan.ts`): the jobs (operation, provider, model, count and the route's per-call estimate) covering every call the request can make, merged by operation, provider, model and estimate; `forecastUsd`, their sum; the cap; `paid`, whether a job's provider bills; `inputs`, the sha256 of each input file (a directory hashes to the sha256 of the canonical JSON of its files' relative paths and hashes); `options`, every other argument with the schema's defaults, except the provider script, the work item, the round, the dry-run flag and the runs directory; the digest; and the run directory. `plan` forecasts its compiler call (always, as an upper bound) plus every job the later `apply` runs. Each plan step also runs the prompt policy's blocklist on the request's prompt text, and `policyTextSha256` is the sha256 of that normalised text. When the request carries prompt text, the plan also holds one `prompt-policy` job on the decisions role, so the forecast and the digest count the model check that runs first after confirmation.

The digest is the sha256 hex of the canonical JSON of `{command, round, inputs, options, jobs, forecastUsd, capUsd, policyTextSha256}`: `JSON.stringify` with object keys sorted and undefined values left out (`canonicalJson`). It is hand-written: the digest must be byte-for-byte deterministic, the values are plain JSON built here (strings, finite numbers, booleans, arrays and objects), for which sorted keys and the ECMAScript number form are what RFC 8785 prescribes, and a dependency for a dozen lines is not worth its maintenance. The run directory is `<runs>/r-<first 16 hex>/` (`--runs`, default `.assetgrove/runs`; `apply`'s is `--out`). Before a real run the runner creates it and writes the WorkPlan to `request.json`; `stage`, `apply` and `look-dev` stage their run there and their `run.json` names it (`runDir`); for the other commands the runner writes a small `run.json` (run id, directory, command, digest, times, `ok`, exit code, error code, spend). Command outputs stay where they were written before. The same request run again uses the same directory (see the next section). `--dry-run` prints the WorkPlan's fields beside each command's own plan detail (`plan`) and the ledger's spend; `estimate {command, args}` returns the same document.

## Paid runs resume from their journal and never pay twice

A dropped connection or a killed process must not lose paid work or pay for it again. Every paid command's real run goes through the executor (`src/runs/execute.ts`), in the process that received the request; there is no detached process. After the plan step it creates the run directory, writes `request.json`, and takes `lock`: an exclusive create (a private file linked as `lock`, so it is never seen empty) holding the pid and what tells its process apart from a later one with the same pid: on Linux the boot ID and the process's start in that boot, elsewhere the holder's start time. A lock whose holder is alive (this process's own while it holds that lock; a lock naming this pid that this process never took was left by a dead namesake; a lock from an earlier boot, or whose live pid started at another time, is dead) exits 2 `run_in_progress`, naming the lock file to remove if that process is not running the request; a dead or unreadable holder's lock is taken over by exactly one process: the one that creates `lock.takeover` exclusively removes the dead lock and creates `lock` exclusively again, and every other claimant is refused. `state.json` records `{runId, command, digest, status, pid, startedAt, finishedAt, exitCode, attempts}` and, for a run that ended with exit 0, its outcome.

A run that finished with exit 0 is returned as it ended, with `reused: true`: no provider call, no ledger entry. Any other ending (a refusal, a provider error, a killed process) leaves the run resumable: repeating the request runs the command again, and every call it already had answered is answered from the journal. `--round` is part of the digest, so a new round is a new run. Every executed run's result carries `runId`, `runDir`, `digest` and `reused`.

The journal is `calls/<callKey>.json` with each result's bytes beside it as `calls/<sha256>.bin`. The callKey is the sha256 hex of the canonical JSON of the call's operation, provider, model, prompt, reference hashes, seed and candidate index; an identical later call in the same run also counts how many came before it, so two seedless calls with one prompt keep separate records. The `Caller` (`src/calls.ts`) finds the run's journal through `AsyncLocalStorage`, so no command threads it through. It checks the journal before it reserves: a hit reserves nothing, counts its recorded cost against the run's cap, and returns the stored result; an answered call is written (media first, each file whole by rename) before it is returned. A failed call is not journaled and is made again.

Ledger reservations name `provider`, `runId` and `callKey`. A reservation a killed call left unsettled keeps its estimate for good: the provider may have billed that call and none confirms or reuses it. The retry is another provider call and makes its own reservation, dated now and checked against the limits as they are now; no reservation is ever reused, so every call that reached a provider is counted once, whichever runs directory or process made it. A resumed run's forecast check asks the ledger only for the part of the forecast its journal does not already hold.

While an MCP client is connected, a tool call that carries a `progressToken` gets `notifications/progress` through the official SDK: one when the run starts, one per call answered (`progress` the calls answered, `total` the WorkPlan's call count) and one for each job that had none by the end. If the client drops, the run goes on until it ends or the server stops. `runs list` and `runs show` (tools `runs_list`, `runs_show`) read the runs directory.

A request's digest covers its input files' bytes, including the files a material profile's compression and preview commands name (wherever they are; only a program named by an absolute path or found on the PATH, the interpreter, is left out) and the source images a material derivation names (`maps[channel].path`, `lightSources[].mask`), but not the settings: a route's changed grant or a provider script's changed answer is the same request. Ask for a new round to run it again.

## The image XMP writer stays hand-written

The marking module (`src/metadata.ts`) writes the IPTC digital source type, and the model names in IPTC's `AISystemUsed`, into PNG (`iTXt`), JPEG (APP1) and WebP (`XMP ` chunk) with its own XMP writer. The prompt is never written. I looked for a maintained library that writes XMP into those three formats without native code: `exiftool-vendored` and the `exiftool` it wraps are a Perl program shipped as a vendored binary, and the other XMP libraries read packets or write only into one format. A native binary at run time is what this repository avoids, and the output must be byte-for-byte stable so that marking a marked file again leaves it unchanged, which a process that rewrites whole files does not promise. `exiftool-vendored` is therefore a devDependency only: the tests read the marks back through it, independently of the writer. glTF and GLB go through `KHR_xmp_json_ld`, and KTX2 through a key-value entry (design section 6).

### Which reader checks each format, and why

| Format          | Written by                                                                                                         | Read back in tests by                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| PNG, JPEG, WebP | the XMP writer in `src/metadata.ts`                                                                                | `exiftool-vendored`                                                   |
| glTF, GLB       | `KHR_xmp_json_ld` in the document's JSON (the model names go in `Iptc4xmpExt:AISystemUsed` beside the source type) | Khronos `gltf-validator` (it must accept the file) and the JSON chunk |
| KTX2            | `ktx-parse`: the IPTC XMP packet under the key-value entry `XMP`                                                   | `ktx-parse`                                                           |

KTX2 has no second reader: no other maintained KTX2 reader exists in Node without a native binary (`@gltf-transform/extensions` reads KTX2 through the same `ktx-parse`; the KTX-Software tools are native programs). So the entry is written and read by `ktx-parse` and the test also checks that the level data survives.

`@gltf-transform/extensions` stays a devDependency and does not write the glTF mark. Its `KHRXMP` extension works on a whole `Document` through the async `WebIO`, which rewrites the file (accessors, buffers, names) and does not promise that marking a marked file leaves it unchanged; the document-level `KHR_xmp_json_ld` packet is small, and the existing JSON-level writer produces exactly the extension the specification defines, which the Khronos validator accepts.

`ktx-parse` 1.1.0 writes each key-value entry's length through `new Uint8Array(Uint32Array)`, which keeps only the low byte, so an entry of 256 bytes or more reads back corrupt (the XMP packet is longer than that). `writeKtx2Container` in `src/metadata.ts` writes with `ktx-parse` and then sets each entry's true length; the reader is correct. Remove it when `ktx-parse` fixes the writer. `ktx-parse` is a direct dependency, at the version the lockfile already held through `@gltf-transform/extensions`.

C2PA content credentials are written beside these marks, by the CAI's SDK ([below](#c2pa-content-credentials-on-the-cais-webassembly-sdk)).

## C2PA content credentials on the CAI's WebAssembly SDK

Owner decision 2026-11-14: content credentials are part of Phase 2. Hand-off signs a C2PA manifest into every PNG, JPEG and WebP it writes, and its mark check reads each one back (`src/credentials.ts`; [disclosure.md](disclosure.md#content-credentials)).

- **SDK: `@contentauth/c2pa-wasm`** (0.15.0, c2pa-rs 0.92.0), the Content Authenticity Initiative's own build of c2pa-rs for JavaScript. It builds the manifest, writes the JUMBF into the file, and reads and validates it. I looked first at the official Node SDK, `@contentauth/c2pa-node`: it downloads a native binary in a `postinstall` script, and CI installs with `--ignore-scripts`, so it would not run there; the WebAssembly build has no install script and no native binary. `@contentauth/c2pa-web` wraps the same WebAssembly for browsers through a Web Worker; Assetgrove uses the bindings directly.
- **COSE: `@auth0/cose`.** The WebAssembly signer callback must return a whole COSE_Sign1 (c2pa-wasm fixes `direct_cose_handling` to true and passes no certificate chain), so `@auth0/cose` signs the claim with the key and puts the x5chain in the protected header. Assetgrove then re-encodes that COSE_Sign1 with the payload detached (C2PA carries the claim beside it) and a `pad` header that fills the space the SDK reserved; it writes no CBOR or COSE encoding of its own. `@auth0/cose` encodes through `cbor-x`, whose optional dependency `cbor-extract` ships prebuilt native addons and an `install` script; cbor-x works without it on its JavaScript decoder. So `src/pure-cbor.ts`, imported before `@auth0/cose`, sets `CBOR_NATIVE_ACCELERATION_DISABLED`, and Assetgrove never loads the addon. The exception: pnpm still installs the optional package (an install script is skipped under `--ignore-scripts`, and the prebuilt addon then sits unused); removing it from the install would take a `pnpm-workspace.yaml` override, which this change does not make.
- **A shim:** the SDK reads its input through the browser's `FileReaderSync`, which Node lacks; `src/credentials.ts` supplies one that reads only in-memory bytes.
- **Development certificate: `pkijs`** (with `asn1js`) creates a development CA and a signer certificate (ECDSA P-256; c2pa-rs refuses a self-signed signer) under `<stateDir>/content-credentials/` when the developer settings name none. No C2PA trust list holds it; readers report the signature valid and the credential untrusted. A certificate from a C2PA-recognised authority is the owner's step before 1.0. The signing key and certificate otherwise come only from the developer settings' `contentCredentials` ([settings.md](settings.md#content-credentials)), never from a shared file or a repository.
- **Byte stability:** each signature is new (random manifest identifiers, ECDSA), so re-signing never repeats bytes. Each manifest names the sha256 of the bytes it signed and its certificate's sha256, and a hand-off keeps the file already at its destination when that file validates and names the same bytes, claim and certificate.
- **What it cannot write:** c2pa-rs 0.92 has no asset handler for glTF, GLB or KTX2, so those keep the IPTC/XMP marks of the section above. WAV, MP4 and the other formats the SDK writes are not formats hand-off writes.
- **The independent reader in the tests:** no second C2PA implementation installs without a native binary, so `test/fixtures/c2pa-reader.ts` checks the manifest without the writer's code: exiftool extracts the JUMBF, the test walks its boxes, decodes CBOR with `cbor2` (a devDependency) and verifies with node:crypto the COSE signature over the claim against the leaf certificate, the certificate chain, the claim's assertion hashes and the data hash over the file's bytes.

## The Web Annotation subset is validated by zod

Review records (`<assetId>.review.json`, [docs/library.md](library.md#review-records)) are W3C Web Annotation `AnnotationCollection`s. No maintained Node library writes Web Annotation: the npm packages that model it are unmaintained, are browser annotation clients (Hypothesis, Annotorious, Recogito) that bring a UI and their own storage, or only read JSON-LD in general (`jsonld`), which validates no Web Annotation shape and would not keep the one-item-per-line layout that lets Git's union merge driver join two branches' appends. So `src/library/review.ts` checks the subset Assetgrove writes with a zod schema of loose objects, so readers keep members it does not know: motivations `commenting`, `replying`, `assessing`, `editing`, `describing`, `tagging` and `moderating`; `TextualBody` and `SpecificResource` bodies; a target with a `FragmentSelector` media-fragment box (`xywh=`, in pixels or percent) and the `ag:version`, `ag:frame`, `ag:view` and `ag:mask` extensions; and the `ag:versions` stack. An annotation id is the first 16 hex of the sha256 of its canonical JSON (keys sorted; `src/library/canonical.ts` is a dozen lines, so no canonical-JSON library is taken), so two branches that write the same annotation write the same line.

Git LFS pointers are parsed by hand for the same reason as the tracked-key scan: the format is three lines of text, and the only readers are the `git-lfs` binary, which reads must not run because it touches the work tree and the network.

## Extensions load only from developer settings

An extension is code, so the only input that may name one is the developer settings' `extensions` array. Shared files (target profile, style bible, specs) travel between developers and must never steer code: a `<ext>:<name>` id in one never loads anything, it exits 2 `extension_unavailable` when that extension is not loaded. A package.json dependency alone loads nothing either.

A package whose entry file any Git work tree at or above it tracks is refused (`extension_refused`), because a tracked entry would be code the project supplies, and a project must never make Assetgrove run its code. The manifest (`assetgrove.api`, `entry` inside the package) is checked by reading package.json before any import. Core registers its own kinds, preset and adapters through the same contract, so the contract is the one path by which anything is added.

## Atlas writers are hand-written

The `atlas-json` and `aseprite-json` presets (`src/handoff/presets`) write their JSON themselves. I looked for a maintained library that writes sprite-atlas or Aseprite JSON: the packers (`free-tex-packer`, `texturepacker` wrappers, `spritesmith`) pack images into a new sheet and would repack a strip whose geometry is already fixed, and the Aseprite tooling is the Aseprite program itself or readers of its export. None writes this document from known frame rectangles. The output is a handful of fixed-shape objects, byte-stable, and each preset reads it back and checks it ([handoff.md](handoff.md)).

## Search bars and the image-similarity threshold (design section 7.9)

The owner confirmed these bars, and they are committed here before the measuring run. Quality bars are the search spike's measured values minus two standard errors, rounded down to 0.05. Speed bars are measured on the 24-thread reference box. `bench/search/bars.ts` reads the table below at run time; `packages/assetgrove-search/test/bench-bars.test.ts` fails when this table and the design's values disagree.

| Id               | Measure                                                 | Bar       | Where         |
| ---------------- | ------------------------------------------------------- | --------- | ------------- |
| look-category    | By look: at least 3 of the top 5 share the category     | >= 0.85   | dispatch      |
| look-recall10    | By look: recall@10, same pack and category              | >= 0.65   | dispatch      |
| look-pixel16     | By look: recall@10 on 16-px pixel art                   | >= 0.50   | dispatch      |
| words-image-p5   | By words, P@5: image vector only                        | >= 0.45   | dispatch      |
| words-shipped-p5 | By words, P@5: shipped mode                             | >= 0.85   | dispatch      |
| filters-rebuild  | Filters return only matching rows; rebuild is identical | = 100%    | test          |
| text-query-p95   | Text query p95                                          | <= 150 ms | reference box |
| image-query-p95  | Image query p95                                         | <= 500 ms | reference box |
| search-10k       | Search over 10,000 assets, fresh                        | < 1000 ms | reference box |
| indexing         | Indexing, per image                                     | <= 150 ms | reference box |
| freshness-2000   | Freshness, no changes, 2,000 files                      | <= 100 ms | reference box |

**Which library each measure runs on.** The by-look measures (`look-category`, `look-recall10`, `look-pixel16`) search the full library, `bench/search/inventory-full.csv`: the 1,728 images of the spike's 1,733 left after five byte-identical duplicates are dropped. Their bars were set there. In the 300-image subset a pack-and-category group has 8 to 21 members, against 17 to 172 in the full library, so recall@10 there asks for nearly every member of the group and reads far lower for the same vectors. The queries are the 300 labelled images, each searched among all 1,728. An image's relevant set is the other images of its pack and category in the full library, k is 10 (5 for the category share), and the query image is left out of its own results. `look-pixel16` is recall@10 over the 16-px pixel-art queries, the measure its bar came from. Every 16-px image is a tile, so a category share would read 1.0 whatever the ranking. The by-words measures, the filters check and the image-similarity threshold run on the 300 labelled images with their card texts and labels. `node bench/search/run.ts --embedder siglip2` runs on the package's `LanceStore`, so shipped mode is ranked by LanceDB's BM25 full text and the speed bars time the shipped store; the scripted run keeps the in-memory store unless `--store lance` is given. The dispatched bench fetches the full library by its inventory, each file checked against its sha256, as it fetches the 300.

**Card texts past the token limit.** The text model reads 64 tokens. A longer text is cut there with its end token kept (`packages/assetgrove-search/src/tokens.ts`), so a cut card text is embedded like a short one and like a query.

**Precision.** The labelled library is about 300 images, so each quality measure is precise to roughly ±0.05. The bars keep the spike's values and are read with that margin: a miss within 0.05 is re-run once on the reference box before it counts. There is no other re-run.

**Unmeasured int8.** The int8 text part is unmeasured on card vectors. If shipped mode fails on it, the text part goes to fp32.

**Image-similarity threshold rule.** The threshold is the lowest cosine similarity `t` such that, over every pair of library images whose similarity is at least `t`, the share that are labelled same-asset pairs is at least 0.9. The bench computes it from the labelled library and prints it; the number that ships in the search package is that printed value. The bench writes `null` when no `t` reaches 0.9.

**Shipped image-similarity threshold: not yet measured.** The package ships it in `packages/assetgrove-search/src/image-threshold.json` and `packages/assetgrove-search/test/near-match.test.ts` fails when that value and this line disagree. The run that built near matches (design section 7.6) could not download the SigLIP2 model (the sandbox denied huggingface.co), so the bench has not computed it. Run `node bench/search/run.ts --embedder siglip2`, then put the printed `threshold` in both places. While it is `null`, a plan with references lists no near matches, because none can be shown to clear it; a plan without references is unaffected.

**Written card texts.** The spike measured shipped mode with card text derived from file names, which inflates it. The labelled library's card texts are written from the images by a vision model (`bench/search/write-card-texts.ts`), recording model, prompt and date per text. A PNG under 256 pixels on its long side is scaled up by a whole factor with hard pixels before the call, and the prompt says to leave a plain or transparent background out: a first run without these wrote wrong texts for 3 of 20 sampled images, all 52 pixels or less, and described a white background in 87 of 300. A seeded sample of the texts is then read against the images, and the manifest records which texts and by whom. For the committed texts that was 30 of 300, 9 of them 32 pixels or less, by the owner's AI assistant session: none wrong, 2 loose (wings read as a streak, a top-down figure read as a barrel). A card text never contains its image's file stem, except that a stem of one plain lower-case word (`bear`, `left`) names the subject and a truthful text may say it. The calls go through the AI Gateway relay, which counts them against its cap; `--max-calls` is the script's own cap.

**Same-asset pairs.** Two images are the same asset when they share a pack and differ only by folder (a restyle) or by colour (`playerLife3_green`/`_red`, `character_black_blue`/`_green`, `barrier_red`/`barrier_red_race`). The threshold rests on these pairs.

**By-words P@5.** A query with fewer than five relevant images in the subset divides by its relevant count, so a perfect ranking scores 1; queries with no relevant image are skipped.

**Inventory parsing.** `build-manifest.ts` reads `inventory.csv` with a short fixed-shape parser instead of a CSV library: the file is a dev input with seven known columns, no embedded quotes beyond one optional quoted path, and a library would add a dependency to a script that otherwise has none.

## The search store is LanceDB 0.41.0; its lock and filter compiler are hand-written

`packages/assetgrove-search/src/lance-store.ts` stores the index in LanceDB 0.41.0 with its `apache-arrow` peer, both pinned exactly. LanceDB lists its own embedding helpers (a second Transformers.js, which brings another onnxruntime-node and sharp, and the OpenAI client) as optional dependencies; the package's `pnpm-workspace.yaml` skips them with `ignoredOptionalDependencies`, since the package embeds through its own pinned Transformers.js. LanceDB's platform binary is an optional dependency with no install script, so the package installs with install scripts ignored. LanceDB is imported only after the platform check, so darwin-x64 refuses with `extension_unavailable`, reason `platform`, before it loads.

The write lock (`src/lock.ts`) is the exclusive create of `<store>/write.lock` holding the pid, as design section 7.3 states. I looked at `proper-lockfile`: it locks with a directory and an mtime heartbeat rather than a pid, so a lock left by a dead process waits out its staleness window instead of being taken at once, and it adds a dependency for some forty lines. The `--where` compiler (`src/where.ts`) is hand-written: it parses a fixed field list and writes each value as one escaped SQL string literal, so a filter string never reaches SQL unparsed; LanceDB offers no parameterised filters, and a general SQL builder would still need the field list and quoting rule this file holds.

## A saved plan holds no money, route or grant; apply re-resolves them

A saved plan is a request input a person can edit, so it must not be able to steer what is spent or what the output may become. A plan (`assetgrove-plan/1`, a run artifact) holds the operation names apply runs, the compiled prompts, each input file's path and sha256, the plan command's request digest (`requestDigest`), `resolutionSha256` (the sha256 of the canonical JSON of each operation's resolved provider, model, estimate, seed support, output grant and provider terms, and the run cap) and an integrity `digest` over everything else. Nothing else: no cap, route, estimate or grant. `apply` re-reads every input (a changed one exits 2), re-resolves routes, estimates, grants and the cap from the developer settings and exits 2 `plan_changed` when the operations or the resolution differ from planning time, or when the plan carries any field outside its format even with its digest recomputed. The identity mode at apply is the one the plan's operations imply. The run-options file (`--run-options`) holds `candidates`, `seed`, `strictness` and `exploration` only; the cap is `caps.runUsd`. Apply's own cap does not count the planning call, which was capped and recorded in its own run.

## The prompt policy's names live in policy/

The prompt policy refuses requests that name real artists, studios, games, characters and people, so its data has to hold those names. `policy/blocklist.json` (`assetgrove-blocklist/1`, shipped in the package) and the red-team prompts under `test/fixtures/prompt-policy/` are the one exemption from the rule that no other game is named in `src/`, `test/`, `skills/`, `docs/` or `README.md`. Code and tests read names from the blocklist instead of spelling them. Each plan step collects the request's prompt text (spec strings minus file names (a string with no whitespace ending in a known file extension; a slash- or dot-bearing word is still checked), the brief, the bible's front matter strings and Do's and Don'ts, the template body, a saved plan's prompts at apply, the free-text options and the target profile's text a prompt carries), normalises it (invisible format characters removed, NFKC, lower case, combining marks removed, every run of other characters one space) and matches each term on word boundaries, spaced or run together. A hit exits 9 `prompt_refused` with `error.policy` before confirmation and spend; a settings `promptPolicy.allow` term clears its hit and is recorded in `allowedBy`. A `ProviderSet` runs the same check on the final prompt of every image and model call. After confirmation, the run's first call is one Boolean decide call on the `prompt-policy` operation (decisions role) about the plan step's prompt text (`src/policy/model.ts`, run by `src/runs/execute.ts` inside the run's journal): a probability of 0.5 or more exits 9 `prompt_refused`, a call that fails exits 4 `provider_error`, and with no decisions route the plan step exits 2 `route_unavailable`, so the check fails closed and nothing else is called. The `promptPolicy` record (blocklist hash, text hash, verdict, match, `allowedBy`, and the model check's `model` and `probability`) is in `request.json`, every run record, and the provenance `apply`, `stage` and `look-dev` write. The matching is hand-written: it is a dozen lines over `String.prototype.normalize`, and no maintained library matches a term list on normalised word boundaries without pulling in a general search engine.

## Prompt-policy bars

A blocklist misses paraphrases, so every request also gets one model decision, and the policy is measured on `test/fixtures/prompt-policy/red-team.jsonl` against bars set before its first real run. The refusal rate is the share of `expect: "refuse"` rows the policy (blocklist, then the model check) refuses; the false-refusal rate is the share of `expect: "allow"` rows it refuses. `test/real/prompt-policy.real.ts` reads the block below and fails when the refusal rate is under `minRefusalRate` or the false-refusal rate is over `maxFalseRefusalRate`.

```json
{ "promptPolicy": { "minRefusalRate": 0.9, "maxFalseRefusalRate": 0.1 } }
```

## The data-dependent 1.0 bars

Three of the 1.0 measures need a number that only real use can test. The numbers are fixed here, before Phases 2 and 3 produce the records they judge, so a result cannot shape its own bar. They are read once against real records at the Phase 2 gate and corrected there if the records show a bar is wrong; after that they hold to 1.0.

```json
{
  "dataBars": {
    "qa": {
      "minPrecision": 0.6,
      "minRecall": 0.9,
      "minShownJudged": 100,
      "minFilteredSampled": 50
    },
    "setConsistency": { "maxStdDev": 0.1, "maxBelowMedian": 0.2, "minSetSize": 5 },
    "changeRequests": { "minApprovedWithinTwoVersions": 0.7, "minRequests": 30 }
  }
}
```

**QA precision and recall.** Precision is the share of shown candidates a person finds acceptable: usable for the request as asked, whether or not it was the one picked. Recall is the share of all acceptable candidates that were shown. It is worked out from a sample of the filtered candidates: the acceptable share of the sample, times the number filtered, estimates the acceptable candidates QA hid. The two bars differ on purpose. A poor candidate that is shown costs a glance; a good candidate that is filtered was paid for and never seen. So QA may let 4 in 10 weak candidates through, and may hide no more than 1 in 10 good ones, the same limit the [identity lock bar](#identity-lock-bar) puts on false rejects. The measure counts only once 100 shown candidates are judged and 50 filtered ones sampled (all of them when fewer were filtered), across at least three asset kinds and two subjects, so that no bar rests on one character.

**Consistency of a set.** The set-level audit scores each asset of a set for style and, where the subject has a lock, for identity, both from 0 to 1. A set of five or more assets is consistent when each score's standard deviation is at most 0.10 and no asset scores more than 0.20 below the set's median. The few identity scores on record for one approved character sit within 0.16 of each other, with a standard deviation of 0.06, so 0.10 leaves room for honest variation. One off-model asset in a set of nine (0.40 among 0.75s) gives 0.12 and fails both rules. The audit stays advisory: beyond the bar it names the assets, and a person decides.

**Change requests land.** At least 70% of change requests are approved within two new versions, counted once 30 requests are on record. A change request gets two attempts at a marked region, so it should do at least as well as one fresh request, whose bar is a pick 70% of the time.

## One confirmation per request, checked where money is spent

Spend, pick and write each need one confirmation of the request's digest (design section 7). The sources, in order: headless settings (`headless.operator`, method `headless`; a headless pick must name `--candidate`, else exit 2 `invalid_input`); a record at `<configDir>/confirmations/<hex>.json` named by the digest (a spend record pays for one run: its first run writes the run directory into it, and it covers no other run directory and, once that run finishes, no further run); for `apply`, its plan's record; over MCP, a form when the client declares form elicitation (method `elicitation`, below); the inline prompt when stdin and stderr are a TTY (method `tty`, via `node:readline/promises`); otherwise exit 8 `confirmation_required` with `error.confirmation = {kind, id, summary, confirmCommand}` and the request saved to `<stateDir>/pending/<id>.json`. A decline exits 8 `confirmation_declined` and saves the request to `<stateDir>/pending/<id>.json`, so `assetgrove confirm <id>` can still confirm it. Every method writes the record, which is a plain JSON file (no library needed) and is copied into `run.json` and the pick's provenance. `assetgrove confirm <id>` (CLI only, exit 2 without a TTY) completes a pending request (method `terminal`).

Over MCP the form rides the official SDK's multi-round-trip flow: the tool returns `inputRequired` with one flat form (spend, write and command ask a Boolean `approve` and show the request's fields in the message; pick asks `{candidate: enum(ids + "none"), note?}`) and a `requestState` sealed by the SDK's `createRequestStateCodec` (HMAC, a random per-process key) naming the tool, its arguments' digest, and the request's kind and digest. On re-entry the command runs again from its free plan, so earlier answers are found as records; a request of the sealed kind under another digest, or other arguments, exits 2 `plan_changed`. Accept writes the record with method `elicitation`, the client's name and protocol version (the per-request envelope on 2026-07-28, the `initialize` values on 2025-era connections), `toolMarkedRequiresUser` from the tool's mark, and a pick's `note`; decline, cancel or `none` exits 8 `confirmation_declined`. 2025-era clients that answer `elicitation/create` are served by the SDK's legacy shim. A client that declares no form elicitation gets exit 8 `confirmation_required` as above.

The run executor verifies the confirmation before the first reservation and on every resume (a deleted record makes the resume exit 8), and builds the only clearance, held in memory. `Caller` refuses a paid call without one (exit 8 `confirmation_required`), so no path spends around the check. A request whose forecast is 0 on free providers needs no spend confirmation, and a finished run returned as reused is not confirmed again.

A saved plan carries its `requestDigest`, and one plan request covers one `apply` run: the default round's, not `--round n` (n > 1), which is another paid run. That `apply` uses the plan's record when the record names the plan command and the digest of the plan file its run saved, no other `apply` run has used it (the first one's directory is written into the record, and once that run finishes the record covers no other), every input hash the record confirmed still matches the plan's and `apply`'s forecast is at or under the confirmed one; otherwise it asks under its own digest. Records say `selfReported: true`: they show what a client or person reported, not proof.

No plan field and no argument approves spend; a plan carrying `approved` exits 2 `plan_changed`. `write-families` still needs `status: "confirmed"` in the grouping, but that grants nothing: the write confirmation (the families and the grouping digest) authorizes the write.

## Hosted search embeddings

`search.embedder: "route"` (issue #242, design section 7.7) embeds through the `embeddings` role. The gateway adapter embeds through the AI SDK's `embed`, which takes text only; an image goes to a Google multimodal embedding model (`google/gemini-embedding-2`) as the Google provider's documented `content` provider option, inline, with an empty value, which the gateway bills as image tokens. No hand-written protocol is involved. An embeddings route to any other gateway model exits 2 `route_unavailable` when the route is resolved, before any plan step or reservation, since it could not embed images and text in one space (the adapter's `embedsModel`); the exit 4 refusal of an image in the gateway call stays as a backstop. Vectors are asked for 768 wide, the index schema's width, through the SDK's `dimensions`. One operation, `embed`, serves images and texts alike, so the two can never land in two models' spaces, and no adapter routes it by default, so a hosted embedder is never chosen without the role.
