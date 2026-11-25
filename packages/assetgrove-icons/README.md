# @clockgrove/assetgrove-icons

The icons pack for Assetgrove: one icon per asset, at one size, checked against the backgrounds it will sit on.

## Extension API

The package declares `"assetgrove": { "api": 2 }` and a peer range on `@clockgrove/assetgrove`. It declares, as extension `icons`, the kind `icons:family` with its operations `icons:still` and `icons:identify` and its two checks.

## Install

Install it beside core and list it in the developer settings:

```json
{ "extensions": ["@clockgrove/assetgrove-icons"] }
```

## The `icons:family` kind

An icon family is the assets that share a `subject`. Each asset is one icon at one size.

```json
{ "kind": "icons:family", "assetId": "save-idle", "subject": "save" }
```

The target profile carries a `kinds["icons:family"]` block:

```json
{
  "kinds": {
    "icons:family": {
      "size": 32,
      "backgrounds": ["#f4efe1", "#1d2b35"],
      "layout": { "media": "assets/icons/{{spec.subject}}/{{spec.assetId}}.{{output.extension}}" }
    }
  }
}
```

- `size`: whole pixels, the side of a square icon.
- `backgrounds`: a non-empty list of flat `#rrggbb` colours the icon will sit on.
- `layout`: optional, as for any kind (`kinds.<kind>.layout`). An icon has no animation family, so a layout names the subject and asset id.

A profile without the block is refused at plan: exit 2 `invalid_input`.

The kind generates with the operation `icons:still` (role `image`). It scales the image to fit `size` × `size`, centred, and applies the profile's alpha and colour rule. It passes no typed call parameters, so it works on any image route.

## Checks

### `icons:boundary-contrast`

Exact, free, and it filters. For each declared background the icon is composited over it. The boundary is taken at the profile's `style.alpha.threshold` (core's default: 1 for soft alpha, 128 for binary):

- an icon pixel is inside when its alpha is at least the threshold;
- a boundary pixel is an inside pixel with a left, right, up or down neighbour outside;
- that neighbour is its adjacent background pixel. It is composited too, so a soft edge below the threshold counts as background. Beyond the image edge it is the bare background.

The WCAG 2.2 contrast ratio of each pair (WCAG's relative luminance and `(L1 + 0.05) / (L2 + 0.05)`) is computed unrounded. The check fails when the minimum is below 3:1. There is one reason per background, naming the background and the ratio, shown truncated to three decimals and never rounded up: 2.9996 reads `2.999:1`. An icon with nothing visible at the threshold fails.

Set the threshold. Under soft alpha core's default threshold is 1, so every faintly visible pixel is inside. Scaling a source whose side is not a whole multiple of `size` blends its edge into pixels of low alpha, and those become the boundary: composited, they sit close to the background, and the check fails on every background even for a dark icon on white (a `#2b2b2b` square scaled from 60px to 16px fails on `#ffffff`; from 64px, or with binary alpha, it passes at 14.159:1). Set `style.alpha.threshold` in the profile to the alpha at which an edge pixel counts as the icon (128 judges the half-covered edge), or set `style.alpha.mode` to `"binary"`:

```json
{ "style": { "alpha": { "mode": "soft", "threshold": 128 } } }
```

It uses WCAG's formula. It does not prove WCAG conformance: non-text contrast in WCAG depends on what the icon conveys and on its real surroundings, which the check cannot know.

### `icons:identifiable`

A model check, advisory. For each background it makes one boolean decision (operation `icons:identify`, role `decisions`): is the icon recognisable as its subject over that background. The pack ships no stability entry, so its reasons are advisory (`shadow`) and never filter, until a measured stability entry qualifies it ([QA checks](../../docs/extensions.md#qa-checks)).

## Family consistency

There is no new check. Audit the family as a folder:

```sh
assetgrove audit asset://<game>/by-subject/<family>/
assetgrove audit asset://<game>/by-subject/<family>/ --dry-run
```

The audit scores each member's style against the bible and the other members, and reports the spread and the set-consistency bar. `--dry-run` prints the forecast.

## Routing

Settings `routes["icons:still"]` and `routes["icons:identify"]` choose the route. Without them the roles `image` and `decisions` do.

## Limits

One size only. Size sets and icon atlases come after 1.0.

## Development

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
```

The tests use the scripted provider and never call a model.
