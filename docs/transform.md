# Media transformation (images and audio)

The transformation core runs deterministic image operations on any image, and audio operations on any PCM WAV ([below](#audio)): generated, imported or hand-made. Operations chain into recipes, which are declared as data. Engines sit behind one adapter, and every operation records one provenance step. The sheet import ([sheet-import.md](sheet-import.md)) is built on it.

## Commands

```sh
# One operation. With --profile, the target profile's style and frame size supply the defaults.
pnpm assetgrove op matte hand-painted.png --out clean.png
pnpm assetgrove op trim clean.png --out trimmed.png --params '{"margin": 2}' --profile profile.json

# A recipe file.
pnpm assetgrove recipe sheet-to-renditions.json sheet.png --out out/ --profile profile.json

# Every operation, its parameter schema, and the engines that implement it.
pnpm assetgrove ops --json
```

All three follow the CLI contract: `--json` prints one JSON document, nothing prompts, and invalid input exits 2. A single output goes to `--out` when that path has an extension. Its extension must match the output's format (`.png` for PNG, `.webp` after `convert` to WebP); a mismatch is refused before anything is written. An input keeps its media type when an engine can encode it; a JPEG input is written as PNG unless a `convert` step says otherwise. Otherwise `--out` is a directory, and each output is written there as `<name>.<extension>`. The provenance record goes beside the output, as `<out>.provenance.json` or `<dir>/provenance.json`. An input file is never overwritten.

Outputs are named after the source file. `slice` adds `-f001`, `-f002` and so on, `renditions` adds `@1x` and `@2x`, and `join` adds `-strip` or `-sheet`.

## Operations

| Operation     | Scope | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crop`        | each  | Cuts out `x`, `y`, `width`, `height`. A box outside the image is refused.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `trim`        | each  | Cuts to the box of pixels whose alpha is at or above `threshold` (default: the style profile's threshold), keeping `margin` px.                                                                                                                                                                                                                                                                                                                                                               |
| `pad`         | each  | Adds transparent `top`, `right`, `bottom` and `left` px.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `scale`       | each  | Resamples by exactly one of `factor`, `width` or `height` (the aspect is kept). `filter` defaults to the style's edges: `crisp` (nearest neighbour) or `antialiased` (premultiplied).                                                                                                                                                                                                                                                                                                         |
| `slice`       | each  | Splits a sheet into figures, dropping labels, specks and background. Takes `grid`, `components`, `tolerance`, `labelFraction` and `padding`, as the sheet import does.                                                                                                                                                                                                                                                                                                                        |
| `matte`       | each  | Removes the background to the style profile, unmixing a soft edge band and removing halo and fringe. It runs the halo and leftover-background checks (`maxHaloFraction`). A sliced figure is matted with its slice mask and cell background, and the step's `report.figure` records their hash. Any other image (not sliced, or changed since) is matted whole: every pixel farther than `sliceTolerance` from its border colour is kept, so no small or detached part is dropped as a label. |
| `apply-style` | each  | Re-applies the style's binary alpha and palette snap, and clears the colour of transparent pixels.                                                                                                                                                                                                                                                                                                                                                                                            |
| `register`    | all   | Puts every image into one `frame` size (default: the profile's frames), with its feet baseline and its pin point on `anchor` (default: the bottom centre) at one common scale. `pins` gives one pin per image: `center` (the centre of mass, the default) or `footprint` (the centre of the pixels in the bottom 10% of the figure's height). `families` normalises scale within each family. The jitter is measured at each image's pin and recorded per image.                              |
| `join`        | all   | Assembles the images left to right into `columns` columns (default: one row, a strip). Cells are the size of the largest image, and images sit top-left in them.                                                                                                                                                                                                                                                                                                                              |
| `flip`        | each  | Mirrors each image: `direction` is `horizontal` (left and right) or `vertical`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `renditions`  | each  | Makes one copy per entry in `scales` (default `[1, 2]`). The input is treated as 1x.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `convert`     | each  | Sets the format an image is written in, by extension or media type. The engine decides which formats exist. The in-house engine encodes PNG and lossless WebP.                                                                                                                                                                                                                                                                                                                                |

`assetgrove ops --json` lists each operation's parameter schema. The schemas use a small JSON Schema subset: types, `enum`, bounds, `required` and `default`. Unknown parameters are refused.

## Audio

The audio engine, `assetgrove-audio` (`src/audio/engine.ts`), sits beside the raster engine ([PRD-audio.md](PRD-audio.md), core changes 2 and 3). It reads and writes PCM WAV through `wavefile`: 8, 16, 24 or 32-bit integer, or 32 or 64-bit float. Compressed WAV is refused. Samples are held as 64-bit floats from −1 to 1, scaled from the file's integers by a power of two, so a file written back at its own bit depth keeps its samples to the bit. An output keeps its source's sample rate and bit depth unless an operation changes them, and it is written with only its `fmt ` and `data` chunks, plus the AI mark when a digital source type is declared.

`op` and `recipe` take WAV inputs the same way as images. All inputs of one run are WAV, or none are. Audio and image operations share the recipe format and the schema subset. An operation that doesn't fit the input's media is refused when it runs.

```sh
pnpm assetgrove op gain take.wav --out take-gained.wav \
  --params '{"target": -23, "truePeakCeiling": -1, "encoderHeadroom": 1}'
pnpm assetgrove op loop take.wav --out loop.wav \
  --params '{"bars": 4, "beatsPerBar": 4, "bpm": 140, "crossfadeMs": 50, "curve": "equal-gain"}'
```

| Operation      | Scope | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trim-silence` | each  | Cuts leading and trailing silence, frames whose loudest channel is below `floorDb` (default −60 dBFS), keeping `marginMs` (default 10). An all-silent file is refused.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `fade`         | each  | Fades in over `inMs` and out over `outMs` (each 10 by default), linearly, so the first and last frames are silent. Fades longer than the file are refused.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `gain`         | each  | Gains the file to `target` LUFS, measured as `measure` says: `integrated` (default) or `momentary`, the maximum momentary loudness, for an `sfx`. Gain only, no limiter: when the target would put true peak above `truePeakCeiling` minus `encoderHeadroom`, it refuses, naming both numbers. A file whose loudness isn't defined (silence, or shorter than 400 ms) is refused.                                                                                                                                                                                                                      |
| `mono`         | each  | Folds to one channel, the mean of the channels. A mono file is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `resample`     | each  | Changes the sample rate to `sampleRate` with libsamplerate (`@alexanderolsen/libsamplerate-js`, WebAssembly). `converter` is `sinc-best` (default), `sinc-medium` or `sinc-fastest`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `encode`       | each  | Writes an Ogg Vorbis rendition at `quality`, libvorbis' VBR quality from −1 to 10 (default 5), through `@audio/encode-ogg`, libvorbis compiled to WebAssembly with no LGPL code. It is the last step of a rendition recipe: any step after it is refused, and so is a sound with more than two channels. The output is a `.ogg`, its AI mark in Vorbis comments. The step's report and the output's `encodedBy` record the encoder's package, version, libvorbis vendor string and licence. The stream serial number comes from the sample hash, so the same samples and quality give the same bytes. |
| `loop`         | each  | Makes a seamless loop from a file generated with an overhang. The loop length is `floor(bars × beatsPerBar × 60 / bpm × sampleRate)` frames, Godot's, or `floor(seconds × sampleRate)` for ambience. It cuts there and folds the overhang into the head over `crossfadeMs`, with `curve` `equal-gain` (music) or `equal-power` (ambience). An overhang shorter than the crossfade is refused. The step's report and the output's `meta.loop` record the residual fraction of a frame.                                                                                                                 |

**Loudness and true peak** (`src/audio/loudness.ts`) come from the `@audio/loudness` family: integrated loudness from `@audio/loudness-lufs` (ITU-R BS.1770-4, gated), true peak from `@audio/loudness-truepeak` (4× oversampled), and maximum momentary loudness, the loudest ungated 400 ms window at 100 ms steps, over the same K-weighting (`@audio/weighting-k`) and channel weights. `test/audio-loudness.test.ts` runs the EBU Tech 3341 test vectors with their published tolerances.

**Provenance.** Audio steps are recorded like image steps, chained by sample hashes instead of pixel hashes. A sample hash is the SHA-256 of `pcm <bitDepth> <channels>x<sampleRate>\n` followed by the interleaved little-endian samples at the bit depth, as the `data` chunk holds them. Other chunks, such as the AI mark, loop points or Content Credentials, never change it. Sources and outputs record `samples` (the sample hash) in place of `pixels`, and outputs record sample rate, channels, frames and bit depth in place of a size.

## Recipes

```json
{
  "format": "assetgrove-recipe/1",
  "name": "sheet-to-renditions",
  "steps": [
    { "op": "slice" },
    { "op": "matte" },
    { "op": "register", "params": { "frame": { "width": 64, "height": 64 } } },
    { "op": "trim" },
    { "op": "pad", "params": { "top": 2, "right": 2, "bottom": 2, "left": 2 } },
    { "op": "scale", "params": { "factor": 0.5 } },
    { "op": "renditions", "params": { "scales": [1, 2] } },
    { "op": "convert", "params": { "format": "webp" } }
  ]
}
```

Recipes are JSON. Every step is checked against its operation's schema before anything runs. A step may name an `engine`. Without one, the first engine that implements the operation runs it.

Recipes are deterministic. The same input, recipe and engine versions give the same output bytes. Nothing reads a clock or a random source, and the provenance record holds no time.

## Named renditions from a mezzanine version

Keep project recipes as existing `assetgrove-recipe/1` files in a directory, for example
`.assetgrove/recipes/icon.json`. Select the recipe by its file stem and pin the mezzanine by its
full SHA-256, rather than relying on whichever bytes happen to occupy the source path:

```sh
pnpm assetgrove rendition --recipes .assetgrove/recipes --recipe icon \
  --source mezzanine/hero.png --source-sha256 <64-hex-sha256> --out build/icons \
  --preview --json
```

Remove `--preview` to write the rendition. The MCP tool `rendition` accepts the same inputs as
`recipes`, `recipe`, `source`, `sourceSha256`, `out` and `preview`. Both previews run the local
image transform in memory and report exact output paths, byte hashes and the provenance path
without creating output files or directories. No provider call or external tool runs.

The output directory is `<out>/<digest>/`, with images named `rendition` plus any operation
suffixes and the matching format extension, and a `provenance.json` record. An explicit `join`
name is retained; unsafe names and colliding output paths are refused before writes. The digest identifies
the exact mezzanine bytes, resolved recipe parameters, decoder and encoder versions, operation
and metadata engine versions, resolved style and disclosure. An identical build reproduces the
same output bytes and paths. A source, resolved parameter or tool-version change selects another
directory, even when the resulting pixels happen to be identical. Recipe JSON formatting and
object key order do not affect this identity.

The record's `sources` and `outputs` retain the exact mezzanine and rendition byte hashes.
`rendition` adds the digest, selected recipe name, recipe file path and byte hash, resolved recipe
and build inputs. The optional `--source-provenance` record, or an automatically discovered
`<source>.provenance.json`, is retained under `sourceProvenance` with its own file hash; it must
identify the selected source bytes. Use the explicit option when the source record has another
name, such as a transform directory's `provenance.json`.

Embedded Digital Source Type survives the transform. An undeclared source needs an explicit
`--digital-source-type` to plan or write a rendition with its final disclosure. `--profile` supplies the same style and
frame defaults as `recipe`. A WAV master takes a recipe of audio operations instead, and an image source takes only raster
ones; a mismatch is refused, naming the step.

**Ogg Vorbis renditions.** A recipe ending in `encode` turns a WAV master into an Ogg Vorbis
rendition, for a target that asks for one:

```json
{
  "format": "assetgrove-recipe/1",
  "steps": [{ "op": "encode", "params": { "quality": 6 } }]
}
```

The rendition records the master's SHA-256 (`build.sourceSha256`), its own byte hash
(`outputs[].sha256`) and the recipe with its resolved settings and the engine and encoder
versions (`build.recipe`, `build.encoders`). These make the digest, so a changed master or recipe
gives a new rendition, built afresh. An Ogg carries the AI mark as Vorbis comments
(`DIGITALSOURCETYPE`, `AISYSTEMUSED`, `ASSETGROVE_CALLSSHA256`) and its C2PA content credentials
as a sidecar, `<stem>.c2pa` beside it ([disclosure.md](disclosure.md#content-credentials)). The
output's `contentCredentials` names the sidecar, its sha256 and the signer. The signer is the
developer settings' `contentCredentials`, or else the development certificate. A rebuild keeps a
sidecar that still holds for the same bytes and certificate, so an unchanged rendition keeps every
byte.

This workflow accepts deterministic raster and audio operations; material,
model-assisted and external-tool operations remain available through their existing commands.
It writes build files only and does not select, approve or add a library version.

## Delivery sets from exact library versions

A selection file names the asset versions to deliver and the project recipe for each:

```json
{
  "format": "assetgrove-delivery/1",
  "recipes": "recipes",
  "items": [
    {
      "asset": "../target/assets/lantern.md",
      "version": 1,
      "recipe": "icon",
      "to": "icons",
      "name": "lantern"
    }
  ]
}
```

`recipes` and each `asset` (a card) are paths relative to the selection file. `version` is a stack
number or a sha256, `recipe` a recipe file stem, and `to` a relative folder under the delivery
root (`.` for the root itself). `name` and `digitalSourceType` are optional.

A version's bytes are the library media file when it is that version, or its object in the local
`.git/lfs/objects` store. They are never fetched and Git is not run.

```sh
pnpm assetgrove deliver --selection delivery.json --out build/delivery --preview --json
```

The dry run resolves every item's mezzanine hash and destination path and writes nothing, not
even the output directory. The MCP tool `deliver` takes `selection`, `out`, `profile` and
`preview`. Problems are reported for all items at once, with exit 2: `asset_missing`,
`version_missing`, `object_missing`, `recipe_missing`, `item_invalid` and `output_collision`.
Without `--preview`, a delivery with any problem writes nothing; otherwise it writes every output
and then `delivery.json`.

`delivery.json` has the format `assetgrove-delivery-manifest/1` and, per item, the asset id,
version, mezzanine sha256, recipe name and sha256, rendition digest, build and outputs with path,
sha256, media type and size. It records only what the selection resolves to, never how the
selection file is written, and holds no time and no path outside the delivery, so the same versions
and recipes give the same files whether a version is named by stack number or sha256 and whether a
card path is relative or absolute. An existing file with identical bytes is accepted; one
with different bytes, or a path used twice, is an `output_collision`.

Delivery only reads the library. It never adds a version or changes the current pick.

### The release gate

A delivery without `--preview` or `--draft` is a release delivery, and it refuses, writing
nothing, an item whose selected version fails a release check. Every item whose version resolves
is checked, and the result's `policy` lists each check with its status (`passed` or `failed`), the
asset id, version number and sha256, a message and its `evidence`:

| Check            | Applies                                             | Fails when                                                                                                                                         | Problem code           | Evidence                                                                                                                                                                                                           |
| ---------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `placeholder`    | always                                              | a person marked the selected version as a placeholder (`review --placeholder`, [library.md](library.md#review-actions))                            | `placeholder_selected` | `marks`: each marking annotation's id and time                                                                                                                                                                     |
| `approval`       | the `--profile`'s `release.requireApproval` is true | the version's status ([library.md](library.md#review-records)) is not `approved`                                                                   | `version_unapproved`   | `state`, and the latest `assessing` annotation's id, action and time when there is one                                                                                                                             |
| `license-window` | the `--profile` lists `release.licenseWindows`      | the card has no `license`, its `license` is not an SPDX expression, or the expression fails on the delivery date in `release.timeZone` (see below) | `license_window`       | the card's `license`, the zone and the date, the windows that apply and the ones it is outside, the licence ids no window names, the `OR` alternatives that passed, or the parse error or "no licence on the card" |

A mark is on one exact version, so selecting another version clears the placeholder failure.

The licence-window check parses the card's `license` with `spdx-expression-parse` and fails
closed. A licence id passes when every window naming it holds on the delivery date: the calendar
date in `release.timeZone` at delivery time, with both ends of a window inclusive. A licence id no
window names has no window that applies, so it passes, and the evidence lists it. An `AND` needs
every component to pass; an `OR` passes when at least one alternative passes, and the evidence
names the alternative that passed. A card with no `license` is refused with the evidence "no
licence on the card", and an expression that does not parse is refused with the parse error. The gate only reads approvals a person recorded; it never approves
anything.

`--preview` and `--draft` report the same `policy` findings but never refuse on them (the other
problems still refuse). Neither is a release: the result's `release` is true only for a release
delivery that passed and was written. A draft writes the delivery like a release does, and its
`delivery.json` carries `"draft": true`; a release manifest has no `draft` member, so it is
unchanged. The human output ends with the verdict: `release delivery: every release check passed`,
or, for a preview or a draft, `not a release` with each failed check.

## Provenance

The record (`generator: "transform"`) lists:

- `sources`: each input's path, file SHA-256, media type, pixel hash and the engine that decoded it (`decodedBy`);
- `style`: the style the operations followed;
- `steps`: one per operation, holding `op`, `params` with defaults filled in, `engine` (`name` and `version`), and the `inputs` and `outputs` pixel hashes. Some steps add a `report`, such as a slice's grid or the common registration scale;
- `outputs`: each file's path, SHA-256, media type, size, pixel hash, the engine whose encoder wrote its bytes (`encodedBy`) and what the operations measured (matte checks, jitter).

A pixel hash is the SHA-256 of `rgba8 <width>x<height>\n` followed by the RGBA bytes. Steps are chained by pixel hashes, so no intermediate image has to be encoded.

Strips written by the sheet import carry the same `steps` in their provenance: the import's `slice` and `matte`, then the write's `flip` (a mirrored family's own flip only), `register`, `apply-style` and `join`. It is an optional field in the provenance each strip's manifest receives in the target.

## Digital Source Type disclosure

Assets with a known source type carry `digitalSourceType` in provenance and the same full URI in XMP's `Iptc4xmpExt:DigitalSourceType` property. An asset whose source type is unknown carries `undeclared` in provenance and no IPTC Digital Source Type value in XMP. The [IPTC Digital Source Type vocabulary](https://cv.iptc.org/newscodes/digitalsourcetype/) supplies the codes:

| Origin and transform history                                                                    | URI                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Model-generated media, including deterministic processing of generated pixels                   | `http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia`              |
| Model edits of human-made media, or a composite combining human-made and model-generated pixels | `http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia` |
| Explicitly declared hand-made digital media with deterministic transforms only                  | `http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation`                      |

Recorded generation calls establish `trainedAlgorithmicMedia` automatically; model edits of human-made media and composites combining human-made and generated pixels use `compositeWithTrainedAlgorithmicMedia`. Deterministic operations preserve an input's known disclosure: cropping, resizing or converting an already generated image does not make it human-made. References that guide generation without contributing human-made pixels do not by themselves make the result a composite.

Never infer `digitalCreation` from an untagged file or a free-text tool label. Use `--digital-source-type <code>` to declare a source type explicitly; the code or full HTTP URI is validated against the IPTC vocabulary, and provenance records the declaration together with who declared it. Without a known disclosure, a recorded generation call or an explicit declaration, provenance records `undeclared` and the file receives no IPTC Digital Source Type value in XMP. Local staging and previews still work. Publishing or exporting, including writes into a target, handoffs and packages, refuses an undeclared asset with a message naming `--digital-source-type`.

PNG stores an uncompressed XMP packet in an `iTXt` chunk whose keyword is `XML:com.adobe.xmp`. WebP stores it in the standard `XMP ` RIFF chunk. The metadata writer uses the IPTC extension namespace `http://iptc.org/std/Iptc4xmpExt/2008-02-29/`. Writing the disclosure is recorded as an `embed-digital-source-type` provenance step. Its input and output pixel hashes are identical, and the packet contains no timestamp or random identifier, preserving deterministic output bytes.

Bounds, dimensions and transformation content identity come from decoded RGBA pixels. The `pixels` hash described above excludes container metadata, so adding XMP leaves that identity unchanged. File `sha256` values deliberately hash the complete written file, including XMP; manifest file hashes are calculated after embedding, so they still verify the bytes delivered to a target.

The target profile's validator command runs on the final tagged media and manifest. Lasting synthetic target-validator tests exercise that integration boundary in this repository. The target repository owns its actual validator, selected through profile data without game-specific checks in Assetgrove.

The metadata adapter also supports JSON glTF through [Khronos `KHR_xmp_json_ld`](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_xmp_json_ld), with the Digital Source Type URI in a document-level XMP packet. KTX2 outputs retain disclosure in their provenance sidecars.

### Signed Content Credentials

Digital Source Type is an unsigned disclosure. Hand-off adds a signed C2PA manifest to every PNG, JPEG and WebP it writes ([disclosure.md](disclosure.md#content-credentials)); transformation steps themselves do not sign. glTF, GLB and KTX2 keep the XMP mark only.

## Engines

An engine adapter (`ImageEngine` in `src/transform/types.ts`) has a name, a version, the operations it implements, its encoders by media type, and a decoder. The in-house engine, `assetgrove-raster`, is Assetgrove's own TypeScript raster code. It decodes PNG and JPEG, and encodes PNG and lossless WebP (VP8L). Its version is bumped whenever any operation's output bytes change.

Another engine, such as sharp/libvips, ImageMagick or a model-based matte, implements some of the same operations and is passed to the runner ahead of the in-house engine, or named by a step. Recipes don't change. Material derivation, native rendition and KTX2 encoding operations are registered by the material-maps runner, with schemas and per-step provenance; see [materials.md](materials.md).

## Programmatic use

`runOperation`, `runRecipe`, `parseRecipe` and `transformFiles` in `src/transform/run.ts` are the entry points; `runAudioRecipe` and `transformAudioFiles` in `src/audio/run.ts` are their audio counterparts. The CLI and the MCP tools `op`, `recipe` and `ops` call them.
