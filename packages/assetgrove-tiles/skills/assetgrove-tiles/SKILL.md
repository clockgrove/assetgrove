---
name: assetgrove-tiles
description: Load when an Assetgrove project makes a corner-16 terrain tile set, one atlas between two terrains that must tile seamlessly. Needs the optional @clockgrove/assetgrove-tiles package listed in the developer settings; covers the tiles:terrain kind, its profile block, the corner-16 cell table, the tiles:grid, tiles:class-uniformity and tiles:seam-quality checks, changing one tile and its limits.
---

# Assetgrove for tiles

`@clockgrove/assetgrove-tiles` is a pack: it loads only once a person lists it under `extensions` in the developer settings. It adds the kind `tiles:terrain`: a corner-16 terrain tile set between two terrains, as one atlas image.

## Set it up

- Install it beside core and list `@clockgrove/assetgrove-tiles` in `extensions`.
- Add `kinds["tiles:terrain"]` to the target profile. `tileSize` is the side of one square tile in whole pixels; the atlas is `4 * tileSize` square. `layout` is optional (`kinds.<kind>.layout`).

```json
{ "kinds": { "tiles:terrain": { "tileSize": 16 } } }
```

A profile without the block exits 2 `invalid_input` at plan, as does a spec without both terrains.

## Make a set

Name the two terrains in the spec, `lower` and `upper`:

```json
{
  "kind": "tiles:terrain",
  "assetId": "grass-dirt",
  "fields": { "terrains": { "lower": "dirt", "upper": "grass" } }
}
```

Then `assetgrove stage --spec <spec.json> --bible <BIBLE.md> --profile <profile.json>`; add `--dry-run` for the forecast. The output is one image whose `output.fields` are `{ layout, tileSize, terrains }`, with `layout` `corner-16`. The pack generates with one `tiles:atlas` call (role `image`) given a template reference: the cell table drawn in dark grey `#404040` for the lower terrain and light grey `#c0c0c0` for the upper. It scales the image to fit `4 * tileSize` square, centred, and applies the profile's alpha and colour rule. Routes: settings `routes["tiles:atlas"]` and `routes["tiles:seams"]`, else roles `image` and `decisions`.

## The corner-16 cell table

16 tiles on a fixed 4 × 4 grid. Each tile labels its four corners `L` (lower terrain) or `U` (upper). Tile `i` has corner bits NW = 1, NE = 2, SW = 4, SE = 8, set for `U`, and sits at column `i % 4`, row `floor(i / 4)`, origin top-left. Tile 5 is NW `U`, NE `L`, SW `U`, SE `L`; tile 15 is `UUUU`.

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

Each cell as its index and corners NW NE / SW SE:

```text
      col 0     col 1     col 2     col 3
row 0   0 LL/LL   1 UL/LL   2 LU/LL   3 UU/LL
row 1   4 LL/UL   5 UL/UL   6 LU/UL   7 UU/UL
row 2   8 LL/LU   9 UL/LU  10 LU/LU  11 UU/LU
row 3  12 LL/UU  13 UL/UU  14 LU/UU  15 UU/UU
```

## Read the checks

- `tiles:grid` is exact, free and filters. The atlas must be exactly `4 * tileSize` square, and no cell may be empty (no pixel at or above the profile's alpha threshold). It gives one reason per empty cell, naming it (`tile 5 (column 1, row 1) is empty: ...`), or one for a wrong size. Do not retry the same image.
- `tiles:class-uniformity` is exact, free and filters. A class is a side and the corner-label pair along it, read along the side: north NW NE, south SW SE, west NW SW, east NE SE. The outermost 1-px strip of each tile is compared byte-exact as RGBA within its class; the strip most of the class shares wins, ties to the lowest index. A failing reason names the tile and the side. It applies only when the profile's resolved colour rule is `palette`; otherwise it passes with a reason starting `skipped:` that says why. On an atlas of the wrong size it is skipped too, as `tiles:grid` reports it. Whether it filters well on real routes is for a later pixel-art spike to decide.
- `tiles:seam-quality` asks a model one boolean question (operation `tiles:seams`, role `decisions`) over the atlas and a wrap preview of the two pure tiles (0 and 15) repeated 2 × 2. It is advisory (`shadow`) and never filters, as the pack ships no stability entry. Treat its reasons as a prompt for a person.

## Change one tile

Mark the tile's cell with `request-change`: `x = column * tileSize`, `y = row * tileSize`, `w = h = tileSize` (`cellBox(index, tileSize)`). Tile 5 at `tileSize` 16 is `16,16,16,16`:

```sh
assetgrove request-change <address> --region "16,16,16,16 : the dirt looks too green at the corners"
```

The edit runs the kind's exact checks, and a failing edit is filtered.

## Limits

The corner-16 layout only. Two terrains per set. Square tiles.
