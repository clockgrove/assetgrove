# Animation that holds together

A strip, whether imported from a sheet ([sheet-import.md](sheet-import.md)) or generated, is checked against its family's motion template and by loop and continuity QA. The person picking sees an onion-skin sheet and a looping preview. A single bad frame is repaired by a per-frame fix. Assetgrove never approves a strip; it measures, reports and shows.

## The commands

```sh
# Written families: write-families already runs the pixel checks and writes the previews.
pnpm assetgrove write-families --import .assetgrove/imports/<import> --target ../my-game

# The full QA on one strip, identity flicker and holes included (decision calls within the cap).
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

| Field            | Meaning                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`           | The family it serves: lowercase words joined by `-` or `_`. It also matches `<name>-<suffix>`, so `walk` serves `walk-right` and `walk-left`, and `sit-groom` serves exactly `sit-groom` (and `sit-groom-<suffix>`). An exact match wins, then the longest prefix. |
| `loop`           | The last frame must flow into the first.                                                                                                                                                                                                                           |
| `frames`         | The allowed frame count, `{ min, max }`.                                                                                                                                                                                                                           |
| `cycleMs`        | Optional allowed cycle length (frames × the profile's `frames.durationMs`).                                                                                                                                                                                        |
| `beats`          | Named moments, each `at` a fraction of the cycle (frame `round(at × count)`), `contact: true` when the feet are down.                                                                                                                                              |
| `contact`        | Frames whose feet must sit on the ground line: `all` (a walk keeps its feet on the ground), `beats` or `none`.                                                                                                                                                     |
| `silhouette`     | Allowed change between consecutive frames, `1 − IoU` of their alpha masks: an idle barely moves, a walk must move some.                                                                                                                                            |
| `footprint`      | `planted` (the default) when the feet stay put, `moving` when the contacts move by design (a walk's legs alternate, a hop crouches and lands).                                                                                                                     |
| `strides`        | How many times the contact pattern repeats in one cycle, default 1 (the walk: 2, one stride per leg). Frames a whole stride apart share a phase.                                                                                                                   |
| `footprintDrift` | Optional per-family footprint drift bound, a fraction of the figure's height (the walk's feet swing, so its bound is wider).                                                                                                                                       |
| `footprintBand`  | Optional. Where the footprint is measured: unset, the span of the bottom two rows (the lowest foot); set, the centre of the pixels in the bottom `footprintBand` (0..1) of the figure's height, so every foot near the ground counts.                              |
| `gaits`          | Optional footprint rule per gait, by gait name: each entry sets any of `footprint`, `strides`, `footprintDrift` and `footprintBand` over the template's own when the strip's gait is that one (see [Gait](#gait)).                                                 |

| Built-in  | Loop | Frames | Contact | Silhouette change | Beats                                      |
| --------- | ---- | ------ | ------- | ----------------- | ------------------------------------------ |
| `idle`    | yes  | 2–12   | all     | 0–0.15            | rest, breathe-in                           |
| `walk`    | yes  | 4–16   | all     | 0.01–0.4          | contact-a, passing-a, contact-b, passing-b |
| `sniff`   | yes  | 2–12   | all     | 0–0.25            | neutral, nose-down                         |
| `eat`     | yes  | 2–12   | all     | 0–0.3             | reach, bite, chew                          |
| `play`    | yes  | 3–16   | beats   | 0.01–0.5          | crouch (contact), airborne, land (contact) |
| `shelter` | yes  | 2–12   | all     | 0–0.15            | huddle, tremble                            |

The walk also bounds its cycle to 400–2000 ms, and has a `quadruped` gait rule. `walk` (with `strides: 2`) and `play` have `footprint: "moving"`; the others, and a family no template matches, are `planted`. A family no template matches still gets the loop and continuity checks, with the defaults, and its report says no template matched.

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
| `identity-flicker` | the typed decision "Does the character's identity change between frame A and frame B, setting aside pose and brush texture?" answers true with a probability at or above the cutoff (by default, true at all)                                                                                                                                                                                                                                                                                                                                     | `flickerCutoff`, default 0.5                                |
| `holes`            | the typed decision answers true with a probability at or above the cutoff: with the frame's image before background removal, "Is any part of the character missing after background removal?"; without it, whether a see-through area inside the figure's outline (pixels below the alpha cut that do not reach the frame's edge, at least `holeMinShare` of the frame's figure area and at least 1 px) is a hole cut into the character rather than an opening between parts                                                                     | `holeMinShare`, default 0.0001; `holeCutoff`, default 0.5   |

Fully transparent pixels that keep a colour (a matting tool or editor that leaves the original RGB under alpha 0) are not a halo: they show only where a renderer drops alpha, and writing a strip clears them (`write-families` and `fix-frame` run apply-style). Each frame with them gets a passing `transparent-colour` note with the count, and `animation-qa` runs its vision checks and previews on the cleared frames.

`edge-halo` and `holes` report what a background removal leaves behind, on their own, so a strip with them is reported for that reason and not as identity flicker. `edge-halo` fails the strip. `holes` and `identity-flicker` are model-backed: each fails a strip only with a qualifying stability entry for its route's model and its version (2, the typed decisions), and at 0.1 neither has one, so their reasons are advisory, marked `shadow`, and the report's `filtering` says why (docs/decisions.md, "Model-backed checks advisory at 0.1"). Both are typed Boolean decisions through the decide interface ([generation-knobs.md](generation-knobs.md)), so the number each reports is the model's probability for its answer, not a confidence it writes itself.

Holes need a model, like flicker: a cut in a pale belly or blaze and the gap between two legs are both transparent and both ringed by the figure's soft edge, so no pixel rule tells them apart. The commonest failure is a border flood that eats a pale belly or muzzle open to the outside, which no enclosure test sees, so where the image before background removal exists the frame is always shown. A sheet import keeps each frame's crop of the sheet before removal (`frames/fNNN.source.png`, `source` on the imported frame) and each write records the frames each family's strip was made from, so `animation-qa --import` makes one `holes` decision per frame of every strip it checks with vision on: image 1 is the crop before removal, image 2 the cleaned figure over a magenta backdrop (everything removed shows magenta), both enlarged with crisp edges until the shorter side is at least 384 px, since some decision models reject small images, and the question is "Is any part of the character missing after background removal?". A strip given on its own (`--strip`), or an import written before this, has no such image: pixels find the see-through areas the figure's outline encloses, at least `holeMinShare` of the frame's figure area (the default 0.0001 is 1 px for a 20 px square figure, so a 2 px hole in an eye in a 32 px frame is judged, and 16 px for a 400 px square figure, so a 3 px speck of matte noise in a 512 px frame is not and a 4 x 4 px hole is), and each frame with one is one `holes` decision on the frame enlarged over a green backdrop with the areas in magenta: is any of them a hole cut into one part rather than a natural opening between parts. A strip with neither gets a passing `deterministic` reason that says a cut reaching the outline was not judged. `fix-frame`'s own QA and `stage` make no holes call. Each `holes` decision is the `holes` route (default `perplexity/pplx-decider-v1.2`, the `decisions` role, estimated $0.001 a call), reserved against the cap with the flicker decisions before the first call. Each decision (frame, view, areas, label, probability, cutoff, cost) is in `holeDecisions` in the report.

Identity flicker needs a model too, because pixels cannot tell a pose change from a design change. It is one typed Boolean `flicker` decision per consecutive pair (and the seam, on a loop), each with the two frames flattened over the loop preview's neutral backdrop and enlarged with crisp edges until the shorter side is at least 384 px (some decision models reject small images, as the identity call notes), so the model sees what a viewer sees and not the colour a matte leaves under transparent pixels: "Does the character's identity change between frame A and frame B, setting aside pose and brush texture?", where the identity is the markings and where they sit, the colours, the proportions and the accessories, and painterly texture and the fine edges of markings are not. Its model is the `flicker` route (default `perplexity/pplx-decider-v1.2`, estimated $0.001 a call), the `decisions` role, which the developer settings can change (`routes.flicker` or `roles.decisions`). Every decision's model, request ID, pair, label, probability, cutoff and verdict is appended to `flicker.jsonl` in the output directory: the logged data a per-model cut is chosen from once enough decisions are logged. Until then the pair is flagged on the answer alone (`flickerCutoff` 0.5, the Boolean's own true line) and the reason prints the probability, so a correct `flicker` at 0.65 is no longer hidden. `--no-vision` skips both checks and the report says so; it never counts as a pass. This checks frame-to-frame consistency within a strip only; scoring a character against its identity lock is separate work.

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
