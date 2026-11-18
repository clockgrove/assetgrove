# BIBLE.md, the style bible

`BIBLE.md` is a world's one style bible: YAML front matter (the constitution) and Markdown prose after it. `init` writes one to `.assetgrove/art-direction/BIBLE.md` from a preset; the target repository owns it. Every command that takes `--bible` reads it, and a JSON file given as `--bible` is refused. This page says what each field means, which commands read it and how to change it safely. The full reference is [target-profile.md](https://github.com/clockgrove/assetgrove/blob/main/docs/target-profile.md#style-bible) and [generation-knobs.md](https://github.com/clockgrove/assetgrove/blob/main/docs/generation-knobs.md#four-layers).

## Fields

| Field                    | Required             | What it is                                                                                                                                                                                                                                                                                                 |
| ------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`                 | yes                  | `assetgrove-style-bible/1`, first. `assetgrove migrate BIBLE.md --kind style-bible` adds it to an older bible.                                                                                                                                                                                             |
| `version`                | yes                  | The bible's version. Every library card records the version it was made under; `library drift` counts assets made under any other version (equality, not order), so change it when the look changes.                                                                                                       |
| `world`, `preset`        | yes                  | The world's name, and the preset the bible started from (`cozy-storybook`, `flat-cartoon-kids`, `dark-gritty-isometric`).                                                                                                                                                                                  |
| `axes`                   | yes                  | The look: `rendering` (`painterly`, `naturalistic`, `flat-cartoon`, `pixel`, `stylised-3d`), `realism`, `proportions`, `outline` (`weight` `none`/`thin`/`bold`, `colour` a token reference such as `"{outline}"`), `shading` (`soft`, `cel-2-3-tone`, `flat`), `detailDensity`, `texture`, `lightingKey`. |
| `looks`                  | no                   | Per-domain overrides keyed by look name (`character`, `environment`): any axes, `rendering` included. A spec whose `look` names one gets those axes and the anchors of that look.                                                                                                                          |
| `tone`                   | yes                  | `audience` (`young-kids`, `all-ages`, `teen`, `mature`), `moodRange` (allowed moods), `contentLimits`.                                                                                                                                                                                                     |
| `adjustable`             | yes                  | What a brief may adjust: `mood` (a subset of `tone.moodRange`), enumerations, and numeric bounds inside the tokens' ranges. Audience, tone, palette, colour rule, identity, content limits, rendering and proportions can never be listed.                                                                 |
| `anchors`                | yes                  | `positive` and `negative` image lists. Each has `path` (relative to the bible, inside the project root) and `role` (free text), and optionally `subject`, `look` (a declared look), `view` and `license`.                                                                                                  |
| `colorRule`              | yes                  | `full`, or `palette` to snap colours to the palette.                                                                                                                                                                                                                                                       |
| `tokens`                 | yes                  | DTCG 2025.10 typed tokens. Needs `palette` (sRGB `color` tokens; at least one), `light`, `rim`, `fog.colour`, the outline colour token, and `number` tokens `fog.density`, `valueRange.min`/`max`, `saturation.min`/`max` (all within 0..1).                                                               |
| `identities`             | yes (may be `{}`)    | Identity locks keyed by subject: `version`, `approved: true`, `turnaround` (an approved image), optional `references`, `signatureFeatures`, `proportions`, `palette` (hex colours).                                                                                                                        |
| `referenceLicense`       | when it lists images | The terms the anchors, lock images and perspective sample were provided under: an SPDX ID, `LicenseRef-*` or `NOASSERTION`. An anchor's own `license` overrides it for that image.                                                                                                                         |
| `perspective`            | for 2D stages        | The image whose camera angle stills, strips and sheets match. 3D does not use it.                                                                                                                                                                                                                          |
| `perspectiveDescription` | no                   | The view in words for vision QA, such as `isometric, three-quarter view from above`.                                                                                                                                                                                                                       |
| `subjects`               | no                   | `{ <subject>: { description } }`: plain words for the prompt and QA. A locked subject without one is described by its lock's proportions and signature features.                                                                                                                                           |

`view` says what an anchor shows of its subject: `front`, `left`, `right`, `back`, `three-quarter`, `sheet` (several views on one sheet) or `detail`. `left` and `right` are the character's own sides. A 3D character request needs a reference that shows `front`; without `view` a model judges it.

The prose keeps the rationale. Its `Do's and Don'ts` section says how to read the positive and negative anchors, and planning reads it.

## Who reads what

- **`plan` and `apply`** compile the whole constitution into the prompt, attach the locked subject's turnaround, and use the negative anchors.
- **`stage`, `generate-sheet`, `import`, `look-dev`, `request-change` and `fix-frame`** read the bible's style view, derived on every load:
  - a subject's references: the positive anchors naming it (with a `look`, only for specs of that look), then its lock's turnaround and references, each once. The perspective sample is left out unless its anchor names a subject. Negative anchors are never sent here.
  - the palette from `tokens.palette`, and the perspective sample and its description;
  - style notes: every axis, the audience and each content limit. An axis a look overrides reads "unless the asset's look sets it", and the look adds its own value. The mood is `tone.moodRange`.
  - `generate-sheet` and `import` read `--bible` for `--lock-bible` unless that names another file.
- **A brief** adjusts only what `adjustable` lists; anything else in it that departs from the bible is refused, naming the field.

## Changing the bible

1. Edit the front matter by hand, or rewrite the look and tone from a preset with `assetgrove bible preset --bible BIBLE.md --preset <preset>` (keeps the palette, anchors and locks).
2. Run `assetgrove bible describe --bible BIBLE.md`. It validates every field and prints the constitution; it calls no model.
3. Change `version` when the look changes, so `library drift` shows what was made under the old one. `apply` refuses plans made from an earlier bible.
4. After changing an identity lock, run `assetgrove identity-check --bible BIBLE.md --subject <name>` (paid; `--dry-run` forecasts it).
5. A new image needs its licence: `referenceLicense`, or the anchor's own `license`. Keep every path inside the project root.

A target repository may add checks of its own, such as requiring every positive anchor to be an approved image; run them too.
