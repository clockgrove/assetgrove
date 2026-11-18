# Inputs: asset spec, style bible and target profile

Assetgrove reads three files: the asset spec and the target profile (JSON) and the style bible (Markdown with YAML front matter). All three are data owned by the game; none of them is code here. Briefs, run options and recipes are further shared inputs. Relative paths in a file resolve against that file's directory.

## Asset spec

```json
{
  "kind": "sprite-strip",
  "assetId": "fern",
  "animationFamily": "shelter",
  "frames": { "count": 6 },
  "anchor": { "x": 16, "y": 30 },
  "keyPose": "poses/fern-shelter-key.png",
  "fields": { "semantic": { "role": "actor", "entity": "grove.fern" } }
}
```

- `kind` selects the generator: `sprite-strip` (frame edits of an approved key pose), `still` (one image) or `character-3d` (a rigged, animated `.glb`; its fields `gait`, `clips` and `heightM` and the profile's `model3d` section are in [characters-3d.md](characters-3d.md), including `model3d.handoff`, the clip fields and side images a target's validator takes). A new kind is a new generator.
- `tierClass` (optional, 3D models) names the class whose limits apply in a profile whose `model3d.tiers` are nested by class, for example `character` or `prop` ([characters-3d.md](characters-3d.md#detail-levels-and-tiers)).
- `subject` names the bible subject; it defaults to `assetId`.
- `look` (optional) names one of the bible's `looks`, such as `character` or `environment`. The asset gets that look's notes and references on top of the shared ones. An unknown look is refused before any spend.
- `frames.width` and `frames.height` default to the profile's frame size; `frames.count` defaults to 1.
- `anchor` is the pivot in frame coordinates: the bottom centre of the subject is aligned to it. It defaults to the bottom centre of the frame.
- `keyPose` (required for `sprite-strip`) is the author-approved key pose image; every frame becomes a reference-guided edit of it. A strip spec without one is refused before any spend. To make one through Assetgrove, stage a `still` spec of the pose (set `frames.width` and `frames.height` larger than the profile's frame size for a detailed reference), look at the staged candidates, and name the chosen file as `keyPose`.
- `fields` holds extra values the profile's manifest template reads as `{{spec.fields.*}}`.
- A kind that declares a `specSchema` ([extensions.md](extensions.md#spec-and-profile-schemas)) has every spec of that kind checked against it before any spend; an invalid spec is invalid input (exit 2) naming the field. Core's own kinds declare permissive schemas, so every spec they accepted before is still accepted.

## Format lines

The shared files carry a `format` line as their first field, `assetgrove-<kind>/<n>`: `assetgrove-target-profile/2`, `assetgrove-style-bible/1` (the front matter of `BIBLE.md`, and the deprecated JSON style bible), `assetgrove-style-preset/1` and `assetgrove-recipe/1`. A file with no line is refused with exit 2 (`format_unsupported`, `error.reason` `missing`) and the message names the line to add. A newer version is `too_new`, and a line that is unknown or belongs to another kind is `unknown`. An older version is migrated in memory. Specs, briefs, groupings and other request inputs carry no format line.

`assetgrove migrate <file> --kind <kind>` adds the line to an unversioned file, as its first field (Markdown front matter is edited in place and the prose kept), and moves an older file forward; `--kind` is `target-profile`, `style-bible`, `style-preset`, `recipe` or `settings` (a developer settings file, moved from `/1` to `/2`). A file already current is reported as `current` and not written. Loaders still refuse an unversioned file until it is migrated.

## Style bible

`BIBLE.md` is the one style bible. `init` writes it to `.assetgrove/art-direction/BIBLE.md`, and every command that takes `--bible` reads it: `plan` and `apply` compile its constitution (axes, tone, tokens, anchors and identity locks; [generation-knobs.md](generation-knobs.md#four-layers)), and `stage`, `generate-sheet`, `import`, `look-dev`, `request-change` and `fix-frame` read the parts below from the same file. A part of its front matter:

```yaml
anchors:
  positive:
    - { path: refs/fern-sheet.png, role: character sheet, subject: fern, view: sheet }
    - { path: refs/fern-front.png, role: turnaround, subject: fern, view: front, look: character }
    - { path: refs/yard.png, role: world mockup and perspective sample }
  negative: []
perspective: refs/yard.png
perspectiveDescription: isometric, three-quarter view from above
subjects:
  fern: { description: a grey adult four-legged character with a dark mask }
  den: { description: a wooden den }
```

- **A subject's references** are the positive anchors that name it as `subject` (one with a `look` only for specs of that look), then its identity lock's approved turnaround and `references`, each once. The perspective sample is never sent as a subject reference, and negative anchors are `plan`'s alone. A request for a subject with no references is refused, naming the subject.
- **`perspective`** (optional) is the image whose camera angle stills, strips and sheets match. A 2D request without it is refused, naming the field; 3D does not use it. **`perspectiveDescription`** (optional) tells vision QA what view the sample shows; without it QA compares against the sample alone.
- **`subjects`** (optional) describes each subject in plain words for the prompt and QA. A subject with an identity lock and no description is described by its lock's proportions and signature features.
- **The palette** is `tokens.palette`. Post-processing snaps every colour to it, and QA compares the candidate with the references.
- **The style notes** in each prompt come from the constitution: every axis, the audience and each content limit. An axis that a look overrides is written "unless the asset's look sets it", and a spec with that `look` also gets the look's value. The mood is `tone.moodRange`.
- **The identity locks** are in the same file, so `generate-sheet` and `import` read `--bible` for `--lock-bible` when it is a `BIBLE.md` and `--lock-bible` names no other.

The subject's references, the perspective sample and a swatch of the palette are sent to the model as image references; the prompt is composed from these fields and the spec, never typed freehand.

A bible that lists references requires `referenceLicense`, the terms they were provided under: an SPDX identifier, a `LicenseRef-*` or `NOASSERTION`. It is checked as non-empty text and not parsed. It covers the anchors, the identity-lock turnarounds and references, and the perspective sample; each anchor may set its own `license`.

An anchor may set `view`, which says what it shows of its subject: `front`, `left`, `right`, `back`, `three-quarter`, `sheet` (several views on one sheet) or `detail` (not a full-body view). `left` and `right` are the character's own sides, not the viewer's. A value outside this list is refused when the bible loads (exit 2). `role` stays free text and is never read for the view. A 3D character request ([characters-3d.md](characters-3d.md#what-a-candidate-is)) uses `view`; when it is not set, a model judges the view, and the answer is cached by the image's hash. A request whose references show no `front` view is refused before the first expensive call; a `sheet` does not count as a front view.

### The JSON style bible (deprecated)

Before `BIBLE.md`, `stage` and the commands after it read a JSON style bible. One still loads, with a notice on stderr, and is checked when it loads: `version` and `palette` (at least one six-digit hex colour) are required, a field of the wrong type is refused (exit 2 `invalid_input`, naming the field), and `references` left out means none. Its fields map onto `BIBLE.md` as follows:

| JSON style bible                                                    | `BIBLE.md`                                |
| ------------------------------------------------------------------- | ----------------------------------------- |
| `version`, `referenceLicense`                                       | the same fields                           |
| `palette`                                                           | `tokens.palette`                          |
| `references` (`path`, `role`, `subject`, `look`, `view`, `license`) | `anchors.positive`                        |
| `perspective`, `perspectiveDescription`, `subjects`                 | the same fields                           |
| `mood`                                                              | `tone.moodRange`                          |
| `notes`, `looks.<name>.notes`                                       | the axes, `looks` and the Do's and Don'ts |

To move to `BIBLE.md`, run `init` for one from a preset (or `bible preset` on an existing one), then carry the fields over as the table shows and point `--bible` at it.

## Target profile

```json
{
  "format": "assetgrove-target-profile/2",
  "name": "my-game",
  "license": "MIT",
  "acceptedLicenses": ["CC-BY-4.0"],
  "style": { "alpha": { "mode": "soft" }, "color": { "rule": "full" } },
  "values": { "creator": "My Studio" },
  "frames": { "width": 64, "height": 64, "maxEdge": 256, "durationMs": 250 },
  "layout": {
    "media": "assets/source/{{spec.assetId}}/{{spec.animationFamily}}.{{output.extension}}",
    "manifest": "assets/manifests/{{spec.assetId}}/{{spec.animationFamily}}.json"
  },
  "manifest": {
    "assetManifestVersion": 1,
    "assetId": "{{spec.assetId}}",
    "animationFamily": "{{spec.animationFamily}}",
    "source": {
      "kind": "generated",
      "path": "{{output.path}}",
      "creator": "{{profile.creator}}",
      "tool": "assetgrove"
    },
    "license": "{{profile.license}}",
    "provenance": {
      "prompt": "{{provenance.prompt}}",
      "references": "{{provenance.referenceHashes}}"
    },
    "review": { "status": "pending" },
    "semantic": "{{spec.fields.semantic?}}",
    "frames": "{{output.frames}}",
    "anchor": "{{output.anchor}}",
    "bounds": "{{output.bounds}}",
    "palette": "{{output.palette?}}",
    "contentHash": "{{output.sha256}}"
  },
  "review": { "path": "review.status", "pending": "pending" },
  "validator": {
    "command": ["pnpm", "--filter", "@my-game/assets", "run", "validate", "{{manifest}}"]
  }
}
```

An optional `identity` object configures identity lock scoring: `mode` (`shadow`, the default, scores without filtering; `enforce` filters candidates below the threshold, except 3D characters, which it scores in shadow mode; `off`), `threshold` (0 to 1; when unset, the threshold recorded for the bible and decision model by `identity-eval --record`; `enforce` refuses a bible with no record or whose recorded eval did not meet the enforce bar, and shadow mode falls back to 0.5 for `cast` and 0.68 for `score` and `boolean`; see [decisions.md](decisions.md)) and `question` (`score`, `boolean`, or `cast`, which judges a candidate as a choice among every identity record in its bible and whether it is on-model for its subject). See [generation-knobs.md](generation-knobs.md#identity-lock-scoring).

The paths are illustrative.

`validator.command` is an argv array run in the target directory without a shell after `pick` or `write-families` writes. It is code a shared file names, so it runs only with an approval tied to its exact hash; see [decisions.md](decisions.md#command-approvals-are-hashed-relative-to-the-git-top-level-shims-are-refused). An unapproved validator exits 8 `confirmation_required` before anything is written, unless a person accepts it in an MCP client's form or at a TTY; `assetgrove confirm <hex>` approves a pending one. The provenance's `commands` records its hash and approval method.

- **Validation.** The profile's top-level fields are validated: `format`, `name`, `license`, `acceptedLicenses`, `style`, `values`, `frames`, `layout`, `manifest`, `review`, `validator`, `identity`, `spend`, `model3d`, `animation`, `library`, `handoff` and `kinds`. An unknown top-level field or a value of the wrong type is invalid input (exit 2).
- **Kind blocks.** `kinds` (optional) holds one block per asset kind, keyed by the kind's id: `{ "kinds": { "pixel:sprite": { "values": { … }, "grid": 16 } } }`. A block may always carry `values`, a plain object that no core code reads yet. Its other fields are the ones the kind declares in its `profileSchema` ([extensions.md](extensions.md#spec-and-profile-schemas)), and a kind that declares none accepts only `values`. The block is checked when a request of that kind is planned, before any spend. A field the schema refuses, or an undeclared one, is invalid input (exit 2) naming `kinds.<kind>.<field>`. No kind can declare an endpoint, model, provider option, graph or command there: model, tier and price stay on the route in the [developer settings](settings.md#roles-and-routes).
- **Style.** `style` is the world's style profile: alpha mode (`soft` or `binary`, with a `threshold`), colour rule (`full` or `palette`) and edges (`antialiased` or `crisp`). The sheet import path follows it ([sheet-import.md](sheet-import.md#style-profile)). It is optional, and templates can read it as `{{profile.style}}`.
- **Templates.** `"{{a.b}}"` as a whole string inserts the value of any JSON type; `"{{a.b?}}"` drops the key when the value is undefined; `{{a.b}}` inside a longer string interpolates text. An undefined required value is an error. A required `spec.*` value the spec does not set, in the layout or (when `handoff` lists the `manifest` preset, which renders it) the manifest, is refused as invalid input before any paid call (`stage`, `plan`, `apply`, `look-dev`, and `generate-sheet` against the spec each family hands off with), naming both (`layout.media needs spec.animationFamily`); `pick` of a run staged without it is refused the same way.
- **Values available:** `spec.*` (the spec, with its `fields` also merged in), `profile.*` (`values`, `name`, `license`), `bible.version`, `output.*` (`path`, `mediaType`, `extension`, `sha256`, and what the generator adds: `frames`, `anchor`, `bounds`, `palette` for images; imported strips add `jitterPx` and set `palette` only under a palette colour rule), `provenance` (the full record) and `run.*` (`runId`, `candidateId`, `pickedAt`).
- **Licences.** `license` is the target's own licence, declared for outputs whose provider grant lets the target relabel them (paid plans that give ownership). `acceptedLicenses` (optional, default none) lists licences the target takes on purpose beyond its own, such as `CC-BY-4.0` when it publishes the credit line (`{{provenance.outputGrant.attribution}}`). Hand-off (`pick`, `write-families`) re-derives the output grant from the provenance's calls and refuses, before writing anything, with exit 7 (`license_refused`) an output whose grant neither allows relabelling nor is listed, and every non-commercial grant. An output made by several calls on routes that do not allow relabelling carries every licence of the most restrictive of them, recorded as one SPDX expression joined with `AND` in sorted order (so the order the calls ran in never changes it); it is accepted when `acceptedLicenses` lists each of those licences, and a refusal names each one it does not list. In hand-off templates `{{profile.license}}` and `{{provenance.license}}` are the licence the output is declared under, so a template never relabels.
- **Provenance.** Every pick carries its full provenance record into the target. `layout.provenance`, when set, writes it as its own file at that path; the template can also embed `"{{provenance}}"`; with neither, it is written beside the media file as `<media path>.provenance.json`. The record holds the models, route, prompt, parameters, reference hashes, seed where supported, request IDs, times, cost, provider terms, bible version and license, `referenceLicenses` (`path`, `role` and `license` of each reference, each the reference's own licence or the bible's; they record terms and gate nothing), the combined `outputGrant` (`license`, `plan`, `commercial`, `relabel`, `attribution`; the most restrictive grant over all calls wins), plus every call with its own `outputGrant`. Each call marks `costSource` (`provider` or `estimate`) and `requestIdSource` (`provider`, or `local` when the gateway reported no ID and Assetgrove generated one).
- **Project root.** Reference paths in shared files (the anchors, identity images and perspective sample of `BIBLE.md`, and the deprecated JSON bible's references and perspective), and the images a request names (a spec's `keyPose`, an identity-eval case's `image`, fix-frame's `--key-pose`), must resolve inside the project root, with symlinks resolved. The root is the nearest ancestor of the naming file's directory (the cwd for `--key-pose`) holding `.git` or `.assetgrove`, else that directory. The walk stops below the home directory, which is never a project root (as in settings), so a dotfiles repository at the home directory does not open every file under it; a bible with no project marker may reference only files beside or below it. A path outside it is invalid input (exit 2) before any provider call.
- **Review.** Assetgrove always sets the field at `review.path` to `review.pending` and never writes another value there.
- **Validator.** Run in the target directory after the pick is written, with `{{manifest}}` and `{{media}}` replaced by the written paths. A non-zero exit is reported as a rejection.
- **Hand-off presets.** `handoff` lists the presets that write what the target reads, in order: `[{ "preset": "manifest" }]` when absent. See [Hand-off presets](#hand-off-presets).
- **Media.** Each output declares its own media type and extension; `.gitattributes` in the target decides what Git LFS stores.
- **3D detail levels and tiers.** `model3d.lods` declares the detail-level chain: each level's `triangleRatio` of the full model and the `minScreenHeight` it shows down to. `model3d.tiers` declares each quality tier's budgets (`triangles`, `textureMaxPx` and, optionally, `materials`, `bones` and `lods`), either directly or nested by class. A tier may also set `fur: false`. `model3d.lodQa.silhouette` sets the level QA tolerance, and `model3d.handoff.lods` (`embedded` or `files`) sets how the levels are packaged. `assetgrove lod` makes the chain and the tier renditions within these budgets ([characters-3d.md](characters-3d.md#detail-levels-and-tiers)).
- **Spend.** An optional `spend` object, `{ "dailyLimitUsd": 10, "workItemLimitUsd": 5 }`, sets the cross-run spend limits below. Each is a non-negative USD amount.

## Library

An optional `library` block says where the asset library sits and what it is called; every field is optional.

- `root`: a path inside the target. Default: the static directory prefix of `layout.media` (the part before the first `{{`), else the target root.
- `game`: the game id, the first segment of `asset://` addresses. Default: a slug of `name`.
- `log`: `false` turns `log.md` off. Default `true`.

The hand-off writes the card `<assetId>.md`, `<assetId>.review.json`, an `index.md` in every folder from the library root down, and a line in `log.md`; see [library.md](library.md). `assetgrove migrate --kind target-profile` moves a `/1` profile to `/2`; nothing else changes.

## Hand-off presets

```json
"handoff": [{ "preset": "manifest" }]
```

Every hand-off (`pick`, a 3D `pick` and `write-families`) goes through one path:

1. Each entry's `options` is validated against its preset's options schema. An unknown preset, an invalid option or an empty list is invalid input (exit 2 `invalid_input`), and nothing is written.
2. The media, its sidecars and its provenance are written, together with each preset's files. Every path is checked before anything is written.
3. Each preset checks what it wrote by reading it back. A failed check exits 6 `handoff_check_failed`; with `--json`, `error.problems` lists each problem as `{ preset, problem }`. The validator does not run, and the pick is not recorded in the run.
4. The approved validator runs.

| Preset          | Options                              | Writes                                                                                                         | Checks                                                                                                |
| --------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `manifest`      | none                                 | the `manifest` template rendered at `layout.manifest`, with the field at `review.path` set to `review.pending` | the file reads back as written, parses as a JSON object, and holds the pending value at `review.path` |
| `atlas-json`    | `shape`: `hash` (default) or `array` | sprite-atlas JSON beside the strip: frames `<assetId>_<nnn>`, `meta`, `animations`                             | shape, size, rectangles, frame count, image path, tag coverage; see [handoff.md](handoff.md)          |
| `aseprite-json` | `shape`: `array` (default) or `hash` | the same plus `duration` per frame and `meta.frameTags`                                                        | the same checks                                                                                       |

A layout that writes another file over the manifest, such as a `layout.provenance` equal to `layout.manifest`, fails the `manifest` check.

## Spend limits across runs

A run's `--cap` bounds that run alone, and may only lower the settings' `caps.runUsd`. A spend ledger, `<stateDir>/spend.jsonl`, bounds what all runs spend together: every paid call, in every command and over MCP, reserves its estimate in the ledger before it is made and settles at its actual cost after, recording its route (`provider:operation:model`), work item, cost and time. Before each call, and for the whole forecast before a run's first call, two caps from the developer settings ([settings.md](settings.md#caps-and-ledger)) are checked beside the run's cap:

- **Daily** (`caps.dailyUsd`, $10 by default): spend over the last 24 hours, by every run that uses the ledger.
- **Work item** (`caps.workItemUsd`, $5 by default): all spend recorded under one work item, such as a task, a ticket or a session label. It applies only when a work item is named.

A call or run that would cross either limit is refused before any provider call with exit 3 (`cap_refused`). The message names the limit, what is already spent against it and what is left; with `--json`, `error.limit` holds `name` (`daily` or `work-item`), `workItem`, `limitUsd`, `spentUsd`, `requestedUsd` and `ledger`. `--dry-run` reports the spend left under each limit in `spend.limits` (and `withinLimits`), and exits 3 when the forecast does not fit what is left.

The work item is named by `--work-item <label>` or `ASSETGROVE_WORK_ITEM`; with none, only the daily cap applies. The target profile's `spend.dailyLimitUsd` and `spend.workItemLimitUsd` lower the daily and work-item caps and never raise them; the limit's `source` is `profile` when the profile's value applies and `settings` otherwise. An invalid value is invalid input (exit 2). The ledger is append-only JSON Lines; concurrent runs order their reservations by their appends and never reserve past a limit together. A reservation never settled (a run that crashed) keeps its estimate. The ledger holds no keys or prompts.

Scripted runs (`--provider-script`) are not real spend, so they are excluded: their calls are never written to the ledger and the limits never refuse them, while the run's own `--cap` still applies. A dry run with a script still prints the limits, with `spend.counted` false. Whether a provider is paid comes from its adapter's billing, never its name: the gateway and Tripo are paid, and the scripted adapter is free unless its script sets `paid: true`. A paid call to a provider with no declared `limit` is refused with exit 3 (`provider_limit_undeclared`).

## Relightable materials

`style.materials` opts a world into normal, height/depth, emissive, roughness/wetness and wind/flow channels, native 1×/2× (optional 4×) renditions, temporal bounds, target compression and lit-preview commands. Per-asset derivation sources stay separate from the world profile. See [materials.md](materials.md) for the `assetgrove materials` command, encoding, provenance and target command contracts.

### Relightable materials

The optional `style.materials` data is validated against the material profile schema. The `materials` command defaults to all standard channels (`normal`, `height`, `emissive`, `roughness`, `wind`), scales `[1, 2]`, and a flicker bound of `0.03` when settings are absent. `channels` can omit any channel or be empty; `scales` may additionally include 4. This does not cause ordinary generation commands to run materials automatically.

Per-channel `encoding` declares `unorm8` and an ordered normalized `range`. `compression` declares the format (`ktx2` or `basis`, delivered in KTX2), version and argv command; `preview` declares its version and argv command. `lightRig` is target-owned JSON data consumed by the preview renderer from the material report. No target light rig is available yet; tests use an explicit synthetic rig. Commands never use shell interpolation and have bounded runtimes. See [materials.md](materials.md) for derivation inputs, defaults, rendition limits and `--dry-run` cost forecasts.
