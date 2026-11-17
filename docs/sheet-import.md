# Sheet import and sheet generation

Animation starts as a whole contact sheet. A model can generate a whole cycle as one sheet, and that keeps the character's identity consistent across frames. The import path turns a raw sheet into game-ready strips. The sheet can come from Assetgrove's own sheet generation, ChatGPT or any other tool, or hand work. Per-frame reference edits are the fallback for fixing a single frame.

## The commands

```sh
# A sheet made elsewhere: slice, clean, and stage a grouping proposal.
pnpm assetgrove import --sheet bram-sprite-sheet.png --profile profile.json --bible bible.json \
  --asset bram --tool "ChatGPT image generation" \
  --digital-source-type trainedAlgorithmicMedia --frames 57 \
  --hints idle,walk-right,walk-left,crouch-hop,look,sit-groom

# Or have the model draw the cycle as one sheet (spec: assetId, animationFamily, frames.count).
pnpm assetgrove generate-sheet --spec fern-walk.json --bible bible.json --profile profile.json

# After reviewing and confirming grouping.json:
pnpm assetgrove write-families --import .assetgrove/imports/<import> --target ../my-game
```

## What each step does

1. **Slice.** The background is the median of the sheet's border. Every pixel farther from it than the tolerance is foreground (on a sheet with real alpha, alpha below 128 also counts as background). Figures are connected components; a sharp drop in size separates them from labels and specks. A grid is detected from the figures' centres: equal columns and rows, one figure per cell. The detected grid only numbers the figures: each figure is the same component it was detected as, and its crop is not cut at the cell's edge, so a tail that reaches past the cell into the gutter stays whole. `--grid <columns>` sets the grid instead. Cells are the sheet's width over the columns wide and its height over the rows tall. With a count (`--frames`, or the spec's `frames.count` in `generate-sheet`) the rows are count ÷ columns rounded up. Without one, the rows are the rows the whole figures sit in (their centres clustered by height, as grid detection does; a component under 0.45 of a typical large one's size, such as a prop beside a figure, is not a whole figure), when the figures fill those rows one per cell, else square cells. Either way the cut is judged on the cut itself, not on where the figures' centres sit, so a jump with raised figures still slices. A cut fails when a cell holds the centres of two whole figures, or when cell edges cut straight through (at half a figure's width or more) components holding over half the figures' area. A figure that hangs into the cell below, a prop in every cell, or figures touching the one below at a narrower contact do not fail it. A failing count is refused, never sliced to fit (`--grid 4 --frames 4` on a 4 × 2 sheet of 8 figures puts two whole figures in a cell; `--grid 4 --frames 12` on the same sheet cuts every figure). With no count, when neither the clustered rows nor square cells hold the figures, the sheet is refused and the frame count asked for (a 4 × 2 sheet of tall cells with one raised figure). So a 4 × 2 sheet of tall cells is never cut into square half-figures. Each cell is then segmented on its own against its border's colour, so figures that touch across a cell edge come apart, and the largest component in a cell is its figure. `--components` skips grid detection. Without a clean grid, each figure is located on its own and numbered in reading order. Small components inside a figure's box are kept as detached parts; every other component (number labels, specks, a neighbour's tail) is dropped. Gutters and background never enter a frame.

   **A blob its area cannot tell is judged.** A component under the figure size that is still at least the label fraction (`labelFraction`, 4% of the largest component) is ambiguous: a crouched frame, a small companion or a large label. So is any component under the figure size outside every figure's box: a detached tail segment, a dust puff, a thrown prop, a label or a speck. `import` and `generate-sheet` ask one `sheet-blob` decision for each before slicing, shown the blob's cell (without a grid, the blob and the nearest figure) with the blob outlined, and told the frame count the sheet should hold. Ambiguous components within 5% of the median figure's height of each other are one blob, so a label's letters are asked about once. The answer decides: a `figure` is a frame whatever its size, a `part` joins the nearest figure (its crop grows to hold it), a `label` or `speck` is dropped. The answers are the slice step's parameters (`blobs`, by each component's box), so the step replays from its record, and `import.json`'s `slice.blobs` lists each blob judged and its answer. A clean sheet, whose every component is a figure or a small part inside one's box, makes no call. At most 24 are asked per sheet, the largest first; any further ambiguous blob keeps the area rule (dropped) and is counted in `slice.unjudged`. The `slice` operation of a recipe asks nothing: a blob with no answer keeps the area rule there. The exact frame-count check below still applies after the answers.

   **The frame count is checked.** `generate-sheet` requires exactly the spec's `frames.count` figures, and `import --frames <count>` requires that many. Slicing another number is refused, never returned short: the error names, on a grid, each cell among the first `count` that holds no figure and why (nothing differs from the background, or its largest part is under the figure size), and a figure far above the median figure's size (touching figures merged) when too few were found, or far below it (a figure that came apart, or a large label) when too many were. `import` exits 2 before any model call but the `sheet-blob` decisions, whose answers the count is taken after. `generate-sheet` exits 5, as the generated sheet failed QA; the sheet and its generation record (`sheet.json`: prompt, calls, cost, and the slice's finding) are kept in the import directory, so it can be imported by hand with `--grid`.

2. **Remove the background**, following the target's style profile (below). Slicing's colour tolerance also catches the figure's own pale parts (a white blaze, brows, a muzzle or pale tail rings on a pale sheet), so those are given back first: only the flat background colour (within the spread of the cell's border, at least 8) and the pixels within 3 px of it are background. Flat background counts where it reaches the crop's border, and in an enclosed gap (a space between an arm and the body) that is mostly background and shows it: a flat core, four or more flat pixels, or flat pixels among blends of the background with the figure around it. Any other enclosed run is a marking and stays opaque; the matte step records how many pixels it gave back as `markingPixels`. The figure's interior stays opaque. In a thin band at its outer edge, and on pale fur strands just outside it, each pixel is unmixed from the background against the nearby figure colour that explains it best, which gives soft 8-bit alpha that keeps fur edges. The colour is that figure colour plus the pixel's own detail scaled by its alpha, never divided by alpha, so faint pixels carry the fur's colour and no tint or fringe from the removed background; a transparent pixel carries no colour. A binary profile then thresholds alpha, and a palette profile snaps colours. Labels, specks and neighbouring figures found while slicing, and a 2 px fringe around them, are made fully transparent even where they touch the band. Every frame is checked for halos (visible edge pixels that are the flat background colour) and for leftover background (opaque interior pixels of that colour), each under the same limit (of edge pixels and of visible pixels), 0.5% by default. The limit is the target's policy: a style whose figures carry a pale rim or outline near the sheet's background colour needs a wider one, so `import` and `generate-sheet` take `--max-halo <fraction>` (0 to 1) and record it in the matte step's parameters. A frame that fails is reported and is refused at write time.

   The import keeps each frame twice in `frames/`: the cleaned figure (`fNNN.png`) and the same crop of the sheet before removal (`fNNN.source.png`, `source` on the imported frame), so the holes check of `animation-qa --import` can show the frame before and after removal ([animation.md](animation.md)). Each write records, per family, the imported frames its strip was made from.

3. **Register.** Each frame's feet baseline (the lowest row at alpha 128 or more) and its family's pin point go to the anchor, which defaults to the bottom centre of the target's frame. Within a family, each frame's scale is normalised to the family's median √(opaque area), clamped to ×0.8–1.25, so a sheet whose figure changes size from cell to cell comes out even. The pin follows the family's motion template, the one animation QA judges it by (with the import's gait): a planted family (`sniff`, `idle`, or a family no template matches) pins the centre x of its ground footprint (the pixels at alpha 128 or more in the bottom 10% of the figure's height), because a planted pose whose head drops or tail swings moves its centre of mass, not its feet; a family whose contacts move (`footprint: "moving"`, such as `walk`) pins its centre of mass, because its feet swing under a body that stays put. One common scale fits every written family into the target's frame size; it is fitted on the import's first write, stored in `import.json` as `scale`, and reused by every later write so all families of the asset stay one size. Pixel-art profiles resample nearest-neighbour; every other profile filters with premultiplied alpha.
4. **Measure jitter.** On each registered frame, jitter is the largest distance, in px, of the baseline or the family's pin point from the anchor. A family over the bound (default 1 px, `--jitter-bound`) is refused, and nothing is written.
5. **Propose a grouping.** A vision model sees a numbered contact sheet of the cleaned, registered frames (`contact.png`) and the subject's references. It proposes families, frame order, mirror pairs and a reason for each. The proposal is saved as `grouping.json` with `"status": "proposed"`.
6. **The author confirms.** Edit `grouping.json`: rename, regroup and reorder families, drop frames or whole families, and decide mirroring. A family is either `frames` (in play order; a frame may repeat for a hold) or `mirrorOf` another family, which is that family's frames flipped horizontally. Set `"status": "confirmed"`. `write-families` refuses any other status. Assetgrove never confirms a grouping itself. A family may also declare the motion template it is judged by, `"template": "walk"` (or `"none"`); without one, a family named exactly like a template uses it, a sheet `generate-sheet` made uses the template it chose for the spec's family, and any other family is written as `undecided` by `write-families` (which makes no call), its ground-contact, footprint-drift and loop-seam checks pending ("not run: template undecided", not passing) until `animation-qa --import` decides the template and runs them ([animation.md](animation.md#which-template)).
7. **Write.** One strip, manifest and provenance file per family, in the target's layout, with the review field at the profile's pending value. When a spec asked for the sheet (`generate-sheet`), its target fields (atlas slot, labels, semantics) go to the confirmed family named its `animationFamily`. If no family has that name and the grouping has exactly one family with frames of its own (a mirror does not count), the fields go to that one: the written family's `fieldsNote` says so, and so does the command's output. Otherwise `write-families` refuses before writing anything (exit 2), naming the confirmed families, so a manifest never loses its target fields silently. The target's validator runs on each one. `preview.html` in the import directory loops every written strip at the profile's frame duration and shows its jitter. Each family is also checked against its motion template and by loop and continuity QA, and gets an onion-skin sheet (`preview/<family>.onion.png`) and a looping animated WebP (`preview/<family>.webp`); see [animation.md](animation.md).

```json
{
  "status": "confirmed",
  "families": [
    { "name": "idle", "frames": [1, 2, 3, 4, 5, 6], "reason": "standing, breathing" },
    {
      "name": "walk-right",
      "frames": [7, 8, 9, 10, 11, 12, 13, 14],
      "reason": "a right walk cycle",
      "template": "walk"
    },
    {
      "name": "walk-left",
      "mirrorOf": "walk-right",
      "reason": "the right walk, mirrored",
      "template": "walk"
    }
  ],
  "unassigned": []
}
```

The import runs on the media transformation core ([transform.md](transform.md)). Importing is the recipe `slice → matte`, the contact sheet is `register → apply-style`, and writing is `flip` (for mirrored families) `→ register → apply-style → join`. `import.json` and each strip's provenance list these steps under `steps`.

## Style profile

The target profile's optional `style` decides post-processing. Each world declares its own; nothing assumes one style.

| Field                   | Values                                          | Default                                |
| ----------------------- | ----------------------------------------------- | -------------------------------------- |
| `style.alpha.mode`      | `soft` (8-bit alpha) or `binary` (0 or 255)     | `soft`                                 |
| `style.alpha.threshold` | the opacity bounds count from, and binary's cut | 1 for soft, 128 for binary             |
| `style.color.rule`      | `full` (no quantization) or `palette`           | `full`                                 |
| `style.color.palette`   | `#rrggbb` colours for the palette rule          | the bible's palette                    |
| `style.edges`           | `antialiased` or `crisp` (nearest-neighbour)    | `crisp` for binary, else `antialiased` |

A painterly world declares `{ "alpha": { "mode": "soft" }, "color": { "rule": "full" } }`. A pixel-art world declares `{ "alpha": { "mode": "binary" }, "color": { "rule": "palette" }, "edges": "crisp" }`.

Only the import path follows the style profile. `stage` and `pick` use binary alpha and the bible's palette.

## Provenance

A family's provenance record (`generator: "sheet-import"`) holds:

- the source sheet: path, SHA-256, media type, and the model or tool that made it;
- the model calls Assetgrove made: the sheet generation, if any, and the grouping proposal, with their prompts, request IDs, times and costs;
- the identity score of the contact sheet against the character's identity lock, when `--lock-bible` was given and the character has a lock (`identity`; see [generation-knobs.md](generation-knobs.md#identity-lock-scoring)). In enforce mode a sheet below the threshold is still imported, so the person sees it and why, but `write-families` refuses it;
- the parameters: style, frames, mirroring, the family's reason, the common scale and the measured jitter;
- `steps`: the transformation steps from the sheet to the strip, each with its parameters, engine and version, and input and output pixel hashes;
- one entry per strip frame: its frame number, sheet hash, cell, tool and every transform applied (`crop`, `strip-labels`, `matte`, `binarize` and `quantize` where the style asks, `mirror`, `normalize-scale`, `scale`, `place`).

For an imported sheet, the prompt field says that the tool's own prompt is not recorded. Manifest templates can read `{{output.jitterPx}}`, and `{{profile.style}}` for the style. `{{output.palette}}` is set only under a palette rule, so a full-colour template reads it as `{{output.palette?}}`.

Written sheet images and strips carry the [Digital Source Type disclosure](transform.md#digital-source-type-disclosure) in provenance and, when known, PNG XMP, with a metadata-writing step. For an external sheet, an embedded disclosure is preserved. Untagged sheets remain `undeclared` in provenance and receive no IPTC Digital Source Type value in XMP; Assetgrove never guesses that they are human-made. Local import, staging and previews still work, but publication or export into a target, handoff or package refuses undeclared assets with a message naming `--digital-source-type`.

Use `import --digital-source-type trainedAlgorithmicMedia` for an untagged model-generated sheet such as a ChatGPT export, or `--digital-source-type compositeWithTrainedAlgorithmicMedia` for human work edited with a model. The flag accepts IPTC vocabulary codes or their full HTTP URIs, including `digitalCreation` for explicitly declared human digital creation. Assetgrove validates the declaration and records who declared it in provenance. A free-text `--tool` label alone does not establish origin. Assetgrove's own `generate-sheet` calls establish the generated source type automatically. Slicing, matting, registration and mirroring are deterministic processing and do not erase known lineage. Bounds and pixel hashes use decoded RGBA; file SHA-256 covers the final PNG, including any embedded metadata. The target profile's validator sees those final bytes.

## Cost

The sheet prompt states the family's motion template: its description and beats, a held pose when the template allows only a small silhouette change (`shelter`, `idle`), and the loop. `--brief <brief.json>` adds the author's brief (purpose, where it appears, what happens), checked as `plan` checks a brief, so the model draws the motion the author asked for rather than its own idea of the family.

`generate-sheet` makes one `sheet` call (default `openai/gpt-image-2` at 1536x1024, estimated at $0.30) and one `vision` call for the grouping ($0.02). Both are reserved against the cap (default $5) before either is made. `import` makes the one grouping call, unless `--no-propose` is given. Both make one `sheet-blob` decision (estimated at $0.001) per blob slicing cannot tell by area, at most 24 per sheet: `import` forecasts exactly as many as its sheet has, `generate-sheet` the 24 upper bound, since its sheet is not made yet. A clean sheet makes none, so `import --no-propose` on one needs no key; on a sheet with ambiguous blobs (number labels, a detached part) it needs a decisions route. With `--bible`, either command first makes the prompt policy's model check (one `prompt-policy` decide call, estimated at $0.001), even with `--no-propose`, so that import then needs a decisions route. With `--lock-bible` and a locked character, either command adds one `identity` decision call (estimated at $0.001), reserved with the rest. That call is made in the default shadow mode too, so `import --no-propose --lock-bible` on a locked character needs a gateway key; add `--identity-mode off` to import it without one.
