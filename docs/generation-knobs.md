# Generation knobs

`plan` compiles a reviewable file; `apply` spends against that exact file. Both need a person's spend confirmation (inline at a terminal, or exit 8 `confirmation_required`). Plan approval authorizes generation spend; generated assets remain pending human review.

## Start a world

Run in the target repository:

```sh
assetgrove init --directory . --profile-preset sprite-32 --style-preset cozy-storybook --world "Example World" --json
assetgrove bible describe --bible .assetgrove/art-direction/BIBLE.md --json
```

Available presets are `cozy-storybook` (soft painterly storybook), `flat-cartoon-kids` (bold outlines and simple flat shading), and `dark-gritty-isometric` (restrained colour, worn surfaces and an isometric camera). They use plain visual descriptions, never named games, studios or artists.

`init` writes `.assetgrove/profile.json`, `.assetgrove/art-direction/BIBLE.md`, repository-owned copies under `presets/`, `.assetgrove/prompts/default.md`, and an `art-direction` skill in both `.claude/skills/` and `.agents/skills/`, where Claude Code, Codex and Copilot read skills. Commit these files with your target repository. The skill links the bible, anchors and presets so a harness can load them while generating or reviewing art. `stage`, `import` and `generate-sheet` take a JSON bible; `plan` and `apply` use the Markdown bible.

To switch the look of later plans without a code change:

```sh
assetgrove bible preset --bible .assetgrove/art-direction/BIBLE.md --preset flat-cartoon-kids --json
```

This loads the preset from the target repository's sibling `presets/<preset>.md`. It changes look, tone and their token bounds while retaining the world's name, palette, anchors, identity locks and prose. Review the changed bible and commit it; plans made before the switch become stale. Edit the repository's preset files to customize future switches.

## Four layers

The bible is the constitution. Its YAML front matter declares `version`, `world`, `preset`, `axes`, `tone`, `anchors`, `colorRule`, `tokens`, `adjustable` and `identities`. Markdown after the front matter preserves prose rationale and unknown sections. The Do's and Don'ts section describes how positive and negative image anchors should be interpreted.

`axes` contains rendering (`painterly`, `naturalistic`, `flat-cartoon`, `pixel` or `stylised-3d`), realism, proportions, outline weight and colour, shading, detail density, texture and the lighting key. Saturation bounds and outline colour are DTCG tokens; the outline axis references its colour token. `tone` declares audience, allowed moods and content limits. `anchors.positive` and `anchors.negative` contain image paths, roles and optional subjects. References resolve relative to the bible.

`looks` (optional) maps a look name, such as `character` or `environment`, to the axes it overrides. A spec whose `look` names it is planned with those axes, and with the anchors that carry that `look` or none. Other specs ignore it. A look may override any axis, `rendering` included, so a world can pair characters of one rendering with an environment of another.

Machine-readable colours, lighting, fog, value ranges and optional timing use [DTCG 2025.10 typed tokens](https://www.designtokens.org/tr/2025.10/format/), with `$type` and `$value`. The shipped bible provides the valid starting shape, including DTCG colour objects. For example:

```yaml
tokens:
  palette:
    ink:
      $type: color
      $value:
        colorSpace: srgb
        components: [0.1, 0.1, 0.15]
  valueRange:
    min: { $type: number, $value: 0.1 }
    max: { $type: number, $value: 0.9 }
```

For a character, add an `identities` entry keyed by the asset's `subject` (which defaults to `assetId`):

```yaml
identities:
  example-character:
    version: "1"
    approved: true
    turnaround: anchors/example-turnaround.png
    signatureFeatures: [round ears, striped tail]
    proportions: short legs and a broad head
    palette: ["#29303b", "#d2b48c"]
```

Every plan for that character attaches the approved turnaround and the lock automatically. Add approved images in your own repository; Assetgrove ships no private character art.

The asset spec still describes the requested asset. A separate brief supplies its purpose and context:

```json
{
  "purpose": "portrait icon",
  "appearsIn": "night scene after a storm",
  "neighbouringAssets": ["den", "wet lantern"],
  "mood": "mildly eerie",
  "context": "the character is waiting for the rain to stop"
}
```

An optional `adjustments` object can request only fields listed in the bible's `adjustable` bounds. A brief cannot rewrite the audience, palette, identity, rendering or content limits. Out-of-range moods or permitted adjustments are clamped and recorded; unsupported constitutional overrides are refused. Whether the free text (`purpose`, `appearsIn`, `context`, `neighbouringAssets`) asks to depart from the bible is judged by a model, not by word patterns: `plan` makes one `brief-policy` decision per protected field (palette, identity, audience, proportions, content limits), so "a field mouse with chunky proportions" is accepted and "paint her in crimson and navy instead" is refused with exit 2 naming `palette`. The compiler's own text gets the same check; text it objects to is dropped for the template prompt, with the reason in the compiler record's `fallbackReason` ([decisions.md](decisions.md#a-briefs-departure-from-the-bible-is-a-models-judgement)). Named-style imitation is the prompt policy's ([prompt-policy.md](prompt-policy.md)): the package blocklist `policy/blocklist.json` refuses its phrases and names across the spec, brief, bible, template and compiler output with exit 9 `prompt_refused`, matching case, diacritic, width and spacing variants. Ordinary free-text context is accepted without a fixed vocabulary. Profile palettes must be compatible with the bible; a palette rule in either layer constrains both prompts and postprocessing.

For UI-facing purposes such as icons, portraits and badges, a target repository's `DESIGN.md` `colors` (from front matter or fenced YAML) contributes subordinate interface palette context. The art bible remains authoritative; Assetgrove does not extend DESIGN.md with art direction.

Run options are a separate JSON file (`--run-options`) holding `candidates`, `seed`, `strictness` and `exploration` only:

```json
{ "candidates": 2, "strictness": 0.8, "exploration": 0.1 }
```

`strictness` is the minimum style score (0–1) for showing a candidate. The style verdict (`style-score`) is model-backed: it filters only with a qualifying stability entry for the `vision` route's model, and at 0.1 it has none, so a candidate below the strictness is shown with its reason marked advisory (docs/decisions.md, "Model-backed checks advisory at 0.1"). `exploration` ranges from exactness (`0`) to exploration within the constitution (`1`). Optional `seed` requires a route that supports seeds. Run options carry no cap and no route: any other field, such as `capUsd` or `modelRoute`, is refused (exit 2 `invalid_input`). The run cap is the developer settings' `caps.runUsd`, and the routes come from their routes and roles ([docs/settings.md](settings.md#roles-and-routes)): `still` (or `edit` for a strip) for generation, `compiler` for prompt compilation and `vision` for style QA. The plan keeps only a hash of that resolution; apply resolves them from the developer settings again. Each route has `provider`, `model`, `estimatedCostUsd`, and optional `providerTerms`, `outputGrant`, `size`, `supportsSeed` and `providerOptions`. `outputGrant` is what the provider grants for the route's outputs: `license` (an SPDX ID, or `LicenseRef-<provider>-<plan>`), `plan`, `commercial`, `relabel` and, when credit is required, `attribution`; for example Meshy's free plan is `{ "license": "CC-BY-4.0", "plan": "free", "commercial": true, "relabel": false, "attribution": "Model by Meshy" }`. The default routes are paid API routes that give ownership (`relabel: true`). A grant belongs to the provider and model: a settings override that changes either carries only the `outputGrant` and `providerTerms` it declares, and an output with a call that has no grant is refused at hand-off. The compiler runs only when its route's provider has its key; otherwise the template applies. Every provider call reserves estimated spend against the cap before running.

## Plan, inspect and apply

```sh
assetgrove plan --spec spec.json --bible .assetgrove/art-direction/BIBLE.md \
  --profile profile.json --brief brief.json --run-options run-options.json --out plan.json --json
assetgrove apply plan.json --out .assetgrove/runs --json
```

`plan` never generates images. It calls the configured compiler LLM to produce final positive and negative prompts for the target model family. The saved plan (`format: "assetgrove-plan/1"`, a run artifact) holds the operation names apply runs, the compiled prompts (`images`, `generation`, `negative`, `qa`), each input file's path and sha256 (bible, spec, profile, brief, run options, template and reference images), the request digest, `resolutionSha256` (a hash of the planning-time routes, estimates, output grants and run cap) and an integrity `digest`, and nothing else. The command's output adds the compiler's record (mode, model, template version, output, calls and spend), the clamps and the cost forecast. If the compiler is unavailable, a deterministic template-only fallback is recorded as `template-fallback`; malformed or unsafe model output is refused.

The repository's default template supports `{{constitution}}`, `{{spec}}`, `{{brief}}`, `{{settings}}` and `{{family}}`. Override it in git or select another repository file with `--template`. Presentation, background and lighting belong in that template and bible. There is no global painterly presentation instruction.

`apply` needs a person's spend confirmation (headless settings, a record under `<configDir>/confirmations`, the inline prompt on a TTY, or `assetgrove confirm <id>` after exit 8). The plan's confirmation covers one `apply` run of the plan file it saved, the default round, while its input hashes still match and the forecast does not rise; another `--out` once that run started asks again; `apply --round n` (n > 1) is another paid request and asks under its own digest. Any plan edit requires planning again: an edited digest exits 2, and a field outside the format (a cap, route, estimate or grant), even with the digest recomputed, exits 2 `plan_changed`. Apply re-reads and hashes every input the plan names before any generation, so a changed file invalidates the plan even when its declared version was not bumped. It then re-resolves routes, estimates, output grants and the run cap from the developer settings and exits 2 `plan_changed` when they differ from planning time, and runs the prompt policy on the plan's prompts (exit 9). Applied candidates carry the plan's prompts, digests and `promptPolicy` record in provenance and remain pending asset review. The run's contact sheet (`contact.png`) draws beside each candidate only the references a reviewer compares it against: roles beginning `identity:`, `key-pose:` or `positive:`. Negative anchors (counterexamples), the palette swatch and the perspective sample still go to the model but are never drawn on the sheet, so a counterexample is not shown as a target.

Model credentials come from `AI_GATEWAY_API_KEY`. Tests and offline harnesses can pass `--provider-script module.mjs`, whose default export supplies the `{ image, vision }` scripted provider contract, plus `decide` for every typed decision (identity, prompt policy, reference views and the rest). `decide` receives the request's `question` and answers the type it asks: `{ answer: { type: "score", score } }` for a score question, `{ answer: { type: "boolean", probability } }` for a boolean one, and `{ answer: { type: "choice", choice } }` for a choice, `choice` being one of the keys of `question.options`. A reference whose bible entry declares its `view` needs no `reference-view` decision. The `motion-template` choice is answered by the script's `motionTemplate(request)`, which a script must supply for any family no spec or grouping declares a template for and no template is named for: without it the call is refused and the run fails. `stage`'s `cutout` Boolean decision (one per still or strip candidate) is answered by the script's `cutout(request)`; a script without it answers no (probability 0), so the cut-out passes. The sheet import's `sheet-blob` choice (one per blob slicing cannot tell by area) is answered by the script's `sheetBlob(request)`, with one of `figure`, `part`, `label` and `speck`; a script without it answers `label`, so the blob is dropped as the area rule would. The compiler uses `vision` with its compilation request; return JSON containing `prompt`, `negativePrompt`, `violations` and `clamps`. For sprite strips, the compiler also returns `framePrompts`, one entry per frame of the approved key pose. Candidate QA returns JSON containing `styleScore`, `passed` and `reason`. Real providers are opt-in.

## Identity lock scoring

A character with an identity lock in the bible (`identities.<subject>`) has an identity record: the approved turnaround, any further approved `references` (paths relative to the bible), and the fingerprint a model checks for: `signatureFeatures`, `proportions` and `palette`. The record is versioned with the lock. Bump the lock's `version` when you change it; every score names the lock version and the hash of the whole lock, so an edit is visible even without a bump.

Every candidate of a locked character is scored against its record by a typed decision model through the gateway (the `identity` route, default `perplexity/pplx-decider-v1.2`). The call is a Score question over five levels, from "a different character" to "the same character: every signature feature, the proportions and the colours match". The identity score is the answer's position over those levels, from 0 to 1. The reason shown is the matching level with the score, threshold, lock version and confidence. With `identity.question: "boolean"` the score is the model's probability that the candidate is the same character. Images under 384 px on a side are upscaled before the call, because some decision models reject small images. Every call logs its label, confidence, latency and cost on stderr and in its call record (`decision`).

With `identity.question: "cast"` the candidate is judged as a choice among the whole cast instead of a yes or no against one character. The cast is every identity record in the same bible, so nothing is tuned to one species or style. One vision call on the `identity-cast` route (default `openai/gpt-6.1-terra`) sees the candidate and each member's approved references and written signature. It is told that any other character, including one of the same species or kind, is "neither". The same call also asks whether the candidate is on-model for the subject: its markings, colours, proportions and signature features against the subject's approved references, which win where the written record disagrees. Only what the pose and the named animation imply is excused: the on-model step judges each feature as it would look in the references' pose, so a difference that the candidate's pose, view or animation phase explains (an arched back mid-stride, a lowered or curled tail, a turned head, spread wings, a blink, a part hidden or foreshortened by the view, background between the limbs) does not count, and a held prop or an open mouth counts only as added unless the named animation implies it (eating, carrying, calling). Nothing else is excused: a change of hue, a region clearly lighter, darker or more muted, a marking missing, added or moved, a see-through hole, a different count of repeated marks on a part fully in view, proportions the pose does not produce (a pose bends the body but never rescales it) and a missing or changed signature feature all count. The wording names no species. Where the caller knows the animation family (a spec's `animationFamily`, in sheet import and in plans), the candidate's description names it. The model answers with a probability for each member and for "neither", its choice, `onModel` (the probability that nothing is missing, added or changed once pose differences are set aside), the deviations it found, the pose differences it set aside (`poseDifferences`, which never change the score) and one sentence of reason. The identity score is the subject's probability, normalised over those options (1 or 0 when the model gives only a choice), times `onModel` (1 when the answer leaves it out). So a recognisable but drifted character, such as the right character with an orange coat, scores low. An off-model reason names who the model saw instead, or "none of the cast", with its sentence, or, for the subject, "off-model" with the deviations. An answer that cannot be read is a failed score. One call sends at most 16 images (`IDENTITY_CAST_MAX_IMAGES`, the candidate included), so the route's estimate stays an upper bound for any cast: every member keeps its turnaround, further references are added one per member in turn with the subject first, and a bible with more than 15 identity records is refused. The cast question is opt-in, and the default question is `score` (decisions.md, "Identity lock bar" and "Identity cast question: only what the animation implies is excused"). The threshold is recorded per bible and model: `identity-eval --record` writes the recommended threshold, with the eval that produced it, to `identity-thresholds.json` beside the bible, one entry per question and decision model. With no `threshold` in the profile, a run uses the recorded one; in shadow mode with no record it falls back to 0.5 for the cast question and 0.68 for `score` and `boolean`, which only label shadow scores. A `threshold` in the profile applies to whichever question runs. The plan, the run summary, `identity-eval` and each score's provenance show the threshold used.

The target profile configures it:

```json
{ "identity": { "mode": "shadow", "threshold": 0.68, "question": "score" } }
```

- `shadow` (the default) scores every candidate beside the current QA and filters nothing. The reason is marked `shadow`, and `run.json` counts how often the identity verdict agreed with QA (`identity.agreement`).
- `enforce` needs a threshold recorded for this bible, question and decision model by `identity-eval --record` whose eval met the enforce bar, and refuses to run without one (the 0.68 and 0.5 defaults are never used to filter). The plan hashes the record file as an input, so a record changed between `plan` and `apply` makes the plan stale; `import` and `generate-sheet` hash it among their request's reads, so a re-recorded threshold is another request, never a reused run. It filters a candidate below the profile's `threshold` if set, else the recorded one, as other QA failures are filtered. A candidate whose scoring call failed is not off-model but unknown: it is kept and written, its identity is recorded with `unscored: true`, and its reason is advisory (marked `shadow`), so it neither fails nor filters the candidate. It is left out of `identity.scores` and `identity.agreement` in `run.json` and counted in `identity.unscored` instead. `run.json` lists each filtered candidate's reasons under `rejections`, and `apply` prints them.
- `off` skips scoring.

A 3D character (`stage` of a `character-3d` spec, and `look-dev`) is never filtered on identity, because no identity question separates lit renders of the right character from their drift (decisions.md, "3D identity results are provisional"). With `enforce`, it is scored in shadow mode: the score's `mode` is `shadow`, its `shadowReason` and its reason say why, and no record check is forecast or called.

`plan --identity-mode <off|shadow|enforce>` overrides the profile for one plan. The plan's operations name the scoring (`identity` or `identity-cast`, and `identity-check` in enforce mode), apply resolves its route and threshold from the settings and profile again, and the forecast includes one identity call per candidate. For imported sheets, `import` and `generate-sheet` take `--lock-bible <BIBLE.md>` (the art bible holding the locks) and `--identity-mode`. The contact sheet is scored at import. In enforce mode below the threshold, `write-families` refuses the sheet with the reason. Characters without a lock are never scored.

### A record that disagrees with its references

A record is trusted only when its written signature features, proportions and palette agree with its own approved references. The references are the source of truth: a record that calls a stocky character lean makes a model reject the real character and accept a lean look-alike. `checkIdentityRecord` asks a vision model on the `identity-check` route to compare each written claim with the reference images, and returns each conflict with the claim and what the references show.

- **At record time:** `assetgrove identity-check --bible BIBLE.md [--subject <name>]... [--json]` checks every record (or the named ones), prints each verdict with its reason, and exits 1 when any record conflicts or could not be checked.
- **In enforce mode:** a run checks each record once, before its first paid generation. A record that conflicts is not used for filtering: its candidates are still scored, but in shadow mode, and the reason says why, until a person fixes the text or the references. A planned run makes the check before its first paid generation, and records it in `run.json` (`identity.recordCheck`). A check that could not run (a provider error or an unreadable answer) stops the run there, exit 4 `provider_error`, before any generation is paid for. `generate-sheet` makes the check before it pays for the sheet and stops the same way; a command that scores existing images in enforce mode (sheet import) stops the same way, with nothing paid for but the check. Shadow mode makes no check call. The check's route is resolved from the developer settings, at planning and again at apply.
- **In `identity-eval`:** every record the set uses is checked and the report lists each check. Cases scored against a record that conflicts or could not be checked are marked and reported as their own group: they are kept out of the sweep, the recommended threshold, the AUC, the per-kind and per-cast breakdown and the bar, since such a record never filters.

Scores land in each candidate's `fields.identity` and provenance (`provenance.identity`: score, label, confidence, threshold, mode, lock version and hash, model, request ID, latency and cost), so the spread of identity scores across an approved set can be read later. Scoring filters and explains. It never approves; the person still picks.

### Choosing the threshold

```sh
assetgrove identity-eval --bible BIBLE.md --cases cases.json --profile profile.json \
  --log identity-eval.jsonl --json
```

`cases.json` is a local labelled set: `[{ "image": "a.png", "subject": "fern", "same": true, "qa": true }, ...]`, with image paths relative to the file and `qa` the current QA's verdict when known. The command scores each case, writes one JSON line per case to `--log`, and reports accuracy for every threshold, the recommended threshold (among the thresholds whose false-accept rate is within the enforce bar's overall, for every kind of case and for every cast, the one with the fewest false rejects, the lowest on a tie; when none meets the bar, none is recommended and the report says "none meets the bar"), accuracy at the configured threshold, and agreement with the QA verdicts. `--record` (with `--bible`) writes the recommendation to `identity-thresholds.json` beside the bible for the eval's question and model, with the cases file, its hash, the counts, the false-accept and false-reject rates and whether the bar was met; it replaces the entry of the same question and model. It is refused before any call without `--bible` or when a case names another bible, and after the eval when none is recommended or the recommended threshold does not meet the whole enforce bar (false rejects included), so a set the model cannot separate, whose only cut within the false-accept bar rejects everything, records nothing. Keep the set and the log out of the repository; they may hold a game's private art.

A case can also say what kind of case it is, so one set can measure every form of off-model across several casts:

- `kind`: `same`, or the negative kind: `drift` (the same character with wrong markings, colours or proportions, or a missing signature feature), `generic` (on-style and the right kind, but nobody in particular) or `lookalike` (another member of the same cast). It defaults to `same` or a plain negative, from `same`.
- `cast`: the cast the case belongs to (default: the bible's `world`).
- `medium`: `2d` (the default) or `3d`.
- `bible`: the bible holding the case's identity records, relative to the cases file. With it, `--bible` is optional, and one set can span several games.

The report gives ROC AUC, and the false-accept and false-reject rates per kind, per cast and per medium, at the configured threshold and at the recommended one. The threshold is recommended on the 2D cases only; a set with no 2D case recommends none. 3D results are reported separately and marked provisional: no threshold rests on them until renders are in the bible's style, and the bar is not judged on them. The report also checks the enforce bar (`IDENTITY_ENFORCE_BAR`: AUC, false-accept and false-reject rates that every kind and every cast must meet on 2D) and lists what falls short. A group the set cannot measure (a cast with no positives or no negatives, a kind with no cases of its own) is listed as "not measured" and fails the bar. Shadow mode stays the default until the bar is met.

The repository's acceptance set is a synthetic look-alike cast of birds drawn in code (`test/fixtures/identity-set/birds.ts`). It includes a record whose text contradicts its references. Cases added after the prompt they measure was written carry `heldOut` (the run that first scored them), a label `identity-eval` does not read; `build.ts <out-dir> --held-out <run>` writes that run's held-out positives and drift with every generic and look-alike negative, as its own `cases.json`. `node test/fixtures/identity-set/build.ts <out-dir>` writes the whole set and its `cases.json`. decisions.md records the numbers measured on this cast and on a four-legged cast.

## MCP

```sh
assetgrove mcp --provider-script scripted-provider.mjs
```

The server runs on the official TypeScript MCP SDK (`@modelcontextprotocol/server`) over the stdio transport, so the SDK negotiates the protocol revision. It serves tools only. Diagnostics never occupy stdout. The server stops when its stdin closes; a request still running at that moment gets no answer, so a client keeps stdin open until it has read its responses.

Every command except `mcp` is a tool named after it in snake case (`look-dev` is `look_dev`); the skill reference ([commands.md](../skills/assetgrove/references/commands.md)) lists each tool's arguments. A tool takes its command's input with local paths, except `providerScript`, `dryRun` and `routes`: the server's `--provider-script` and `--work-item` reach every tool. A tool that needs a confirmation (spend, pick, write or an unapproved command) asks a client that declares form elicitation through an `inputRequired` form and runs on accept (method `elicitation`); decline exits 8 `confirmation_declined`, a request that changed while the form was open exits 2 `plan_changed`, and a client without form elicitation gets exit 8 `confirmation_required`. No argument can supply a confirmation. Each tool runs its command as the CLI does and returns the CLI's `--json` document `{...fields, ok, exitCode, command, error?}` as `structuredContent` and as text, with `isError` set when `ok` is false. The `cat` tool carries its read once, so the result stays inside the 64 KB a read may hold: its document lists each content's `uri` and `mimeType`, and the contents follow in order, an image as image content and anything else as an embedded resource. Arguments outside a tool's input schema are refused with that document and the code `invalid_input`; an unknown tool name is a JSON-RPC `-32602` error. Annotations follow each command's effect: `readOnlyHint` for read-only commands, `destructiveHint` on `pick` and `write_families`, and `idempotentHint` and `openWorldHint` on commands that can spend. Tools that need a person's confirmation (spend, pick and write) carry `_meta["anthropic/requiresUserInteraction"]`, decided when the server starts; under headless settings it is left off. `search_index` spends only with a hosted embedder, so its paid annotations and the mark follow `search.embedder` as the server starts: set with `"route"`, left off with the local model. `find` carries them under every embedder, because its `--outliers` asks paid `style-outlier` decisions with the local model too. The server takes its name and version from package.json, and refuses to start (exit 2 `settings_invalid`) when a proxy or TLS variable is set that the settings' `environment.allow` does not list; every paid command checks the same before it runs.
