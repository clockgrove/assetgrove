# Assetgrove commands

One section per command: its usage, its flags, and the MCP tool that serves it and that tool's arguments. Every command takes `--help`; every command except `mcp` takes `--json`. Paid commands reserve every call against their `--cap` (USD) and against the spend ledger; `--cap` may only lower the settings' `caps.runUsd` (see [Environment](../SKILL.md#environment)). Commands that stage write under `.assetgrove/` in the working directory by default; only `bible init`, `bible preset`, `pick` and `write-families` write into the target.

### `bible`

```text
bible describe --bible <BIBLE.md> [--json]
bible init --directory <target repository> --world <name> --preset <preset> [--json]
bible preset --bible <BIBLE.md> --preset <preset> [--json]
```

`describe` reads a world's art constitution (art direction, bounds, anchors, presets, identity locks) as JSON. `init` writes into the target repository a bible at `.assetgrove/art-direction/BIBLE.md` with its presets, an `art-direction` skill under `.claude/skills/` and `.agents/skills/`, and a prompt template at `.assetgrove/prompts/default.md`; it refuses to overwrite any of them. `preset` rewrites the bible's look and tone from one of its presets and keeps the world's palette, anchors and identity locks; `apply` then refuses plans made from the earlier bible. The presets are `cozy-storybook`, `flat-cartoon-kids` and `dark-gritty-isometric`. Calls no model and spends nothing. The MCP tool is one tool whose `action` argument (`describe`, `init` or `preset`) picks the subcommand.

MCP tool: `bible`, arguments `action`, `bible`, `directory`, `world`, `preset`.

### `plan`

```text
plan --spec <spec.json> --bible <BIBLE.md> --profile <profile.json> --out <plan.json> [--brief <brief.json>] [--settings <settings.json>] [--template <template.md>] [--identity-mode <off|shadow|enforce>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Compiles a reviewable generation plan into `--out` and never generates images. With a provider (`AI_GATEWAY_API_KEY` or `--provider-script`), the configured compiler LLM writes the prompt and negatives from the repository's templates in one model call; without one, a marked deterministic template fallback is recorded. `--identity-mode` overrides the profile's identity mode for a character with an identity lock, and the forecast includes the scoring calls. Show the plan's prompts, clamps and cost forecast to the human. Writes only the plan file and its run directory. Its forecast is the planning call plus every generation, QA and identity call the later `apply` runs.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, and its `run.json` there. `--round` (default 1) is part of the digest.

MCP tool: `plan`, arguments `spec`, `bible`, `profile`, `out`, `brief`, `settings`, `template`, `identityMode`, `workItem`, `runs`, `round`.

### `apply`

```text
apply <plan.json> [--auto-approve] [--out <runs directory>] [--work-item <label>] [--provider-script <module>] [--round 1] [--dry-run] [--json]
```

Generates exactly a saved plan. It refuses stale bible, template and identity inputs, and a plan whose `approved` field a human has not set to `true`, unless `--auto-approve` is given for an unattended campaign; the MCP tool has no such option, so a plan must be approved first. Approval authorizes the generation spend only; the outputs stay pending review. Paid gateway calls; needs `AI_GATEWAY_API_KEY` or `--provider-script` (exit 4 without either). Stages the run under `--out` (default `.assetgrove/runs`), never in the target.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--out`, and its `run.json` there. `--round` (default 1) is part of the digest.

MCP tool: `apply`, arguments `plan`, `out`, `workItem`, `round`.

### `mcp`

```text
mcp [--work-item <label>] [--provider-script <module>]
```

Serves one MCP tool per command other than `mcp` over MCP stdio with the official MCP SDK; each tool takes its command's arguments and returns the same result document as the command's JSON output (as `structuredContent`, with `isError` set when the result is not ok), and file paths are local to the server. Stdout carries the protocol, so it prints no JSON document; logs go to stderr. Spends and writes as the commands it serves do. Like every paid command, it exits 2 `settings_invalid` when a TLS or proxy variable is set that the settings' `environment.allow` does not list.

### `materials`

```text
materials --albedo <painted.png> --spec <spec.json> --profile <profile.json> --derivation <derivation.json> --out <directory> [--cap <usd>] [--work-item <label>] [--digital-source-type <IPTC code or URI>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Derives the material channels the profile's `style.materials` requests from a painted albedo, checks alignment and temporal stability, writes native-resolution renditions into `--out`, runs the target's compression and lit previews, and judges the flat and lit images with vision QA. The compression and preview commands run only with an approval tied to each command's hash, exactly as `pick`'s validator does (cwd: the profile's directory); every one is checked before the first model call, exit 8 `confirmation_required` otherwise, and each output's provenance records the command's `hash` and approval `method`. Paid gateway calls (vision QA and any model-assisted channel). Rejected materials exit 5 and stay unapproved. Never writes into the target.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, and its `run.json` there. `--round` (default 1) is part of the digest.

MCP tool: `materials`, arguments `albedo`, `spec`, `profile`, `derivation`, `out`, `cap`, `workItem`, `digitalSourceType`, `runs`, `round`.

### `stage`

```text
stage --spec <spec.json> --bible <bible.json> --profile <profile.json> [--candidates 4] [--cap <usd>] [--runs .assetgrove/runs] [--work-item <label>] [--provider-script <module>] [--round 1] [--dry-run] [--json]
```

Generates candidates within the cap and stages only those that pass QA, with reasons and provenance, in a run directory under `--runs`. `--dry-run` prints the planned calls, the cost forecast and the spend left under the ledger's limits, writes nothing and needs no key. Image kinds make paid gateway calls. A `character-3d` spec makes rigged, animated `.glb` candidates from the subject's approved turnaround: its 3D calls go to Tripo (`TRIPO_API_KEY`) and its identity call to the gateway. A sprite-strip spec needs an approved `keyPose`. Never writes into the target.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, and its `run.json` there. `--round` (default 1) is part of the digest.

MCP tool: `stage`, arguments `spec`, `bible`, `profile`, `candidates`, `cap`, `runs`, `workItem`, `round`.

### `pick`

```text
pick --run <run directory> --candidate <id> --target <target directory> [--json]
```

Writes the chosen candidate and its manifest into the target with review pending, then runs the target profile's validator command locally when it declares one (exit 6 when it rejects). The validator is a command a file names, so it runs only with an approval tied to its exact command hash (kind, argv template, cwd relative to the target's Git top level, and the bytes of each argv file under it): listed in the settings' `commands.approved`, or a record at `<configDir>/approvals/<hash>.json`. Otherwise pick asks at a TTY and records the accept, or exits 8 `confirmation_required` before writing anything, with `error.confirmation` carrying `id` (the hash), `confirmCommand` and `command` (`kind`, `hash`, `argv`, `cwd`, `files`); `confirm` approves it. Under headless settings only `commands.approved` counts. On Windows a validator whose program resolves to a `.cmd` or `.bat` file exits 2 `command_refused`. The provenance's `commands` records the validator's hash and approval `method` (`settings`, `tty` or `terminal`). Refuses, before writing, an output the target's licence cannot declare (exit 7). Calls no model and spends nothing. Only a person runs it.

MCP tool: `pick`, arguments `run`, `candidate`, `target`.

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
look-dev --model <model.glb> --provenance <provenance.json> --spec <spec.json> --bible <bible.json> --profile <profile.json> [--cap <usd>] [--runs .assetgrove/runs] [--work-item <label>] [--provider-script <module>] [--round 1] [--dry-run] [--json]
```

Repaints a picked 3D character's base colour on its own UVs in the look the bible's approved references define, writes fur groom maps and tint textures per season the profile declares (`model3d.groom`), gives the eyes a glossy material and mask, and checks them. Stages a one-candidate run with before-and-after renders under `--runs` for a person to pick. Paid gateway calls; the cap defaults to the profile's `model3d.lookdev.capUsd` or $3. Exits 5 when the result fails its checks.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, and its `run.json` there. `--round` (default 1) is part of the digest.

MCP tool: `look_dev`, arguments `model`, `provenance`, `spec`, `bible`, `profile`, `cap`, `runs`, `workItem`, `round`.

### `import`

```text
import --sheet <sheet.png> --profile <profile.json> --asset <id> --tool <name> [--bible <bible.json>] [--subject <name>] [--hints idle,walk-right,...] [--frames <count>] [--grid <columns>] [--components] [--no-propose] [--cap <usd>] [--work-item <label>] [--imports .assetgrove/imports] [--digital-source-type <IPTC code or URI>] [--provider-script <module>] [--lock-bible <BIBLE.md>] [--identity-mode <off|shadow|enforce>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Slices a contact sheet from any tool (`--tool` names it) into frames under `--imports`, removes the background to the profile's style, and has a vision model propose animation families in `<import>/grouping.json` with status `proposed`. `--no-propose` skips that paid call. With `--lock-bible`, a locked subject's sheet is also scored against its identity lock, one paid call unless `--identity-mode off`. With `--frames`, a sheet that does not slice into exactly that many figures is refused (exit 2) before any model call. Never writes into the target.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, and its `run.json` there. `--round` (default 1) is part of the digest.

MCP tool: `import`, arguments `sheet`, `profile`, `asset`, `tool`, `digitalSourceType`, `bible`, `subject`, `hints`, `frames`, `grid`, `components`, `noPropose`, `lockBible`, `identityMode`, `cap`, `imports`, `workItem`, `runs`, `round`.

### `generate-sheet`

```text
generate-sheet --spec <spec.json> --bible <bible.json> --profile <profile.json> [--cap <usd>] [--imports .assetgrove/imports] [--lock-bible <BIBLE.md>] [--identity-mode <off|shadow|enforce>] [--brief <brief.json>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Has the model draw a whole animation cycle as one sheet within the cap, then imports it as `import` does, with a proposed grouping for a person to confirm. A sheet that does not slice into the spec's `frames.count` figures exits 5; the sheet and its record are kept in the import directory. `--brief` adds the author's brief to the prompt; `--lock-bible` and `--identity-mode` score the sheet as `import` does, inside the forecast and the cap. Paid gateway calls. Never writes into the target.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, and its `run.json` there. `--round` (default 1) is part of the digest.

MCP tool: `generate_sheet`, arguments `spec`, `bible`, `profile`, `brief`, `cap`, `imports`, `lockBible`, `identityMode`, `workItem`, `runs`, `round`.

### `write-families`

```text
write-families --import <import directory> --target <target directory> [--grouping <import>/grouping.json] [--jitter-bound 1] [--json]
```

Writes one strip and manifest per family of a grouping whose status a person set to `confirmed` into the target with review pending, registered within the jitter bound in pixels. Runs the target's validator (exit 6 when it rejects), and refuses an output the target's licence cannot declare (exit 7) or a sheet the identity lock filtered. Calls no model and spends nothing. Only a person runs it.

MCP tool: `write_families`, arguments `import`, `target`, `grouping`, `jitterBound`.

### `identity-eval`

```text
identity-eval [--bible <BIBLE.md>] --cases <cases.json> [--profile <profile.json>] [--log <identity-eval.jsonl>] [--cap <usd>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Scores every case of a local labelled image set against its subject's identity lock and reports accuracy per threshold, the recommended threshold, accuracy at the profile's threshold and agreement with the cases' QA verdicts. Paid gateway calls. Writes one JSON line per case to `--log` and nothing else beside its run directory; never filters or approves. Keep the set and the log local.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, and its `run.json` there. `--round` (default 1) is part of the digest.

MCP tool: `identity_eval`, arguments `bible`, `cases`, `profile`, `log`, `cap`, `workItem`, `runs`, `round`.

### `identity-check`

```text
identity-check --bible <BIBLE.md> [--subject <name>]... [--cap <usd>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Asks whether each identity record's written features, proportions and palette agree with the record's own approved reference images, for every identity in the bible or each named subject. Paid gateway calls; writes nothing beside its run directory. Exits 1 when any record disagrees or could not be checked; enforce mode does not filter with that record until a person fixes its text or references.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, and its `run.json` there. `--round` (default 1) is part of the digest.

MCP tool: `identity_check`, arguments `bible`, `subject`, `cap`, `workItem`, `runs`, `round`.

### `animation-qa`

```text
animation-qa (--strip <strip.png> --family <name> --profile <profile.json> | --import <import directory>) [--out .assetgrove/animation] [--subject <name>] [--spec <spec.json>] [--anchor x,y] [--no-vision] [--cap <usd>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Checks one strip, or every family `write-families` wrote from an import, against its motion template and for loop and continuity on pixels. Within the cap, vision calls judge identity flicker between consecutive frames and holes inside the figure; `--no-vision` skips both and spends nothing. Writes a QA report, an onion-skin sheet and a looping preview per family into `--out`, never into the target. Exits 5 when any check fails; each failure names its frame.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, and its `run.json` there. `--round` (default 1) is part of the digest.

MCP tool: `animation_qa`, arguments `strip`, `family`, `profile`, `import`, `out`, `subject`, `spec`, `anchor`, `noVision`, `cap`, `workItem`, `runs`, `round`.

### `fix-frame`

```text
fix-frame --strip <strip.png> --family <name> --profile <profile.json> --frame <n> (--from <n> | --key-pose <image>) --out <directory> [--subject <name>] [--spec <spec.json>] [--note <text>] [--provenance <strip>.provenance.json] [--bible <bible.json>] [--anchor x,y] [--cap 2] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Regenerates one frame (1-based) of a strip with one paid reference-guided edit call, from an approved neighbour frame or the approved key pose. Only that frame changes. Writes the fixed strip, its provenance with a fixes entry, and its QA report and previews into `--out`; never writes into the target or sets a review value. A provenance file that is not the strip's own record is refused (exit 2) before the call.

Plan step: `--dry-run` prints the request's WorkPlan (`jobs`, `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` hashes, `options`, the 64-hex request `digest` and `runDir`) with no provider call, no ledger entry and nothing written; the `estimate` tool returns the same document. A real run first writes `request.json` in its run directory `r-<first 16 hex of the digest>` under `--runs`, and its `run.json` there. `--round` (default 1) is part of the digest.

MCP tool: `fix_frame`, arguments `strip`, `family`, `profile`, `frame`, `from`, `keyPose`, `out`, `subject`, `spec`, `note`, `provenance`, `bible`, `anchor`, `cap`, `workItem`, `runs`, `round`.

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

### `settings`

```text
settings <path|show|check> [--json]
```

Reads the developer settings and changes nothing. `path` gives the settings file, whether it exists, and the config and state directories. `show` gives the settings with every default filled; per provider, the key variable's name and whether it is set, never a key. `check` reports per provider whether a key is present and a limit is declared and verified against the provider's reading, how spend is reconciled, and any refused environment variable. Local: no model call, no spend.

MCP tool: `settings`, argument `action`.

### `extensions`

```text
extensions [--json]
```

Lists what loaded: core first, then each extension the developer settings' `extensions` list names, as `{name, package, version, entry, kinds, presets, adapters}` under `extensions`. An extension loads only when the settings list its package, it resolves from the project, its declared `api` matches (checked before import) and the project's Git does not track its entry file; otherwise every command exits 2 with `extension_unavailable`, `extension_refused` or `extension_conflict` (see docs/extensions.md). A shared file naming an `<ext>:<name>` kind or preset of an extension that did not load exits 2 `extension_unavailable`. Local: no model call, no spend.

MCP tool: `extensions`, no arguments.

### `spend`

```text
spend <status|check> [--provider <id>] [--work-item <label>] [--provider-script <module>] [--json]
```

`status` gives the ledger (`<stateDir>/spend.jsonl`), the caps from the settings, the last 24 hours' spend, and the work item (`--work-item` or `ASSETGROVE_WORK_ITEM`) with its spend. `check` reports per configured provider (`--provider` narrows it) `{provider, adapter, paid, declared, limit, verified, reading, mismatch, note}`: whether a limit is declared, the provider's reading where it gives one to an ordinary key (gateway credits balance, Tripo balance), and whether the reading verifies the limit. A reading verifies only a `prepaid` limit with `usd` (balance at or below it); a balance above it exits 3 with `provider_limit_mismatch`. Anthropic and OpenAI limits are declared only. `--provider-script` names the scripted provider's module, whose `limitReading` check reads. No spend, nothing written.

MCP tool: `spend`, arguments `action`, `provider`, `workItem`. The provider script flag is CLI-only.

### `estimate`

```text
estimate <command> [--args <json>] [--work-item <label>] [--provider-script <module>] [--json]
```

Runs a paid command's free plan step (`plan`, `apply`, `stage`, `generate-sheet`, `import`, `materials`, `look-dev`, `animation-qa`, `fix-frame`, `identity-eval`, `identity-check`) and returns what that command prints with its dry-run flag and `--json`, its `command` field naming that command: the WorkPlan's `jobs` (operation, provider, model, count and per-call estimate), `candidates`, `forecastUsd`, `capUsd`, `paid`, `inputs` (sha256 of each input file), `options`, the request `digest` and the `runDir` it would run in, with the spend left under the ledger's limits; exit 3 when the forecast is over the cap or a limit. `--args` is a JSON object of the command's tool arguments (no CLI-only option). The digest is the sha256 of the canonical JSON of the command, round, inputs, options, jobs, forecast and cap: the same request gives the same digest. A free or unknown command exits 2. No provider call, no ledger entry, nothing written.

MCP tool: `estimate`, arguments `command`, `args`, `workItem`.

### `confirm`

```text
confirm <hex> [--json]
```

Approves a pending request at a terminal. A command that exits 8 `confirmation_required` because a command a file names (a profile's validator, a profile style's material compression or preview command, or the CLI's provider script module) has no approval saves the request to `<stateDir>/pending/<hex>.json`; `confirm <hex>` shows its kind, argv, cwd and file hashes and asks. An accept writes `<configDir>/approvals/<hex>.json` (method `terminal`) and the command runs on the next try; a decline exits 8 `confirmation_declined`. Without a TTY on stdin and stderr, with no pending request of that id, or with one whose kind, argv, cwd and files do not hash to that id (an edited or corrupted file), it exits 2 before asking. Headless settings ignore these records: list the hash in `commands.approved` instead. Local: no model call, no spend. CLI only; no MCP tool serves it.
