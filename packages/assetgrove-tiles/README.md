# @clockgrove/assetgrove-tiles

The tiles pack for Assetgrove: a corner-16 terrain tile set between two terrains, made as one atlas image and checked for its grid and its seams.

## Extension API

The package declares `"assetgrove": { "api": 2 }` and a peer range on `@clockgrove/assetgrove`. It declares, as extension `tiles`, the kind `tiles:terrain` with its operations `tiles:atlas` and `tiles:seams` and its three checks.

## Install

Install it beside core and list it in the developer settings:

```json
{ "extensions": ["@clockgrove/assetgrove-tiles"] }
```

## The `tiles:terrain` kind

A set is one atlas asset: an image whose `output.fields` are `{ layout, tileSize, terrains }`, with `layout` `corner-16`. The spec names the two terrains as `fields.terrains`, `lower` and `upper`:

```json
{
  "kind": "tiles:terrain",
  "assetId": "grass-dirt",
  "fields": { "terrains": { "lower": "dirt", "upper": "grass" } }
}
```

The target profile carries a `kinds["tiles:terrain"]` block:

```json
{
  "kinds": {
    "tiles:terrain": {
      "tileSize": 16,
      "layout": { "media": "assets/tiles/{{spec.assetId}}.{{output.extension}}" }
    }
  }
}
```

- `tileSize`: whole pixels, the side of one square tile. The atlas is `4 * tileSize` square.
- `layout`: optional, as for any kind (`kinds.<kind>.layout`).

A profile without the block, or a spec without both terrains, is refused at plan: exit 2 `invalid_input`.

## The corner-16 cell table

A corner-16 set has 16 tiles on a fixed 4 × 4 grid. Each tile gives a label to each of its four corners: `L`, the lower terrain, or `U`, the upper. Tile `i` has corner bits NW = 1, NE = 2, SW = 4, SE = 8, set for `U`. It sits at column `i % 4` and row `floor(i / 4)`, origin top-left. So tile 5 is NW `U`, NE `L`, SW `U`, SE `L`, and tile 15 is `UUUU`.

| Tile | Column | Row | NW  | NE  | SW  | SE  |
| ---: | -----: | --: | --- | --- | --- | --- |
|    0 |      0 |   0 | L   | L   | L   | L   |
|    1 |      1 |   0 | U   | L   | L   | L   |
|    2 |      2 |   0 | L   | U   | L   | L   |
|    3 |      3 |   0 | U   | U   | L   | L   |
|    4 |      0 |   1 | L   | L   | U   | L   |
|    5 |      1 |   1 | U   | L   | U   | L   |
|    6 |      2 |   1 | L   | U   | U   | L   |
|    7 |      3 |   1 | U   | U   | U   | L   |
|    8 |      0 |   2 | L   | L   | L   | U   |
|    9 |      1 |   2 | U   | L   | L   | U   |
|   10 |      2 |   2 | L   | U   | L   | U   |
|   11 |      3 |   2 | U   | U   | L   | U   |
|   12 |      0 |   3 | L   | L   | U   | U   |
|   13 |      1 |   3 | U   | L   | U   | U   |
|   14 |      2 |   3 | L   | U   | U   | U   |
|   15 |      3 |   3 | U   | U   | U   | U   |

The atlas, each cell as its index and its corners NW NE / SW SE:

```text
      col 0     col 1     col 2     col 3
row 0   0 LL/LL   1 UL/LL   2 LU/LL   3 UU/LL
row 1   4 LL/UL   5 UL/UL   6 LU/UL   7 UU/UL
row 2   8 LL/LU   9 UL/LU  10 LU/LU  11 UU/LU
row 3  12 LL/UU  13 UL/UU  14 LU/UU  15 UU/UU
```

The pack exports `cornersOf(index)`, `CORNER16_TABLE` and `cellBox(index, tileSize)`, which this table is computed from.

## Generation

One `tiles:atlas` call (role `image`) with a template reference: the table above drawn in flat dark grey `#404040` for the lower terrain and light grey `#c0c0c0` for the upper. The prompt names both terrains and the profile's palette. The image is scaled to fit `4 * tileSize` square, centred, and the profile's alpha and colour rule are applied.

## Checks

| Check                    | Mode  | Judges                                                 |
| ------------------------ | ----- | ------------------------------------------------------ |
| `tiles:grid`             | exact | The atlas is 4 × 4 tiles of `tileSize`, no cell empty. |
| `tiles:class-uniformity` | exact | Tiles sharing a side's corner labels share that edge.  |
| `tiles:seam-quality`     | model | The seams look continuous and the pure tiles wrap.     |

### `tiles:grid`

Exact, free, and it filters. The atlas must be exactly `4 * tileSize` square, and no cell may be empty. A cell is empty when no pixel has alpha at or above the profile's alpha threshold. Reasons:

- a wrong size: `the atlas is 60 × 60, not 64 × 64 (4 × 4 tiles of 16px)`;
- an empty cell, one reason each: `tile 5 (column 1, row 1) is empty: no pixel at alpha 1 or above`;
- passing: `the atlas is 4 × 4 tiles of 16px (64 × 64), no cell empty`.

### `tiles:class-uniformity`

Exact, free, and it filters. Tiles that meet along the same kind of edge must have the same edge, or the set shows seams when placed. A class is a side and the corner-label pair along it, read along the side: north NW NE, south SW SE, west NW SW, east NE SE. Tiles 1, 5, 9 and 13 are the class (north, `UL`).

The outermost 1-px strip of each tile on a side is compared byte-exact as RGBA with the others of its class. The strip most of the class shares wins; on a tie the strip held by the lowest index wins. Each tile off the winning strip fails, naming the tile, the side and the class: `tile 5 (column 1, row 1): its north strip differs from its class (north, UL) in 3 px`.

It applies only when the profile's resolved colour rule is `palette`, since only then are colours exact. Otherwise it passes with a reason starting `skipped:` that says why. On an atlas of the wrong size it also passes as `skipped:`, because `tiles:grid` reports that.

Whether this check filters well on real routes is for a later pixel-art spike to decide. Here it is proven on the scripted provider.

### `tiles:seam-quality`

A model check, advisory. One boolean decision (operation `tiles:seams`, role `decisions`) over two images: the atlas, and a wrap preview of the two pure tiles (0, all lower; 15, all upper) each repeated 2 × 2. The pack ships no stability entry, so its reasons are advisory (`shadow`) and never filter, until a measured stability entry qualifies it ([QA checks](../../docs/extensions.md#qa-checks)).

## Changing one tile

Mark the tile's cell with `request-change` (`cellBox(index, tileSize)`: `x = column * tileSize`, `y = row * tileSize`, `w = h = tileSize`). Tile 5 at `tileSize` 16 is `16,16,16,16`:

```sh
assetgrove request-change <address> --region "16,16,16,16 : the dirt looks too green at the corners"
```

The edit runs the kind's exact checks, and a failing edit is filtered.

## Routing

Settings `routes["tiles:atlas"]` and `routes["tiles:seams"]` choose the route. Without them the roles `image` and `decisions` do.

## Limits

The corner-16 layout only. Two terrains per set. Square tiles. Other layouts and sets of more than two terrains are not made by this pack.

## Development

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
```

The tests use the scripted provider and never call a model.
