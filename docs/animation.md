# Animation that holds together

A strip, whether imported from a sheet ([sheet-import.md](sheet-import.md)) or generated, is checked against its family's motion template and by loop and continuity QA. The person picking sees an onion-skin sheet and a looping preview. A single bad frame is repaired by a per-frame fix. Assetgrove never approves a strip; it measures, reports and shows.

## The commands

```sh
# Written families: write-families already runs the pixel checks and writes the previews.
pnpm assetgrove write-families --import .assetgrove/imports/<import> --target ../my-game

# The full QA on one strip, identity flicker and holes included (vision calls within the cap).
pnpm assetgrove animation-qa --strip walk-right.png --profile profile.json --family walk-right \
  --out .assetgrove/animation [--subject bram] [--spec spec.json] [--no-vision] [--cap 1] [--dry-run] [--json]

# Or on every family an import wrote.
pnpm assetgrove animation-qa --import .assetgrove/imports/<import> --profile profile.json

# Fix frame 5 from its approved neighbour 4 (or from the key pose).
pnpm assetgrove fix-frame --strip walk-right.png --profile profile.json --family walk-right \
  --frame 5 --from 4 --out .assetgrove/fixes/walk-right [--cap 2] [--dry-run] [--json]
pnpm assetgrove fix-frame ... --frame 5 --key-pose key-pose.png
```

Every command follows the CLI contract ([decisions.md](decisions.md#cli-contract)): `--json`, the exit codes, `--dry-run` (a forecast that spends nothing and needs no key) and `--provider-script`. `animation-qa` exits 5 when any check fails, after writing the report and the previews.

## Motion templates

A template is data. Assetgrove ships idle, walk, sniff, eat, play and shelter; a target adds its own, or replaces a built-in by name, in its target profile:

```json
{
  "animation": {
    "templates": [
      {
        "name": "sleep",
        "loop": true,
        "frames": { "min": 2, "max": 8 },
        "beats": [
          { "name": "exhale", "at": 0, "contact": true },
          { "name": "inhale", "at": 0.5, "contact": true }
        ],
        "contact": "all",
        "silhouette": { "min": 0, "max": 0.1 }
      }
    ],
    "thresholds": { "footprintDrift": 0.05 }
  }
}
```

| Field            | Meaning                                                                                                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | Lowercase words joined by `-` or `_`; `none` is reserved. A family of exactly this name uses the template with no call. Any other family declares its template or has it decided (see [Which template](#which-template)): a name never matches by prefix, so `play-dead` is not `play`. |
| `loop`           | The last frame must flow into the first.                                                                                                                                                                                                                                                |
| `frames`         | The allowed frame count, `{ min, max }`.                                                                                                                                                                                                                                                |
| `cycleMs`        | Optional allowed cycle length (frames × the profile's `frames.durationMs`).                                                                                                                                                                                                             |
| `beats`          | Named moments, each `at` a fraction of the cycle (frame `round(at × count)`), `contact: true` when the feet are down.                                                                                                                                                                   |
| `contact`        | Frames whose feet must sit on the ground line: `all` (a walk keeps its feet on the ground), `beats` or `none`.                                                                                                                                                                          |
| `silhouette`     | Allowed change between consecutive frames, `1 − IoU` of their alpha masks: an idle barely moves, a walk must move some.                                                                                                                                                                 |
| `footprint`      | `planted` (the default) when the feet stay put, `moving` when the contacts move by design (a walk's legs alternate, a hop crouches and lands).                                                                                                                                          |
| `strides`        | How many times the contact pattern repeats in one cycle, default 1 (the walk: 2, one stride per leg). Frames a whole stride apart share a phase.                                                                                                                                        |
| `footprintDrift` | Optional per-family footprint drift bound, a fraction of the figure's height (the walk's feet swing, so its bound is wider).                                                                                                                                                            |
| `footprintBand`  | Optional. Where the footprint is measured: unset, the span of the bottom two rows (the lowest foot); set, the centre of the pixels in the bottom `footprintBand` (0..1) of the figure's height, so every foot near the ground counts.                                                   |
| `gaits`          | Optional footprint rule per gait, by gait name: each entry sets any of `footprint`, `strides`, `footprintDrift` and `footprintBand` over the template's own when the strip's gait is that one (see [Gait](#gait)).                                                                      |

| Built-in  | Loop | Frames | Contact | Silhouette change | Beats                                      |
| --------- | ---- | ------ | ------- | ----------------- | ------------------------------------------ |
| `idle`    | yes  | 2–12   | all     | 0–0.15            | rest, breathe-in                           |
| `walk`    | yes  | 4–16   | all     | 0.01–0.4          | contact-a, passing-a, contact-b, passing-b |
| `sniff`   | yes  | 2–12   | all     | 0–0.25            | neutral, nose-down                         |
| `eat`     | yes  | 2–12   | all     | 0–0.3             | reach, bite, chew                          |
| `play`    | yes  | 3–16   | beats   | 0.01–0.5          | crouch (contact), airborne, land (contact) |
| `shelter` | yes  | 2–12   | all     | 0–0.15            | huddle, tremble                            |

The walk also bounds its cycle to 400–2000 ms, and has a `quadruped` gait rule. `walk` (with `strides: 2`) and `play` have `footprint: "moving"`; the others are `planted`. Each built-in has a `description`, which the template decision reads; give a target's own templates one too.

## Which template

A family's template is, in order:

1. **Declared.** The asset spec's `template` names the template its `animationFamily` is judged by, as its `gait` names the gait (`"template": "play"`, or `"none"` when no template describes the motion). In a sheet import's confirmed grouping, a family may declare its own `template`. A declared template needs no call; one that is not a template's name is refused (exit 2).
2. **Named.** A family named exactly like a template (`walk`, `idle`) is that template, with no call.
3. **Decided.** Any other family (`walk-right`, `walk_left`, `jump`, `fly`, `swim`, `death`, `attack`, `play-dead`) costs one `motion-template` call: a typed choice decision (decisions role, `perplexity/pplx-decider-v1.2`, $0.001 upper bound) given the family name, the subject and each template's name and description, which chooses a template or `none`. It is made once per family and subject in a run and reserved against the run's cap and the spend ledger like any QA call. The report's `template` is the chosen template and its `templateSource` says which of these applied (`declared`, `named`, `judged`), or `undecided` when nothing declared or named the template and the command made no call.

With no template (`none` declared or chosen), the `template` reason says why, and `ground-contact`, `footprint-drift` and `loop-seam` pass as "not applicable" instead of holding the strip to planted feet on the ground line and a loop: a jump's airborne frames and a one-shot death are not failed. The strip is treated as not looping, so identity flicker makes no call on the last → first pair. The silhouette and edge checks still apply.

Undecided is not none. Where the template is undecided (only `write-families`, which spends nothing and so asks no question), `ground-contact`, `footprint-drift` and `loop-seam` are not run: the report lists them under `pending`, each "not run: template undecided", its `passed` is false, and the output says the checks are pending, never "all checks passed". The import's `written` entry records them under `pending` by family. They are neither passing nor "not applicable" until `animation-qa --import` decides the template and runs them. The strip is treated as not looping meanwhile.

Who makes the call:

| Command                                | When                                                                                                                                                                                                                                                                                                                                     | At most per run                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `animation-qa`                         | Before checking each strip whose family is neither declared, named nor decided in the import; `--no-vision` too (it is not a vision check, so that run needs a key unless the spec declares `template`). `--dry-run` lists it. Each call's model, request ID, family, answer and cost is appended to `motion-template.jsonl` in `--out`. | one per such family and subject, $0.001 each |
| `fix-frame`, `request-change` (frames) | Before the fix: the template picks the registration pin and the QA's template. The call is recorded in the fixed strip's provenance (each candidate's, in `request-change`).                                                                                                                                                             | one, $0.001                                  |
| `generate-sheet`                       | Before the sheet prompt, which states the family's motion. The answer is recorded in the import (`judgedTemplates`, its call in the generation's calls), so `write-families` and `animation-qa --import` use it as judged with no new call.                                                                                              | one, $0.001                                  |
| `write-families`                       | Never: it spends nothing. A family no grouping or spec declares and no template names is written `undecided`, its three template checks pending, and pins its footprint; `animation-qa --import` decides it and runs them.                                                                                                               | none                                         |

## Gait

How the subject moves is data, never guessed from the pixels. The asset spec's `gait` names it (for example `"gait": "quadruped"`), else the target profile's `animation.gait` (a world of four-legged animals sets it once). A template's `gaits` entry for that gait sets its footprint rule; no gait, or one the template does not list, keeps the template's own rule, and the footprint reason says which rule ran.

The built-in walk's own rule is the two-legged one: two strides per cycle, each planted frame against the same frame one stride earlier, within 6 px. Its `quadruped` rule fits a four-legged walk, whose contact pattern runs once per cycle and whose lowest foot changes from frame to frame as two or three feet are down at once: one stride, the footprint measured over the bottom 30% of the figure (every foot near the ground, taken together), each planted frame within 12 px of the loop's mean. A frame whose legs slid out from under the body fails on its own.

```json
{ "animation": { "gait": "quadruped" } }
```

`write-families` and `animation-qa --import` use the gait the asset spec gave `generate-sheet` (kept in the import record), else the profile's. `animation-qa --strip` and `fix-frame` read it from `--spec <spec.json>`, else the profile's.

## The checks

Deterministic checks come first and are measured on pixels, at the style profile's alpha cut (binary) or alpha 128 (soft), so painterly, flat-cartoon and pixel-art strips are measured alike. Each failing check names the frame and the reason.

The ground and footprint bounds are fractions of the strip's figure height (the median over its non-empty frames of the baseline row minus the top row plus 1, reported as `figureHeightPx`), so a 64 px frame and a 512 px one are held to the same standard. Where registration pinned the figure does not matter: footprint drift is how far the planted feet move between consecutive frames.

| Check              | Fails when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Bound (profile `animation.thresholds`)                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `template`         | the frame count (or the cycle length) is outside the template                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | the template                                                |
| `beats`            | the strip has fewer frames than the template has beats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | the template                                                |
| `ground-contact`   | a contact frame's feet baseline is off the ground line (the anchor's row) by more than `groundTolerance` of the figure's height                                                                                                                                                                                                                                                                                                                                                                                                                   | `groundTolerance`, default 0.02                             |
| `footprint-drift`  | `planted` families: the centre of a contact frame's footprint (the span of its bottom rows, or its `footprintBand`) moves away from the previous planted frame's (on a loop, the first against the last too). `moving` families: a planted frame's footprint centre moves away from its own phase's, which is the same frame one stride earlier (frame f against f − count/strides) when `strides` is 2 or more, else the loop's mean footprint centre. Alternating legs pass, and each frame that slid fails on its own. The gait picks the rule | `footprintDrift`, default 0.03 (template's own first)       |
| `silhouette`       | consecutive frames change more or less than the template allows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | the template                                                |
| `loop-seam`        | the last frame → first frame distance exceeds the ratio × the largest distance between consecutive frames, or × the floor when every step is smaller (so an idle hold is not failed for noise)                                                                                                                                                                                                                                                                                                                                                    | `loopSeamRatio`, default 1.5; `loopSeamFloor`, default 0.02 |
| `edge-halo`        | more than the limit of a frame's soft edge pixels (0 < alpha < 255) carry a colour more than 64 from every fully opaque pixel within 3 px (a tint or fringe left by the removed background). The share is over soft edge pixels alone                                                                                                                                                                                                                                                                                                             | `edgeHaloShare`, default 0.22                               |
| `identity-flicker` | the vision model labels a consecutive pair `flicker` at or above the cutoff, or its reply is unreadable; `texture` (painterly texture differs, the identity holds) passes                                                                                                                                                                                                                                                                                                                                                                         | `flickerCutoff`, default 0.7                                |
| `holes`            | a frame has a see-through area inside the figure's outline (pixels below the alpha cut that do not reach the frame's edge, at least `holeMinPx`) and the vision model judges one of them a hole in the figure at or above the cutoff, or its reply is unreadable; natural openings between parts pass                                                                                                                                                                                                                                             | `holeMinPx`, default 3; `holeCutoff`, default 0.7           |

Fully transparent pixels that keep a colour (a matting tool or editor that leaves the original RGB under alpha 0) are not a halo: they show only where a renderer drops alpha, and writing a strip clears them (`write-families` and `fix-frame` run apply-style). Each frame with them gets a passing `transparent-colour` note with the count, and `animation-qa` runs its vision checks and previews on the cleared frames.

`edge-halo` and `holes` report what a background removal leaves behind, on their own, so a strip with them is reported for that reason and not as identity flicker. `edge-halo` fails the strip. `holes` and `identity-flicker` are model-backed: each fails a strip only with a qualifying stability entry for its route's model, and at 0.1 neither has one, so their reasons are advisory, marked `shadow`, and the report's `filtering` says why (docs/decisions.md, "Model-backed checks advisory at 0.1"). Holes need a model, like flicker: a hole cut in a pale blaze and the gap between two legs are both transparent and both ringed by the figure's soft edge, and around a hole cut in pale fur the remaining fur often sits on the line from the background to the darker fur, so no pixel rule tells them apart. Pixels find every enclosed see-through area first, so a frame without one costs nothing; each frame with one is one `holes` call (default `google/gemini-3-flash`, estimated $0.01 a call; $0.003 to $0.008 in practice), the frame enlarged over a green backdrop with the areas marked in magenta, and the reply names each area a natural `opening` between parts or a `hole` in one part. Each decision (frame, areas, label, confidence, cutoff, cost) is in `holeDecisions` in the report.

Identity flicker needs a model too, because pixels cannot tell a pose change from a design change. It is one `flicker` call per consecutive pair (and the seam, on a loop), each with the two frames flattened over the loop preview's neutral backdrop, so the model sees what a viewer sees and not the colour a matte leaves under transparent pixels. Frames painted one by one differ in brush strokes, fur and the fine edges of markings, so the reply has three labels: `same`; `texture`, where only that painterly texture differs and the identity holds (a pass); and `flicker`, where a marking appears, disappears, moves or changes its overall shape, or a colour, the proportions or an accessory change. Its model is the `flicker` route (default `google/gemini-3-flash`, estimated $0.02 a call), which the developer settings can change (`routes.flicker` or `roles.vision`). Every call's model, request ID, pair, label, confidence, cutoff and decision is appended to `flicker.jsonl` in the output directory: the logged data the cutoff is chosen from. The default cutoff of 0.7 is a starting point until enough decisions are logged. `--no-vision` skips both vision checks and the report says so; it never counts as a pass. This checks frame-to-frame consistency within a strip only; scoring a character against its identity lock is separate work.

## Onion skin and loop preview

For each family, beside the strip:

- `<family>.onion.png`: one cell per frame, the frame over its previous frame (tinted red) and next frame (tinted blue), with the ground line and the anchor marked and the frame number underneath. On a loop the first cell shows the last frame and the last cell shows the first, so the seam is visible. Frames with a failed check have a red border. A last cell overlays every frame faintly, so drift shows at a glance.
- `<family>.webp`: a lossless animated WebP that loops forever at the profile's frame duration (default 120 ms), on a neutral backdrop so soft alpha reads correctly in any viewer.

A run's contact sheet (`contact.png`), which the person picks from, shows up to six key frames of each strip: every frame a failing check names (shown even when there are more than six), then frames spread evenly over the rest. For a staged strip those checks are animation QA's deterministic checks (template, beats, ground contact, anchor and footprint drift, silhouette change, loop seam, edge halo), run on the strip under the run's profile, the spec's family, anchor and gait when the contact sheet is drawn; the vision checks are not run there. A generated sheet's row likewise always shows the frames whose background checks failed.

Both are plain image files (`image/png`, `image/webp`), so a target's review shows them as it shows any image. `write-families` writes them into the import's `preview/` directory; `animation-qa` writes them, with `<family>.qa.json`, into `--out`.

## Per-frame fix

A reference-guided edit of one frame. Image 1 is the approved neighbour frame (`--from <n>`) or the approved key pose (`--key-pose <file>`); image 2 is the bad frame. The `edit` route makes one call, reserved against the cap (default $2) first. The result is matted when it has no alpha, scaled so its area matches the reference's, registered by its family's pin (a planted family's ground footprint, a moving family's centre of mass, as sheet import registers it) with that pin point where the reference neighbour's is (with a key pose, the frame beside the fixed one) and its bottom row on the neighbour's when the neighbour stands on the ground line (within the profile's `groundTolerance`, at least one row), else on the ground line, so a landing frame fixed next to an airborne beat still lands, and its feet stay on its neighbours' whether stage or sheet import placed the strip, and styled to the profile. Only that frame changes; every other frame stays byte-identical.

`--out` receives the fixed strip, its provenance, its QA report and new previews. The provenance carries the strip's own record forward (read from `--provenance`, or `<strip>.provenance.json` beside it) and adds the call (model, route, prompt, seed, request ID, time, cost), a `fixes` entry (frame, source, the frame's pixel hashes before and after) and an `edit-frame` transform on that frame. A strip with a model-edited frame is disclosed as a composite with trained algorithmic media unless it was fully generated already. The fix never writes into a target and never sets a review value: the person picks the fixed strip and hands it off.

The provenance file is checked before the edit call, so a file the fix cannot extend costs nothing. It accepts a strip's own provenance (from `write-families`, `pick` or an earlier `fix-frame`) and the transform record `recipe` or `op` wrote, when one of that record's outputs has the strip's pixels; the fix then records the transform's sources, recipe and steps and adds its call. Any other file is refused with exit 2, naming what is wrong with it. A strip's own provenance must be the record of that strip: one whose calls are not those the strip's mark records, or whose binding does not hold, exits 2 `provenance_mismatch` naming both files ([decisions](decisions.md#provenance-is-bound-to-its-media)). A `<strip>.provenance.json` 0.1.0 wrote, which has no binding, is refused with the one command that hands the strip off again (`write-families` for an imported strip, `pick` for a generated one). The fixed strip's mark carries the provenance's models and the sha256 of its calls, and its provenance is bound to it.

## Proof on real art

A real sprite sheet is never committed. `test/real/animation.real.ts` runs on one when `ANIMATION_SHEET` points at a local copy and `ANIMATION_GROUPING` at an author-confirmed grouping: it imports, writes the families into a temporary target, runs the QA and writes the onion sheets and previews to `ANIMATION_OUT` (default a temporary directory, printed). With `AI_GATEWAY_API_KEY` set it also runs one identity-flicker pass and one per-frame fix within a $2 cap. Run it with `pnpm test:real`; it skips without the sheet.
