# Assetgrove commands

One section per command: its usage, its flags, and the MCP tool that serves it and that tool's arguments. Every command takes `--help`; every command except `mcp` takes `--json`. Paid commands reserve every call against their `--cap` (USD) and against the spend ledger; `--cap` may only lower the settings' `caps.runUsd` (see [Environment](../SKILL.md#environment)). Commands that stage write under `.assetgrove/` in the working directory by default; only `init`, `bible preset`, `migrate`, `pick` and `write-families` write into the target.

### `init`

```text
init --directory <target> --profile-preset <id> --style-preset <id> --world <name> [--harness claude-code] [--providers <adapterId,...>] [--overwrite] [--json]
```

Sets up a target repository and returns the steps a person takes next. Never interactive. Writes the target profile (`.assetgrove/profile.json`, from profile preset `sprite-32` or `sprite-64`), the style bible (`.assetgrove/art-direction/BIBLE.md`, from style preset `cozy-storybook`, `flat-cartoon-kids` or `dark-gritty-isometric`, with `referenceLicense: NOASSERTION`) and its presets, the prompt template (`.assetgrove/prompts/default.md`), the `art-direction` skill in `.claude/skills/` and `.agents/skills/`, and `.gitignore` rules for `.assetgrove/runs/`, `.assetgrove/imports/` and `.assetgrove/animation/`. Idempotent: an identical file is left alone, `.gitignore` gains only the rules it lacks, and a differing file exits 2 `invalid_input` with `conflicts` and nothing written, unless `--overwrite`. First the tracked-key guard runs on the target: a tracked key exits 2 `key_tracked` with the refused `guard` step and nothing written. Needs a Git work tree (else exit 2 `git_required`, nothing written) and writes one marked block of Git LFS, `text eol=lf` and union-merge rules in `<library.root>/.gitattributes`; its steps cover Git LFS (`git-lfs`, `git-lfs-install`) and the LFS metering notice. Never commits, runs `git lfs install`, writes a key, the settings file or a project-scope harness config.

Returns `{steps: [{id, status, detail}], adapters, bibleQuestions, providers, files}`. `status` is `done`, `refused`, `needs-person`, `to-run` or `notice`. The steps: `guard`; `files`; each step of the key recipe for `--harness` (`claude-code`, `claude-code-cloud`, `copilot-cli`, `codex` or `other`; default `claude-code`), under the recipe's own id with its `rules`; `settings` (`needs-person`, `tool` `settings_change`: the agent calls it so the person declares the caps and the provider limit; endpoints and roles are hand edits, and with `--providers` it carries `suggestedRoles`); `spend-check` (`to-run`, `spend check`); and the notices `notice.auto-answer` (a harness can answer prompts automatically) and `notice.retention` (providers may retain what they receive). `bibleQuestions` are `{field, question}` to draft the bible with the developer; `providers` is each route's data flow (`{operation, providerId, host, upstream, providerTerms, retention}`), a route to a listed pack's adapter among them; `adapters` is each adapter of a pack the settings' `extensions` list loads (`{adapter, extension, package, hosts, endpointFromSettings, keyEnv}`), whose hosts and key variable the key recipe also names, and whose ids `--providers` accepts; `files` are `{path, role, status}` with `status` `written`, `unchanged` or `overwritten`. Calls no model and spends nothing.

MCP tool: `init`, arguments `directory`, `profilePreset`, `stylePreset`, `world`, `harness`, `providers`, `overwrite`.

### `bible`

```text
bible describe --bible <BIBLE.md> [--json]
bible preset --bible <BIBLE.md> --preset <preset> [--json]
```

`describe` reads a world's art constitution (art direction, bounds, anchors, presets, identity locks) as JSON. `preset` rewrites the bible's look and tone from one of its presets and keeps the world's palette, anchors and identity locks; `apply` then refuses plans made from the earlier bible. The presets are `cozy-storybook`, `flat-cartoon-kids` and `dark-gritty-isometric`. `init` writes the bible; there is no `bible init`, and any other action exits 2. Calls no model and spends nothing. The MCP tool is one tool whose `action` argument (`describe` or `preset`) picks the subcommand.

MCP tool: `bible`, arguments `action`, `bible`, `preset`.

### `plan`

```text
plan --spec <spec.json> --bible <BIBLE.md> --profile <profile.json> --out <plan.json> [--brief <brief.json>] [--run-options <run-options.json>] [--template <template.md>] [--identity-mode <off|shadow|enforce>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Compiles a reviewable generation plan into `--out` and never generates images. With a provider (`AI_GATEWAY_API_KEY` or `--provider-script`), the configured compiler LLM writes the prompt and negatives from the repository's templates in one model call; without one for the planning role, a marked deterministic template fallback is recorded. The run's first call is still the prompt policy's model check on the decisions role, which fails closed: with no callable provider for it the plan exits 4, or 2 `route_unavailable` when nothing serves the role. `--identity-mode` overrides the profile's identity mode for a character with an identity lock, and the forecast includes the scoring calls. `--run-options` names a JSON file holding only `candidates`, `seed`, `strictness` and `exploration`; any other field (a `capUsd`, a route) exits 2 `invalid_input`; the cap comes from the developer settings' `caps.runUsd`, the routes from their routes and roles. The saved plan (`assetgrove-plan/1`) holds operation names, compiled prompts, input paths and hashes, the request digest and a hash of the planning-time resolution, and nothing else. Show the plan's prompts, clamps and cost forecast to the human. Writes only the plan file and its run directory; the run directory's `compiler.json` keeps the compiler call's record (model, route, request ID, cost), and the saved plan's `requestDigest` names that directory. A name in the compiler's text never refuses the plan after its spend: the plan falls back to the template's prompt and records why (`compiler.fallbackReason`, `promptPolicy.fallback`); a phrase in it is saved and decided by `apply`'s model check. Its forecast is the prompt-policy check and the planning call plus every generation, QA and identity call the later `apply` runs, with `apply`'s prompt-policy calls (two when the compiler can run, else one).

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, takes its `lock` (one a live process holds exits 2 `run_in_progress`), journals every call as `calls/<callKey>.json`, and writes `state.json` and `run.json` there. Repeating a request that finished returns its run with `reused: true` and no provider call; repeating an interrupted one pays only for the calls its journal lacks. `--round` (default 1) is part of the digest: a new round is a new run.

MCP tool: `plan`, arguments `spec`, `bible`, `profile`, `out`, `brief`, `runOptions`, `template`, `identityMode`, `workItem`, `runs`, `round`.

### `apply`

```text
apply <plan.json> [--out <runs directory>] [--note <text>] [--work-item <label>] [--provider-script <module>] [--round 1] [--dry-run] [--json]
```

Generates exactly a saved plan. It re-reads every input the plan names and refuses a changed one (exit 2), re-resolves the routes, estimates, output grants and run cap from the developer settings and exits 2 `plan_changed` when they differ from planning time or the plan carries any field outside its format, runs the prompt policy on the plan's prompts (exit 9 `prompt_refused` on a name, before spend). Its first call is the model check, with the plan's input files labelled as `plan` labels them and only the compiler's own text labelled model-written; when that check refuses a compiled plan, a second call decides on the person's text alone, and when that allows, `apply` generates from the template's prompt in place of the compiler's and records why in `promptPolicy.fallback` (two prompt-policy calls in its forecast; one for a plan the template wrote, whose refusal exits 9). A person confirms the spend: headless settings, a record at `<configDir>/confirmations/<hex>.json`, an MCP client's form (method `elicitation`), the inline prompt on a TTY, or exit 8 `confirmation_required` with `error.confirmation` and `assetgrove confirm <hex>`. The plan's own spend confirmation covers one `apply` run of the plan file it saved, the default round, while every input hash it confirmed still matches the plan's and `apply`'s forecast is at or under the confirmed one; `--round n` (n > 1), another `--out` once that run started, or any other `apply` asks under its own digest. The confirmation authorizes the generation spend only; the outputs stay pending review. Paid gateway calls; needs `AI_GATEWAY_API_KEY` or `--provider-script` (exit 4 without either). Stages the run under `--out` (default `.assetgrove/runs`), never in the target.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--out`, takes its `lock` (one a live process holds exits 2 `run_in_progress`), journals every call as `calls/<callKey>.json`, and writes `state.json` and `run.json` there. Repeating a request that finished returns its run with `reused: true` and no provider call; repeating an interrupted one pays only for the calls its journal lacks. `--round` (default 1) is part of the digest: a new round is a new run.

MCP tool: `apply`, arguments `plan`, `out`, `note`, `workItem`, `round`.

### `mcp`

```text
mcp [--read-only] [--target <dir>] [--work-item <label>] [--provider-script <module>]
```

Serves one MCP tool per command other than `mcp` over MCP stdio with the official MCP SDK; each tool takes its command's arguments and returns the same result document as the command's JSON output (as `structuredContent`, with `isError` set when the result is not ok; `cat` lists its contents there and carries them as content, see `cat`), and file paths are local to the server. A paid tool call runs in the server's process; while its client is connected, a call that carries a `progressToken` gets `notifications/progress` at least once per job. If the client drops, the run goes on until it ends or the server stops; repeating the request resumes it from its journal. Stdout carries the protocol, so it prints no JSON document; logs go to stderr. Spends and writes as the commands it serves do. Like every paid command, it exits 2 `settings_invalid` when a TLS or proxy variable is set that the settings' `environment.allow` does not list.

It also serves the library of the project at `--target` (default: the working directory's Git top level) as `asset://<game>/` resources, the tree `ls` and `cat` read: `resources/list` (the game root, every folder and card address, 200 per cursor page), `resources/templates/list`, `resources/read` and `resources/subscribe`. After each of its own tool calls it sends `notifications/resources/updated` for a subscribed asset or run folder that changed (a new version or annotation, a staged candidate) and `notifications/resources/list_changed` after a pick or write it served. A refused read answers JSON-RPC `-32602` with `data.code` `invalid_input`. Other changes show at the next read.

Use `--read-only` to browse the library and inspect candidate resources with tools that cannot edit, pick or spend.

### `materials`

```text
materials --albedo <painted.png> --spec <spec.json> --profile <profile.json> --derivation <derivation.json> --out <directory> [--cap <usd>] [--work-item <label>] [--digital-source-type <IPTC code or URI>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Derives the material channels the profile's `style.materials` requests from a painted albedo, checks alignment and temporal stability, writes native-resolution renditions into `--out`, runs the target's compression and lit previews, and judges the flat and lit images with vision QA. The compression and preview commands run only with an approval tied to each command's hash, exactly as `pick`'s validator does (cwd: the profile's directory); every one is checked before the first model call, exit 8 `confirmation_required` otherwise, and each output's provenance records the command's `hash` and approval `method`. Paid gateway calls (vision QA and any model-assisted channel). Rejected materials exit 5 and stay unapproved. Never writes into the target.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, takes its `lock` (one a live process holds exits 2 `run_in_progress`), journals every call as `calls/<callKey>.json`, and writes `state.json` and `run.json` there. Repeating a request that finished returns its run with `reused: true` and no provider call; repeating an interrupted one pays only for the calls its journal lacks. `--round` (default 1) is part of the digest: a new round is a new run.

MCP tool: `materials`, arguments `albedo`, `spec`, `profile`, `derivation`, `out`, `cap`, `workItem`, `digitalSourceType`, `runs`, `round`.

### `stage`

```text
stage --spec <spec.json> --bible <BIBLE.md> --profile <profile.json> [--candidates 4] [--note <text>] [--cap <usd>] [--runs .assetgrove/runs] [--work-item <label>] [--provider-script <module>] [--round 1] [--dry-run] [--json]
```

Generates candidates within the cap and stages only those that pass QA, with reasons and provenance, in a run directory under `--runs`. `--dry-run` prints the planned calls, the cost forecast and the spend left under the ledger's limits, writes nothing and needs no key. Image kinds make paid gateway calls. A `character-3d` spec makes rigged, animated `.glb` candidates from the subject's approved turnaround: its 3D calls go to Tripo (`TRIPO_API_KEY`) and its identity call to the gateway. A sprite-strip spec needs an approved `keyPose`. Never writes into the target.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, takes its `lock` (one a live process holds exits 2 `run_in_progress`), journals every call as `calls/<callKey>.json`, and writes `state.json` and `run.json` there. Repeating a request that finished returns its run with `reused: true` and no provider call; repeating an interrupted one pays only for the calls its journal lacks. `--round` (default 1) is part of the digest: a new round is a new run.

MCP tool: `stage`, arguments `spec`, `bible`, `profile`, `candidates`, `note`, `cap`, `runs`, `workItem`, `round`.

### `stage-source`

```text
stage-source --source <file.aseprite> --spec <spec.json> --profile <profile.json> [--runs .assetgrove/runs] [--digital-source-type <IPTC code or URI>] [--json]
```

Renders an editable Aseprite file as a staged strip, with no model call: the frames of the tag named the spec's `animationFamily` (every frame when the file has no tags; a file with other tags exits 2 naming them), layers composited with the normal blend, side by side as candidate `c1` of a run directory under `--runs`. The spec must be a `sprite-strip` with an `assetId` and `animationFamily`, and the file's canvas must be the profile's frame size (exit 2 otherwise). The candidate's provenance records `editableSource`: the file's path and sha256, the tag, the source frames and their durations; `pick` keeps that lineage. An `.aseprite` file embeds no source type, so declare it with `--digital-source-type` or it stays undeclared. The run is named from the file's bytes, spec, profile and source type: staging the same bytes again rewrites the same run, an edited source is a new run. Spends nothing. The existing `import` and Aseprite JSON hand-off are unchanged.

MCP tool: `stage_source`, arguments `source`, `spec`, `profile`, `runs`, `digitalSourceType`.

### `pick`

```text
pick --run <run directory> --target <target directory> [--candidate <id>] [--duplicate <existing-version|keep-separate|exit>] [--existing-version <assetId>@<version>] [--json]
```

A person confirms the pick: headless settings record it unattended and must name `--candidate` (exit 2 `invalid_input` without one); otherwise a record at `<configDir>/confirmations/<hex>.json` for the pick's digest, an MCP client's form (`{candidate, note?}`, method `elicitation`), the inline prompt on a TTY (which asks for the candidate when none is named), or exit 8 `confirmation_required` and `assetgrove confirm <hex>`. The record goes into the pick's provenance. When a candidate's media is marked as model-made by another tool and came with a record of no calls (`modelMadeOutsideAssetgrove` in its provenance), the confirmation's summary warns that Assetgrove checked no licence grant for it and its details list it under `licenceGrantUnchecked`. Writes the chosen candidate and its manifest into the target with review pending, then runs the target profile's validator command locally when it declares one (exit 6 when it rejects). The validator is a command a file names, so it runs only with an approval tied to its exact command hash (kind, argv template, cwd relative to the target's Git top level, and the bytes of each argv file under it): listed in the settings' `commands.approved`, or a record at `<configDir>/approvals/<hash>.json`. Otherwise pick asks in an MCP client's form or at a TTY and records the accept, or exits 8 `confirmation_required` before writing anything, with `error.confirmation` carrying `id` (the hash), `confirmCommand` and `command` (`kind`, `hash`, `argv`, `cwd`, `files`); `confirm` approves it. Under headless settings only `commands.approved` counts. On Windows a validator whose program resolves to a `.cmd` or `.bat` file exits 2 `command_refused`. The provenance's `commands` records the validator's hash and approval `method` (`settings`, `elicitation`, `tty` or `terminal`). Refuses, before writing, an output the target's licence cannot declare (exit 7). Before writing, a candidate whose complete bytes match another asset's version or an older version (including historical versions) is reported with its `assetId` and `version` under `duplicates`, and pick exits 2 `invalid_input` with `outcome` `decision-required` until `--candidate` and `--duplicate` choose an outcome: `existing-version` with `--existing-version <assetId>@<version>` returns that reference and writes nothing; `keep-separate` admits the candidate as its own asset; `exit` writes nothing. Both `existing-version` and `keep-separate` require a person even under headless settings, and the confirmation is bound to the candidate, the outcome and the complete match set; if the match set or staged input changes after confirming, pick exits 2 `plan_changed` before admission. Declining leaves the library unchanged. Names and visual similarity never make a duplicate. Calls no model and spends nothing. Only a person runs it.

MCP tool: `pick`, arguments `run`, `candidate`, `target`, `duplicate`, `existingVersion`.

### `intake`

```text
intake <file> --target <target directory> [--profile <profile>] [--json]
```

Hashes the complete bytes of an incoming media file (SHA-256) and reports every exact match in the target's library under `matches` (`assetId`, `version`, `sha256`, `card`), including historical versions whose media is no longer local and cards without a review record (by their lock hash). `outcome` is `distinct` with no match, otherwise `decision-required` with `outcomes` `existing-version`, `keep-separate` and `exit`, which pick selects for a staged candidate. Files with the same name or similar appearance but different bytes are distinct. An unfetched Git LFS pointer exits 2 `invalid_input`. `--profile` defaults to the target's profile. Read-only: writes nothing, calls no model and spends nothing.

MCP tool: `intake`, arguments `file`, `target`, `profile`.

### `review`

```text
review <address> [--candidate <id>] [--version <n|sha256>] [--comment <text>] [--reply <id>] [--resolve <id>] [--reject <reason>] [--placeholder] [--frames <from-to>] [--cell <column,row>] [--time <start,end>] [--json]
```

Appends one annotation to a review record, never changing an existing line. The address is an asset's card, media or review record, or, with `--candidate`, a run directory. `--version` names the version by number or sha256 (the current one by default; not with `--candidate`). `--comment` comments; `--reply` with `--comment` replies to the annotation it names; `--resolve` closes a request, with `--comment` as its note; `--reject` rejects with its reason and takes no `--comment`. Give one of `--reply`, `--resolve` or `--reject`. `--placeholder` marks the exact version, and only that version, as a placeholder (a `tagging` annotation; `--comment` is an optional note) so a release `deliver` refuses it; it takes no `--candidate`, `--reply`, `--resolve`, `--reject` or anchor. A new `--comment` on a version may anchor the note to part of it: `--frames` a frame range of a strip, `--cell` a cell of an atlas, `--time` a time range of a track in seconds; each is checked against that exact version, and one outside it exits 2 naming the selector and the valid range. For a version it then rewrites the card's state, the folder indexes and `log.md`. No confirmation, no model call and no spend. The annotation's text is returned only under `sharedText`.

MCP tool: `review`, arguments `address`, `candidate`, `version`, `comment`, `reply`, `resolve`, `reject`, `placeholder`, `frames`, `cell`, `time`.

### `approve`

```text
approve <address> [--version <n|sha256>] [--json]
```

The only way to approve a version. The address is the asset's card, media or review record; `--version` names the version by number or sha256, the current one by default. A person confirms it like a pick (a record at `<configDir>/confirmations/<hex>.json`, an MCP client's form, the inline prompt on a TTY, or exit 8 `confirmation_required` and `assetgrove confirm <hex>`). The digest covers the asset id, the version's sha256 and the record's head, so a confirmation no longer applies once the record gains a line. Under headless settings it exits 8 `confirmation_required` and writes nothing; if the record changes between confirming and writing it exits 2 `plan_changed`. Appends an assessing annotation carrying the confirmation, sets the card's state to approved, rewrites its lock and logs a line. The manifest's review stays pending. Calls no model and spends nothing. Only a person runs it.

MCP tool: `approve`, arguments `address`, `version`.

### `library adopt`

```text
library adopt (<address> | --asset <id>) --original <file> [--target <dir>] [--profile <profile.json>] [--bible <BIBLE.md>] [--json]
```

Hands off a person's edit of a picked asset's file as its next version, the way `pick` hands off. The address is the asset's card, media or review record; `--asset <id>` names it in the library of `--target`'s profile instead. `--original` is the AI-made version the card locks (its sha256 must equal `lock.sha256`). Runs the free QA checks again on the edited file (transparency, the frame count its provenance records, and the palette of `--bible` when given); a failure exits 5 `qa_found_nothing`. A person then confirms it like a pick, over the asset id, the file's sha256, the version it replaces, the original, the run that made the asset, its profile's sha256 and the review record's head; under headless settings it exits 8 `confirmation_required` and writes nothing. The hand-off is rendered from the run that made the asset (`<target>/.assetgrove/runs/<run>`, or the import `<target>/.assetgrove/imports/<run>` of a family `write-families` handed off; the target is `--target`, else the Git top level of the asset's folder; a run id that is not one path segment, a missing run or a run without the version's candidate exits 2) in the version's media type (edited bytes of another type exit 2): the file is marked `compositeWithTrainedAlgorithmicMedia` and signed with C2PA credentials that name the original as a `parentOf` ingredient, its provenance gets a `human-edit` step and the confirmation, and every file the profile's hand-off presets write, the manifest included (review pending), is rendered again and read back. The profile's validator runs under pick's rules: an unapproved one exits 8 before any write. A failed read-back (6 `handoff_check_failed`) or a rejecting validator (6 `validator_rejected`) records no version and puts back every file it wrote. Otherwise it appends the version and an adopt annotation and rewrites the card, its lock, the indexes and `log.md`. A Git LFS pointer exits 2; a file equal to the current version or to an older one exits 2 `version_exists`. Calls no model and spends nothing. Only a person runs it.

MCP tool: `library_adopt`, arguments `address`, `asset`, `original`, `target`, `profile`, `bible`.

### `card edit`

```text
card edit <address> [--title <text>] [--description <text>] [--tag <tag>]... [--label <label>]... [--body <markdown>] [--field <name=value>]... [--json]
```

Changes the person fields of a picked asset's card. `--label` or `--tag` is repeatable and replaces the card's tags. Both resolve aliases when the project has a vocabulary; `--body` replaces the Markdown after the front matter; `--field` is repeatable and sets a field Assetgrove does not own. Naming a machine field exits 2 `card_field_owned` before anything is written. Appends a describing annotation (tagging when only the tags change) that names the changed fields, rewrites the card and the folder indexes, and logs a line. No confirmation, no model call and no spend. The card's text is returned only under `sharedText`.

MCP tool: `card_edit`, arguments `address`, `title`, `description`, `tag`, `label`, `body`, `field`.

### `card describe`

```text
card describe [<address>] [--propose] [--missing] [--target <dir>] [--profile <profile.json>] [--cap <usd>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Has a vision model write a card's `description` and `tags` from the asset's image (a 3D asset's turntable renders). Give one asset's card, media or review record, or `--missing` for every card with no description in the library of `--target`'s profile. The summary is recorded in the card's `verified` list as `process:assetgrove-summary:vision:<model>`. A card whose description or tags a person wrote is never overwritten; it is listed under `skipped` with the reason, as is an asset with no image view (audio, a Git LFS pointer, an undecodable file) and a reply with no summary. A paid command: a plan step, a forecast with `--dry-run`, a person's confirmation and the spend caps. The written text is returned only under `sharedText`.

With `--propose`, writes a proposal JSON file in the paid run directory instead of changing the card, and returns its path. This mode can suggest replacements for person-written text. It records proposed fields, baseline values, source version and media, and model. Labels are restricted to the project vocabulary; without one, no labels are proposed. Spending still follows the same forecast, confirmation and caps. `--dry-run` makes no proposal. A person applies selected fields with `card accept`.

MCP tool: `card_describe`, arguments `address`, `propose`, `missing`, `target`, `profile`, `cap`, `workItem`, `runs`, `round`.

### `card accept`

```text
card accept <proposal> --field <description|labels>... [--json]
```

Applies only the named fields of a proposal created by `card describe` in proposal mode; repeat `--field` to accept both. Unselected fields remain unchanged. A person must confirm the selected changes through the existing pick confirmation path. Acceptance calls no model and spends nothing. Under the library write lock it checks the source version and media, detects edits to selected fields since the proposal, and validates accepted labels against the current vocabulary. A stale source, overlapping edit or label outside the vocabulary refuses the write. Edits to unselected fields do not block acceptance. Each accepted field carries process attribution for its model; retained human text is not attributed to the model. Only a person runs this command.

MCP tool: `card_accept`, arguments `proposal`, `field`.

### `rig`

```text
rig --model <model.glb> --provenance <provenance.json> --spec <spec.json> --profile <profile.json> [--runs .assetgrove/runs] [--json]
```

Re-rigs an existing 3D character, such as a picked candidate, on the target's shared skeleton (`model3d.rig`), generates the clips its gait profiles and motions declare, checks each clip, and stages a one-candidate run with renders under `--runs` for a person to pick. Calls no model and spends nothing. Exits 5 when the result fails QA.

MCP tool: `rig`, arguments `model`, `provenance`, `spec`, `profile`, `runs`.

### `lod`

```text
lod --run <run dir> --candidate <id> [--profile <profile.json>] [--runs .assetgrove/runs] [--json]
lod --model <model.glb> --provenance <provenance.json> --spec <spec.json> --profile <profile.json> [--runs .assetgrove/runs] [--json]
```

Makes the detail-level chain the profile declares (`model3d.lods`) and a rendition per quality tier (`model3d.tiers`) from a staged candidate or a given `.glb`. Each lower level keeps the skeleton, skin weights, clips and UVs, is checked against the full model, and is left out with a reason when it fails. Stages a one-candidate run under `--runs` for a person to pick. Calls no model and spends nothing. Exits 5 when the chain fails QA.

MCP tool: `lod`, arguments `run`, `candidate`, `model`, `provenance`, `spec`, `profile`, `runs`.

### `look-dev`

```text
look-dev --model <model.glb> --provenance <provenance.json> --spec <spec.json> --bible <BIBLE.md> --profile <profile.json> [--cap <usd>] [--runs .assetgrove/runs] [--work-item <label>] [--provider-script <module>] [--round 1] [--dry-run] [--json]
```

Repaints a picked 3D character's base colour on its own UVs in the look the bible's approved references define, writes fur groom maps and tint textures per season the profile declares (`model3d.groom`), gives the eyes a glossy material and mask, and checks them. Stages a one-candidate run with before-and-after renders under `--runs` for a person to pick. Paid gateway calls; the cap defaults to the profile's `model3d.lookdev.capUsd` or $3. Exits 5 when the result fails its checks.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, takes its `lock` (one a live process holds exits 2 `run_in_progress`), journals every call as `calls/<callKey>.json`, and writes `state.json` and `run.json` there. Repeating a request that finished returns its run with `reused: true` and no provider call; repeating an interrupted one pays only for the calls its journal lacks. `--round` (default 1) is part of the digest: a new round is a new run.

MCP tool: `look_dev`, arguments `model`, `provenance`, `spec`, `bible`, `profile`, `cap`, `runs`, `workItem`, `round`.

### `import`

```text
import --sheet <sheet.png> --profile <profile.json> --asset <id> --tool <name> [--origin <origin.json>] [--bible <BIBLE.md>] [--subject <name>] [--hints idle,walk-right,...] [--frames <count>] [--grid <columns>] [--components] [--max-halo <fraction>] [--no-propose] [--cap <usd>] [--work-item <label>] [--imports .assetgrove/imports] [--digital-source-type <IPTC code or URI>] [--provider-script <module>] [--lock-bible <BIBLE.md>] [--identity-mode <off|shadow|enforce>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Slices a contact sheet from any tool (`--tool` names it) into frames under `--imports`, removes the background to the profile's style, and has a vision model propose animation families in `<import>/grouping.json` with status `proposed`. `--no-propose` skips that paid call. With `--bible`, the bible's prompt text makes the run's first call the prompt policy's model check on the decisions role, `--no-propose` or not; it fails closed (exit 4, or 2 `route_unavailable` when nothing serves the role). Without `--bible` there is no prompt text and no check. With `--lock-bible`, a locked subject's sheet is also scored against its identity lock, one paid call unless `--identity-mode off`. With `--frames`, a sheet that does not slice into exactly that many figures is refused (exit 2) before any model call. `--max-halo` sets the matte checks' limit on halo and leftover background (default 0.005 of edge pixels). Never writes into the target.

The optional `--origin <origin.json>` records a human-made or third-party declaration and its evidence, including any supplied source and licence. Its contents are included in the request digest.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, takes its `lock` (one a live process holds exits 2 `run_in_progress`), journals every call as `calls/<callKey>.json`, and writes `state.json` and `run.json` there. Repeating a request that finished returns its run with `reused: true` and no provider call; repeating an interrupted one pays only for the calls its journal lacks. `--round` (default 1) is part of the digest: a new round is a new run.

MCP tool: `import`, arguments `sheet`, `profile`, `asset`, `tool`, `origin`, `digitalSourceType`, `bible`, `subject`, `hints`, `frames`, `grid`, `components`, `maxHalo`, `noPropose`, `lockBible`, `identityMode`, `cap`, `imports`, `workItem`, `runs`, `round`.

### `generate-sheet`

```text
generate-sheet --spec <spec.json> --bible <BIBLE.md> --profile <profile.json> [--cap <usd>] [--imports .assetgrove/imports] [--lock-bible <BIBLE.md>] [--identity-mode <off|shadow|enforce>] [--brief <brief.json>] [--note <text>] [--max-halo <fraction>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Has the model draw a whole animation cycle as one sheet within the cap, then imports it as `import` does, with a proposed grouping for a person to confirm. A sheet that does not slice into the spec's `frames.count` figures exits 5; the sheet and its record are kept in the import directory. `--brief` adds the author's brief to the prompt; `--lock-bible` and `--identity-mode` score the sheet as `import` does, inside the forecast and the cap; `--max-halo` sets the matte limit as for `import`. Paid gateway calls. Never writes into the target.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, takes its `lock` (one a live process holds exits 2 `run_in_progress`), journals every call as `calls/<callKey>.json`, and writes `state.json` and `run.json` there. Repeating a request that finished returns its run with `reused: true` and no provider call; repeating an interrupted one pays only for the calls its journal lacks. `--round` (default 1) is part of the digest: a new round is a new run.

MCP tool: `generate_sheet`, arguments `spec`, `bible`, `profile`, `brief`, `note`, `maxHalo`, `cap`, `imports`, `lockBible`, `identityMode`, `workItem`, `runs`, `round`.

### `write-families`

```text
write-families --import <import directory> --target <target directory> [--grouping <import>/grouping.json] [--jitter-bound 1] [--json]
```

Writes one strip and manifest per family of a grouping whose status is `confirmed` into the target with review pending, registered within the jitter bound in pixels. The status grants nothing: a person confirms the write of these families and this grouping's digest through headless settings, a record at `<configDir>/confirmations/<hex>.json`, an MCP client's form, the inline prompt on a TTY, or exit 8 `confirmation_required` and `assetgrove confirm <hex>`. Runs the target's validator (exit 6 when it rejects), and refuses an output the target's licence cannot declare (exit 7) or a sheet the identity lock filtered. Calls no model and spends nothing. Only a person runs it.

MCP tool: `write_families`, arguments `import`, `target`, `grouping`, `jitterBound`.

### `identity-eval`

```text
identity-eval [--bible <BIBLE.md>] --cases <cases.json> [--profile <profile.json>] [--log <identity-eval.jsonl>] [--record] [--cap <usd>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Scores every case of a local labelled image set against its subject's identity lock and reports accuracy per threshold, the recommended threshold (among those whose false-accept rate is within the enforce bar, the one with the fewest false rejects; "none meets the bar" otherwise), accuracy at the profile's threshold and agreement with the cases' QA verdicts. Paid gateway calls. Writes one JSON line per case to `--log`; `--record` writes the recommended threshold, with the eval that produced it, to `identity-thresholds.json` beside `--bible`, keyed by question and decision model, which enforce mode requires (refused before any call without `--bible` or when a case names another bible, and after the eval when the recommended threshold does not meet the whole enforce bar). Writes nothing else beside its run directory; never filters or approves. Keep the set and the log local.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, takes its `lock` (one a live process holds exits 2 `run_in_progress`), journals every call as `calls/<callKey>.json`, and writes `state.json` and `run.json` there. Repeating a request that finished returns its run with `reused: true` and no provider call; repeating an interrupted one pays only for the calls its journal lacks. `--round` (default 1) is part of the digest: a new round is a new run.

MCP tool: `identity_eval`, arguments `bible`, `cases`, `profile`, `log`, `record`, `cap`, `workItem`, `runs`, `round`.

### `identity-check`

```text
identity-check --bible <BIBLE.md> [--subject <name>]... [--cap <usd>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Asks whether each identity record's written features, proportions and palette agree with the record's own approved reference images, for every identity in the bible or each named subject. Paid gateway calls; writes nothing beside its run directory. Exits 1 when any record disagrees or could not be checked; enforce mode does not filter with that record until a person fixes its text or references.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, takes its `lock` (one a live process holds exits 2 `run_in_progress`), journals every call as `calls/<callKey>.json`, and writes `state.json` and `run.json` there. Repeating a request that finished returns its run with `reused: true` and no provider call; repeating an interrupted one pays only for the calls its journal lacks. `--round` (default 1) is part of the digest: a new round is a new run.

MCP tool: `identity_check`, arguments `bible`, `subject`, `cap`, `workItem`, `runs`, `round`.

### `animation-qa`

```text
animation-qa (--strip <strip.png> --family <name> --profile <profile.json> | --import <import directory>) [--out .assetgrove/animation] [--subject <name>] [--spec <spec.json>] [--anchor x,y] [--no-vision] [--cap <usd>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Checks one strip, or every family `write-families` wrote from an import, against its motion template and for loop and continuity on pixels. Within the cap, vision calls judge identity flicker between consecutive frames and holes inside the figure; `--no-vision` skips both and spends nothing. Writes a QA report, an onion-skin sheet and a looping preview per family into `--out`, never into the target. Exits 5 when any check fails; each failure names its frame.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, takes its `lock` (one a live process holds exits 2 `run_in_progress`), journals every call as `calls/<callKey>.json`, and writes `state.json` and `run.json` there. Repeating a request that finished returns its run with `reused: true` and no provider call; repeating an interrupted one pays only for the calls its journal lacks. `--round` (default 1) is part of the digest: a new round is a new run.

MCP tool: `animation_qa`, arguments `strip`, `family`, `profile`, `import`, `out`, `subject`, `spec`, `anchor`, `noVision`, `cap`, `workItem`, `runs`, `round`.

### `fix-frame`

```text
fix-frame --strip <strip.png> --family <name> --profile <profile.json> --frame <n> (--from <n> | --key-pose <image>) --out <directory> [--subject <name>] [--spec <spec.json>] [--note <text>] [--provenance <strip>.provenance.json] [--bible <BIBLE.md>] [--anchor x,y] [--cap 2] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Regenerates one frame (1-based) of a strip with one paid reference-guided edit call, from an approved neighbour frame or the approved key pose, then, when its candidate scales (area, height, head box) register to different pixels and the strip has another frame to draw beside it, one paid `fix-scale` decision call that picks the scale at which the character matches the surrounding frames. Only that frame changes. Writes the fixed strip, its provenance with a fixes entry, and its QA report and previews into `--out`; never writes into the target or sets a review value. A provenance file that is not the strip's own record is refused (exit 2) before the call.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, takes its `lock` (one a live process holds exits 2 `run_in_progress`), journals every call as `calls/<callKey>.json`, and writes `state.json` and `run.json` there. Repeating a request that finished returns its run with `reused: true` and no provider call; repeating an interrupted one pays only for the calls its journal lacks. `--round` (default 1) is part of the digest: a new round is a new run.

MCP tool: `fix_frame`, arguments `strip`, `family`, `profile`, `frame`, `from`, `keyPose`, `out`, `subject`, `spec`, `note`, `provenance`, `bible`, `anchor`, `cap`, `workItem`, `runs`, `round`.

### `compare`

```text
compare <before> <candidate> [--region "<region>"]... [--frame <n>] [--view <n>] [--frame-width <px>] [--out .assetgrove/compare] [--json]
```

Free. Writes `<out>/compare.png`: a row with the version before, the candidate and a difference map (black where pixels are equal), region outlines drawn on all three, numbers only, so the sheet is pixel-identical when only card or bible text changes. Reports `identical`, `changed` (the share of all pixels) and `outsideChange`, the share of the figure's pixels changed outside every region, the figure being every pixel not fully transparent in the version before or in the candidate, less, when the version before has a one-colour opaque border such as a turntable render's grey backdrop, every pixel within 8 of that backdrop colour in both images (a pixel changed when a channel moves by more than 8 of 255); above 0.05, with regions given, it adds the advisory reason `changed_outside_region`. `--frame` names a strip's frame (frames are as wide as the strip is high unless `--frame-width`), `--view` a 3D asset's turntable view (give its `.glb`, or the directory of its renders). A region is `<x,y,w,h|mask=PATH> [frame N|view N] [ref PATH]... : <note>`; a box is pixels, or percent when every value ends in `%`; the note is optional here. A malformed region, or a path outside the project root, exits 2 `invalid_input`.

MCP tool: `compare`, arguments `before`, `candidate`, `region`, `frame`, `view`, `frameWidth`, `out`.

### `vary`

```text
vary --run <run> --candidate <id> [--count 4] [--cap <usd>] [--runs .assetgrove/runs] [--work-item <label>] [--provider-script <module>] [--round 1] [--dry-run] [--json]
```

Makes variations of one still candidate of a staged run: one reference-guided edit call each, with fresh seeds, after one spend confirmation. Writes `v<n>.<ext>` with provenance, `contact.png` and `compare.png` (each variation against the candidate) into its own run directory, and reports each variation's `outsideChange`. Variations are not QA-filtered and stay pending review. A repeat returns the finished run (`reused: true`) with no provider call; the plan step, run directory and `--round` work as for `stage`.

MCP tool: `vary`, arguments `run`, `candidate`, `count`, `cap`, `workItem`, `runs`, `round`.

### `audit`

```text
audit <set address> [--checks style,identity] [--bible <BIBLE.md>] [--target <dir>] [--cap <usd>] [--runs .assetgrove/runs] [--work-item <label>] [--provider-script <module>] [--round 1] [--dry-run] [--json]
```

The set-level audit. A set is any `asset://` folder of the tree; its members are the assets and run candidates it lists, over every page. Each member with a local image is scored from 0 to 1 for style (one `vision` call: the member against the bible's positive anchors and up to 4 other members) and, where its subject has an identity lock, for identity (one identity decision, which never filters). `--checks` takes `style`, `identity` or both (default), comma-separated or repeated; `--bible` defaults to the project's `.assetgrove/art-direction/BIBLE.md`. It asks for spend once; a repeat returns the finished run (`reused: true`) with no provider call, and an interrupted run resumes from its journal.

It writes `audit.json` and `audit-sheet.png` into its run directory and nothing into the project. `audit.json` holds each member's scores (`members[].style`, `members[].identity`, each with `advisory`), each score's `spread` (`n`, `mean`, `median`, `stdDev`, `min`, `max`, `range`), the set-consistency `bar` docs/decisions.md records, its `judgement` per score (`judged`, `consistent`, `beyond`) and `beyond`, the members more than the bar's distance below a score's median. Under the bar's set size of 5, or with no bar, nothing is judged. Each score is advisory (`filtering`) until its check (`audit-style`, `audit-identity`) has a qualifying stability entry. With the search package loaded, `outliers` is the set's embedding ranking at no cost, `{members, ranking: [{address, distance}], unranked}`, every member with an indexed image most distant first and uncut, and `unranked` the members with no indexed image yet (`search index` brings them in), and the human output names the five most distant and lists any not ranked; the audit judges no style from it (the search package's `find` does that, paid, with its outliers option); without the package `outliers` is `null`. The sheet numbers the members weakest first, numbers only, and `sheet` maps each number to its address. The audit informs a person: it never rejects or approves.

MCP tool: `audit`, arguments `set`, `checks`, `bible`, `target`, `cap`, `workItem`, `runs`, `round`.

### `request-change`

```text
request-change <address> --region "<x,y,w,h|mask=PATH> [frame N|view N] [ref PATH]... : <note>" [--region ...] [--keep-rest] [--candidates 2] [--bible <path>] [--cap <usd>] [--runs .assetgrove/runs] [--work-item <label>] [--provider-script <module>] [--round 1] [--dry-run] [--json]
```

Asks for a change to the current version of an asset. Each region is a box (pixels, or percent when every value ends in `%`) or `mask=PATH`, with an optional `frame N` or `view N`, `ref PATH` references and a note; paths resolve inside the project root. The job is a masked edit when the `edit` route's adapter declares the `mask` capability (core: `openai` and `scripted`; a single `mask=PATH` region sends that file), else an edit of the whole image with the notes. Regions that all name a `frame` go through `fix-frame`'s path, one edit per frame plus, when its candidate scales differ, one `fix-scale` decision per frame, both counted in the confirmed spend; `view` regions on a 3D asset (`.glb`) make another round of the 3D kind with the note and need `--bible`. Mixing frame and non-frame regions, a view on an image, or a region without a view on a 3D asset exits 2. Notes pass the prompt policy (a blocklisted note exits 9 before the confirmation), and the spend form shows each region and note. Each region is recorded as an `editing` annotation on the current version, so it turns changes-requested; masks and references are copied to `<assetId>.review/<sha256>.<ext>`. The working file must equal the current version, else exit 2 (adopt the hand edit first); the run that made the asset is read from `--runs`. Writes `c<n>.<ext>` with provenance, `contact.png`, `compare.png` and `run.json` with `changeRequest: {asset, version, answers}`, and reports each candidate's `outsideChange` (above 0.05 adds `changed_outside_region`). A repeat resumes from the journal or returns the finished run (`reused: true`). `pick` of a candidate answers the request; a candidate made on an older version exits 2 `version_changed`.

MCP tool: `request_change`, arguments `address`, `region`, `keepRest`, `candidates`, `bible`, `cap`, `workItem`, `runs`, `round`.

### `op`

```text
op <operation> <input...> --out <path> [--params <json object>] [--profile <profile.json>] [--digital-source-type <IPTC code or URI>] [--json]
```

Runs one image operation (`ops` lists them) over the inputs and writes the outputs and a provenance record to `--out`: a file for one output, otherwise a directory. The profile supplies the style and frame size. Local: no model call, no spend.

MCP tool: `op`, arguments `operation`, `inputs`, `out`, `params`, `profile`, `digitalSourceType`.

### `recipe`

```text
recipe <recipe.json> <input...> --out <path> [--profile <profile.json>] [--digital-source-type <IPTC code or URI>] [--json]
```

Runs a recipe file's operations in order over the inputs and writes the outputs and a provenance record to `--out`. Deterministic: the same input, recipe and engine versions give the same bytes. Local: no model call, no spend.

MCP tool: `recipe`, arguments `recipe`, `inputs`, `out`, `profile`, `digitalSourceType`.

### `rendition`

```text
rendition --recipes <directory> --recipe <name> --source <image> --source-sha256 <64-hex-sha256> --out <directory> [--source-provenance <record.json>] [--profile <profile.json>] [--digital-source-type <IPTC code or URI>] [--preview] [--json]
```

Selects `<name>.json` from the project's recipe directory and builds deterministic image
renditions from the exact mezzanine bytes named by `--source-sha256`. Outputs and provenance go
under `<out>/<digest>/`; resolved recipe parameters and tool versions participate in the digest.
`--preview` is a write-free dry run showing exact output paths and hashes, also available over
MCP. Existing source provenance is retained when supplied explicitly or found at
`<source>.provenance.json`. Known disclosure survives; writing an undeclared source requires
`--digital-source-type`. Local raster operations only: no model call, external tool or spend.
Does not approve assets or add library versions.

MCP tool: `rendition`, arguments `recipes`, `recipe`, `source`, `sourceSha256`, `out`, `sourceProvenance`, `profile`, `digitalSourceType`, `preview`.

### `deliver`

```text
deliver --selection <delivery.json> --out <directory> [--profile <profile.json>] [--preview] [--draft] [--json]
```

Delivers an explicit set of exact library versions. The selection file lists items of asset card,
version (stack number or sha256), recipe name and destination folder; each version's mezzanine
bytes come from the library media or the local Git LFS store, never fetched. Writes the
renditions and a `delivery.json` manifest under `--out`, all or nothing. `--preview` is a dry run
that resolves content hashes and destination paths and writes nothing, also available over MCP.
A missing object, version, asset or recipe, or an output collision, is reported for every item
before any write: exit 2 `invalid_input` with `error.problems [{file, code, problem}]`. An existing
identical file is accepted; a differing one is a collision. A release delivery (no `--preview`, no
`--draft`) is also the release gate: a version a person marked as a placeholder (with `review`) is refused
(`placeholder_selected`), and when the `--profile`'s `release` policy enables them, a version that
is not approved (`version_unapproved`, `requireApproval`) or whose card licence is outside a
`licenseWindows` entry on the delivery date in the policy's `timeZone`, read as an SPDX expression
that fails closed on a missing or unparsable licence (`license_window`); each problem names the asset,
version, sha256 and evidence, and `policy` lists every check with its evidence. `--preview` and
`--draft` (which writes the delivery with `"draft": true` in `delivery.json`) report the same
`policy` findings without refusing on them; `release` is true only for a written release delivery.
Local raster operations only: no model call or spend. Does not approve assets, add library
versions or change the current pick.

MCP tool: `deliver`, arguments `selection`, `out`, `profile`, `preview`, `draft`.

### `ops`

```text
ops [--json]
```

Lists every operation with its summary, parameters and engines. Local.

MCP tool: `ops`, no arguments.

### `migrate`

```text
migrate <file> --kind <kind> [--json]
```

Adds the format line of `--kind` (`target-profile`, `style-bible`, `style-preset` or `recipe`) to a file that has none, and moves a file with an older format forward, rewriting it in place. JSON files are rewritten with two-space indentation; Markdown files keep their front matter comments, key order and prose. A file already current is not written. A newer or mismatched format is refused (exit 2). The result names the `file`, `kind`, `status` (`added`, `migrated` or `current`), `from` (the old version, or null) and `format`. Local: no model call, no spend.

MCP tool: `migrate`, arguments `file`, `kind`.

### `library check`

```text
library check [--target <dir>] [--profile <profile.json>] [--json]
```

Checks the library under the profile's `library.root` (default profile `<target>/.assetgrove/profile.json`): every pick has a card and a review record, each card's machine fields match the records, and media is mapped to Git LFS (`git check-attr filter`; skipped outside a Git repository). Indexes, logs and review records are compared after normalising order and duplicate headings, so a union merge passes; a file that differs only in layout is listed under `needsRebuild`. Exit 6 `library_check_failed` with `error.problems` `[{file, code}]` (codes `card_missing`, `card_invalid`, `review_missing`, `review_invalid`, `media_missing`, `media_not_lfs`, `machine_field_mismatch`, `index_*` and `log_*` with `missing`, `mismatch` or `invalid`). Read-only.

MCP tool: `library_check`, arguments `target`, `profile`.

### `library rebuild`

```text
library rebuild [--target <dir>] [--profile <profile.json>] [--json]
```

Rewrites every card's machine fields, every `index.md` and `log.md` and the canonical layout of review records from the records, under the library write lock; the root log keeps its style bible lines. A second run changes nothing. `rebuilt` lists the files written; problems the records cannot fix still exit 6 `library_check_failed`.

MCP tool: `library_rebuild`, arguments `target`, `profile`.

### `library labels`

```text
library labels [--target <dir>] [--dry-run] [--apply] [--json]
```

Previews mappings, collisions, unknown labels and affected cards using the project's `.assetgrove/labels.json`. The default is a dry run. Use `--apply` to normalize known labels and update indexes while preserving unknown values and summary attribution. Resolve collisions before applying.

MCP tool: `library_labels`, arguments `target`, `apply`.

### `library stats`

```text
library stats [--target <dir>] [--profile <profile.json>] [--json]
```

Counts assets by `kind` and `state`, and reports `changeRequests` `{total, approvedWithinTwoVersions, share}`: a change request counts when one of the next two versions after the one it targets is approved. Read-only.

MCP tool: `library_stats`, arguments `target`, `profile`.

### `library worklist`

```text
library worklist [--target <dir>] [--profile <profile.json>] [--open] [--json]
```

Lists every review note of the library (each `editing` or `commenting` annotation on a version) with its `state` (`open` or `resolved`), its anchor, `source` (the version it was written on, with its `asset://<game>/<asset>/versions/<n>` link) and, when one is recorded, `resolution` (the answering version and its confirmation, or the `resolve` annotation). `--open` lists only open notes. Note text is returned only under `sharedText`. Read-only.

MCP tool: `library_worklist`, arguments `target`, `profile`, `open`.

### `library relations`

```text
library relations [--target <dir>] [--profile <profile.json>] [--asset <id>] [--sha256 <hash>] [--json]
```

Browse recorded `derived-from`, `variant-of` and `part-of` links in both directions. Use `--asset` to select a library-relative asset id and add `--sha256` to select a specific version. The report includes recorded and current hashes for changed sources and the exact downstream versions that depend on them, directly or indirectly. Read-only.

MCP tool: `library_relations`, arguments `target`, `profile`, `asset`, `sha256`.

### `library diff`

```text
library diff [--target <dir>] --base <ref> --head <ref> [--json]
```

Compare committed asset versions, labels, reviews and tracked renditions in the target Git repository (default current directory). Print Markdown for a pull request or structured JSON. Available previews identify a commit and path, and missing or corrupt local LFS objects are reported without previews. Read-only.

MCP tool: `library_diff`, arguments `target`, `base`, `head`.

### `library drift`

```text
library drift [--target <dir>] [--profile <profile.json>] [--bible <bible>] [--json]
```

Lists `otherVersion`: every asset whose card's bible differs from the style bible's version (compared for equality, not order, so a rollback or a renamed version counts; default bible `<target>/.assetgrove/art-direction/BIBLE.md`), each with `bible`, `sha256` and its cached `judgement` (`redo`, `keep`, or `unjudged` until `library judge-stale` answers); `stale`: those judged to need redoing; and `modified` ones (the file's sha256, or a Git LFS pointer's oid, differs from the card's `lock.sha256`; a matching pointer is not modified). Computed from the cards and the cached judgements; no model call, nothing stored or logged. Read-only.

MCP tool: `library_drift`, arguments `target`, `profile`, `bible`.

### `library judge-stale`

```text
library judge-stale [--target <dir>] [--profile <profile.json>] [--bible <bible>] [--asset <id>]... [--cap <usd>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

For each asset made under another bible version whose answer is not cached (or each named `--asset`), makes one `bible-staleness` decision ($0.001 estimate on the default route): given the bible's diff between the two versions (from the bible file's Git history), the asset's kind, subject and tags, and its thumbnail, should it be redone? Each answer is cached by the asset's sha256 and the version pair in `<stateDir>/staleness/`, where `library drift` and `asset://<game>/stale/` read it. An asset with no thumbnail on this machine (a Git LFS pointer, an undecodable file, a GLB with no turntable renders) is not judged and stays unjudged. Returns `bibleVersion`, `otherVersion` (the count of every asset made under another version, as `library drift` counts it, whatever `--asset` names), `judged` (`asset`, `bible`, `sha256`, `redo`, `probability`, `history`, `cached`), `stale` (the asset ids judged to need redoing), `noThumbnail` (the asset ids left unjudged for want of a thumbnail) and `spentUsd`. Paid gateway calls; writes nothing beside its run directory and the cache. A style bible with no version exits 2.

Plan step: `--dry-run` prints the request's WorkPlan with no provider call, no ledger entry and nothing written; the forecast counts one call per asset not yet judged for its version pair that has a thumbnail. A real run is confirmed and journaled as for `identity-check`, but a finished run is not returned as it ended: the same request runs again in its run directory, its journal answering every call it holds, so a lost cache is refilled with nothing paid twice.

MCP tool: `library_judge_stale`, arguments `target`, `profile`, `bible`, `asset`, `cap`, `workItem`, `runs`, `round`.

### `settings`

```text
settings <path|show|check> [--json]
```

Reads the developer settings and changes nothing. `path` gives the settings file, whether it exists, and the config and state directories. `show` gives the settings with every default filled; per provider, the key variable's name and whether it is set, never a key. `check` reports per provider whether a key is present and a limit is declared and verified against the provider's reading, where a call's cost comes from (`settle`: `reported` or `declared`) and whether it can be looked up later (`reconcile`: `lookup` or `unavailable`), and any refused environment variable; with one refused, it reads no provider. Local: no model call, no spend.

MCP tool: `settings`, argument `action`.

### `settings change`

```text
settings change [--run-usd <usd>] [--daily-usd <usd>] [--work-item-usd <usd>] [--provider <id> --limit-kind <kind> [--limit-usd <usd>] [--limit-period <period>] [--accept-unlimited]] [--acknowledge-holds <hold>...] [--acknowledge-blobs <blob>...] [--json]
```

Proposes a change that only a person's confirmation writes: the caps (`caps.runUsd`, `caps.dailyUsd`, `caps.workItemUsd`), one provider's `limit` (`--limit-kind` is `key-budget`, `team-budget`, `project-hard-limit`, `workspace-limit`, `prepaid` or `unlimited`) spend holds to acknowledge (`spend.acknowledgedHolds`) and tracked file contents whose by-name key assignment a person has checked is not a live key, by Git blob id (`keyGuard.acknowledgedBlobs`; the id the `key_tracked` refusal names). It takes no other field. An MCP client with form elicitation shows the person a flat form with the proposed values filled in and `acceptUnlimited` as its own Boolean; on accept, the values the person submitted are written (method `elicitation`). Without such a client it exits 8 `confirmation_required` with `error.confirmation` (`kind` `settings`) and saves the request to `<stateDir>/pending/<hex>.json`; `assetgrove confirm <hex>` at a terminal writes it (method `terminal`). A write changes only those fields and adds one `confirmedBy` entry per field path (`{method, at, client?}`); every other byte of the file stays as it was. A limit for a core adapter id that has no provider entry creates the entry with only `limit`. `unlimited` is written only with `acceptUnlimited` true; otherwise the result lists it under `notWritten` and the provider stays undeclared. Headless settings exit 8 `confirmation_required` and write nothing. A provider that is neither in the settings nor a core adapter id, or a hold id `<stateDir>/holds.jsonl` does not list, exits 2 `invalid_input` before anything is asked. A decline exits 8 `confirmation_declined`. Returns `{id, method, path, written, notWritten}`. Local: no model call, no spend.

MCP tool: `settings_change` (marked as requiring the person), arguments `runUsd`, `dailyUsd`, `workItemUsd`, `provider`, `limitKind`, `limitUsd`, `limitPeriod`, `acceptUnlimited`, `acknowledgeHolds`, `acknowledgeBlobs`.

### `doctor`

```text
doctor --profile <profile.json> [--target <target directory>] [--json]
```

Asks each hand-off preset of the profile that has a `doctor` (the Godot pack's presets do) to check the target, and lists every finding under `findings`: `{code, path, line?, problem, correction, presets}`, the exact path relative to the target and a safe correction for the developer to make; a preset whose doctor fails is listed under `errors` and does not stop the others. Core adds `lfs-rules-outdated` (presets `core`) when the library root's `.gitattributes` holds init's managed block but Git does not send every media type it names (`.wav` and `.ogg` among them) to LFS; running `init` again fixes it. Core also adds `provider-account` (presets `core`) for each configured provider whose adapter reads its account's plan (ElevenLabs' tier, from its subscription endpoint) when that plan is one Assetgrove refuses, such as ElevenLabs' free tier, or cannot be read; its `path` is the settings file as given, not a target path. Findings are sorted by path, line and code. `--target` defaults to the current directory. Read-only: it writes nothing in the target, its settings or `.git`, and exits 0 with or without findings. No model call, no spend; the only network call is that account read.

MCP tool: `doctor`, arguments `profile`, `target`.

### `extensions`

```text
extensions [--json]
```

Lists what loaded: core first, then each extension the developer settings' `extensions` list names, as `{name, package, version, entry, kinds, presets, adapters}` under `extensions`. An extension loads only when the settings list its package, it resolves from the project, its declared `api` matches (checked before import) and no Git work tree at or above its entry file tracks it; otherwise every command exits 2 with `extension_unavailable`, `extension_refused` or `extension_conflict` (see docs/extensions.md). A shared file naming an `<ext>:<name>` kind or preset of an extension that did not load exits 2 `extension_unavailable`. Local: no model call, no spend.

MCP tool: `extensions`, no arguments.

### `extensions setup`

```text
extensions setup <name> [--json]
```

Runs the `setup` of the loaded extension `<name>` (a name from `extensions`; the search package's is its model download). Every file it downloads is pinned to a version and a sha256 the extension ships and is checked before use, landing under `<stateDir>/models`; a mismatch deletes the file and exits 4 `provider_error` (`hash_mismatch`), and when every host fails it exits 4 (`setup_failed`). An unknown name, or an extension that declares no setup, exits 2. Returns `extension` and what the setup returned. Free; writes only under the state directory.

MCP tool: `extensions_setup`, argument `name`.

### `spend`

```text
spend <status|check> [--provider <id>] [--work-item <label>] [--provider-script <module>] [--json]
```

`status` gives the ledger (`<stateDir>/spend.jsonl`), the caps from the settings, the last 24 hours' spend, the work item (`--work-item` or `ASSETGROVE_WORK_ITEM`) with its spend, and `holds`, each spend hold (`<stateDir>/holds.jsonl`) with whether the settings' `spend.acknowledgedHolds` lists it, and `expiredLookups`, each per-call cost lookup that went unanswered past `reconcile.pendingMaxAgeHours` and was resolved as failed with nothing compared (`{id, provider, runId, at, resolvedAt}`). `check` reports per configured provider (`--provider` narrows it) `{provider, adapter, paid, declared, limit, verified, reading, mismatch, note}`: whether a limit is declared, the provider's reading where it gives one to an ordinary key (gateway credits balance, Tripo balance), and whether the reading verifies the limit. A reading verifies only a `prepaid` limit with `usd` (balance at or below it); a balance above it exits 3 with `provider_limit_mismatch`. Anthropic and OpenAI limits are declared only. `--provider-script` names the scripted provider's module, whose `limitReading` check reads. No spend, nothing written.

MCP tool: `spend`, arguments `action`, `provider`, `workItem`. The provider script flag is CLI-only.

### `spend reconcile`

```text
spend reconcile [--provider-script <module>] [--json]
```

Retries each pending reconcile lookup (`<stateDir>/reconcile.jsonl`): a paid run whose per-call costs the provider had not reported when the run ended. Returns `reconciled`, one `{provider, status, method, runId, ledgerUsd, providerUsd, gapUsd, marginUsd, holdId, pendingId, unmatched, settled, note}` per lookup, with `status` `pending` (not reported yet), `reconciled`, `held` or `failed` (none of its calls could be looked up, or still unreported `reconcile.pendingMaxAgeHours`, default 24, after its run; it is not retried again, and `spend status` lists it under `expiredLookups`). Only calls whose ledger cost came from the provider are compared; a call the ledger settled at the route's estimate is settled to the looked-up cost and never holds. A gap above max(`reconcile.marginUsd`, `reconcile.marginPct`% of the ledger spend) appends a hold, and every paid command then exits 3 `spend_hold` until the hold's id is in the settings' `spend.acknowledgedHolds`. A paid run also retries pending lookups at its start. `--provider-script` names the scripted provider's module, whose `callCost` the lookups read. Reads the providers' usage; no spend; writes only under the state directory.

MCP tool: `spend_reconcile`, no arguments. The provider script flag is CLI-only.

### `runs list`

```text
runs list [--runs <dir>] [--json]
```

Lists every run directory (`r-<16 hex of the request digest>`) under `--runs` (default `.assetgrove/runs`): `{runId, runDir, command, digest, status, startedAt, finishedAt, exitCode, attempts, calls, forecastUsd, capUsd}`. `status` is `running`, `finished`, `failed`, or `interrupted` when the process running it is gone; `calls` counts the run's journal. Local: no model call, no spend, nothing written.

MCP tool: `runs_list`, argument `runs`.

### `runs show`

```text
runs show <r-16hex> [--runs <dir>] [--json]
```

Shows one run: the fields `runs list` gives, its `request` (`request.json`, the WorkPlan), `state` (`state.json`), `record` (`run.json`) and `journal`, each journaled call's `{callKey, operation, provider, model, costUsd, costSource, requestId}`. An unknown run id exits 2. Local: no model call, no spend, nothing written.

MCP tool: `runs_show`, arguments `run`, `runs`.

### `ls`

```text
ls <address> [--target <dir>] [--json]
```

Lists a folder of the library's `asset://<game>/` tree (the project at `--target`, default the working directory's Git top level, whose `.assetgrove/profile.json` names the game and library root): the game root, `by-kind/<kind>/`, `by-subject/<subject>/`, `by-tag/<tag>/`, `stale/`, `runs/`, `runs/<run>/`, `<asset>/` or `<asset>/versions/`. Returns the folder's JSON document `{address, kind: "folder", children: [{address, name, kind, state?}], next?}`, the same one `resources/read` returns: at most 200 children per read, `next` the address of the next page. Card text appears only under `sharedText`. A file address, an unknown address or a card naming a path outside the library root exits 2 `invalid_input`. Local: no model call, no spend, nothing written.

MCP tool: `ls`, arguments `address`, `target` (default: the server's project).

### `cat`

```text
cat <address> [--target <dir>] [--out <file>] [--json]
```

Reads any address of the tree and returns `{address, contents}`, the contents `resources/read` returns (each `{uri, mimeType, text}` or `{uri, mimeType, blob}`): a folder's JSON document (and the root's `index.md`); `<asset>/card` and `log` as Markdown; `provenance` and `review` as JSON; `image` a PNG thumbnail of at most 512 px (a strip's key-frame row; a 3D asset's path and turntable frames); `image/full` the file; `versions/<n>` the version record with its image while the bytes are in the working file, a run folder or the local LFS store; `runs/<run>/<candidate>` the candidate's QA reasons and cost. No read's encoded content exceeds 64 KB: what would is replaced by a pointer `{path, mediaType, bytes, tooLarge: true}`. `--out` (CLI only) writes the file the address names (the whole file for `image/full`). Thumbnails are cached in `<stateDir>/thumbs/`. No model call, no spend. The tool is read-only and writes no file. Its result carries the read once: the result document's `contents` lists each `{uri, mimeType}`, and the content follows in the same order, an image as image content and anything else as an embedded resource.

MCP tool: `cat`, arguments `address`, `target` (default: the server's project).

### `estimate`

```text
estimate <command> [--args <json>] [--work-item <label>] [--provider-script <module>] [--json]
```

Runs a paid command's free plan step (`plan`, `apply`, `stage`, `generate-sheet`, `import`, `materials`, `look-dev`, `animation-qa`, `fix-frame`, `identity-eval`, `identity-check`) and returns what that command prints with its dry-run flag and `--json`, its `command` field naming that command: the WorkPlan's `jobs` (operation, provider, model, count and per-call estimate), `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` (sha256 of each input file), `options`, the request `digest` and the `runDir` it would run in, with the spend left under the ledger's limits; exit 3 when the forecast is over the cap or a limit. `--args` is a JSON object of the command's tool arguments (no CLI-only option). The digest is the sha256 of the canonical JSON of the command, round, inputs, options, jobs, forecast and cap: the same request gives the same digest. A free or unknown command exits 2, as does a call that spends nothing under these settings: `find` and `search index` with the local model (`search.embedder` not `"route"`), except `find` with `outliers`, which asks paid `style-outlier` decisions under every embedder. No provider call, no ledger entry, nothing written.

MCP tool: `estimate`, arguments `command`, `args`, `workItem`.

### `confirm`

```text
confirm <hex> [--json]
```

Confirms a pending spend, pick, write, policy, command or settings request at a terminal. A policy request is a borderline prompt-policy answer (from the route's `confirmAt` up to its `refuseAt`); it shows the command, the request digest, the policy text hash, the deciding model and its probability, and only a person clears it (headless settings do not). A settings change (from `settings change`) writes its fields and their `confirmedBy` entries into the settings file it names (method `terminal`). A spend, pick or write request (id its digest) writes `<configDir>/confirmations/<hex>.json` (method `terminal`); a pick that names no candidate asks which one, and `none` declines. What it shows is rebuilt from what the id hashes, never from the saved file's text: a spend's command, jobs, forecast, cap, providers and digest from its digest body, and a pick's run, contact sheet and candidates or a write's families from the run or the import and grouping, which must make the same id (exit 2 when they no longer do). A command that exits 8 `confirmation_required` because a command a file names (a profile's validator, a profile style's material compression or preview command, or the CLI's provider script module) has no approval saves the request to `<stateDir>/pending/<hex>.json`; `confirm <hex>` shows its kind, argv, cwd and file hashes and asks. An accept writes `<configDir>/approvals/<hex>.json` (method `terminal`) and the command runs on the next try; a decline exits 8 `confirmation_declined`. Without a TTY on stdin and stderr, with no pending request of that id, or with one whose kind, argv, cwd and files do not hash to that id (an edited or corrupted file), it exits 2 before asking. Headless settings ignore these records: list the hash in `commands.approved` instead. Local: no model call, no spend. CLI only; no MCP tool serves it.

### `disclosure`

```text
disclosure [<root>] [--selected <media-path>]... [--out <file>] [--json]
```

Reads the cards under `<root>` (the current directory by default) and the provenance each names, and reports assets by kind and source type, models, providers, and provider terms with their dates, then text for Steam's AI content survey and itch.io's AI tags. No prompt text is read or shown. `--out` also writes the summary there as Markdown, to a path inside the current directory. The marks and the summary help users and stores; they make no claim of compliance with any law. Spends nothing; read-only.

Repeat `--selected` for each release media file, using exact paths relative to the library root with forward slashes. Omit it to report on the whole library. The Godot and Playdate sections name media with AI evidence and media with unresolved evidence.

MCP tool: `disclosure`, arguments `root`, `out`, `selected` (array of media paths).
