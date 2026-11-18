# Extensions

An extension adds asset kinds, engine presets and provider adapters. Core registers through the same contract (`src/extensions/core.ts`): kinds `still`, `sprite-strip` and `character-3d`; presets `manifest`, `atlas-json` and `aseprite-json`; adapters `vercel-ai-gateway`, `anthropic`, `openai`, `openai-compatible`, `tripo` and `scripted`.

## Contract

An extension is called a pack. The contract is api 2. `@clockgrove/assetgrove/extension` (`dist/extension/api.js`, `api.d.ts`) exports `EXTENSION_API` (2), `EXTENSION_APIS` (`[2]`, every api this core loads), zod's `z`, and every type a pack needs: the ones below, every provider request and result type (`ImageRequest`, `ImageResult`, `VisionRequest`, `VisionResult`, `DecisionRequest`, `DecisionResult`, `EmbedRequest`, `EmbedResult`, `ModelRequest`, `ModelResult`, `RigRequest`, `AnimateRequest`, ...), `Billing`, `GenerationProvider`, `Caller`, `Raster`, `AssetSpec`, `StyleBible`, `TargetProfile`, `MediaOutput`, `FramesTrait`, `FrameLayout`, `Reason`, `QaResult` and the search slot's types. A pack imports nothing of core by path.

| Type               | Shape                                                                                                                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Extension`        | `{ api: 2, name, kinds?, presets?, adapters?, search? }`                                                                                                                                                                                                                                                              |
| `ExtensionContext` | `{ api: 2, z, raster, qa, prompt, http, run, log }` ([below](#the-context)).                                                                                                                                                                                                                                          |
| `AssetKind`        | `kind`, `planCandidate(spec, profile, routes)`, `generate(ctx)`, `checks?` ([QA checks](#qa-checks)), `operations?` ([operations and roles](#operations-and-roles)), `specSchema?` and `profileSchema?` ([schemas](#spec-and-profile-schemas)), `frames?` ([frames](#frames)).                                        |
| `EnginePreset`     | `name`, zod `optionsSchema`, `write(ctx, options)`, `check(ctx, options, files, read)`.                                                                                                                                                                                                                               |
| `ProviderAdapter`  | `id`, `capabilities` (`embed` means images and text in one space), `defaultKeyEnv?`, `fixedHosts`, `endpointFromSettings`, `defaultRoutes?` (by operation), `parameters?` (the [typed call parameters](#typed-call-parameters) it maps), `create(c)` returning a generation provider; `c.fetch` is the guarded fetch. |

A pack's package.json declares the contract it speaks and the core releases it was built for:

```json
{
  "assetgrove": { "api": 2, "entry": "./dist/index.js" },
  "peerDependencies": { "@clockgrove/assetgrove": "^0.2.0" }
}
```

The entry's default export is an `Extension`, or a function `(context) => Extension | Promise<Extension>`. Runtime helpers come through the context.

Every extension name matches `^[a-z][a-z0-9-]*$` and is not `core`. Each kind, preset and adapter id is `<name>:<id>`.

## The context

`ExtensionContext` gives a pack core's own code, so it copies none of it:

| Field    | What                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `z`      | The zod core validates preset options with.                                                                                                                                                                                                                                                                                                                                   |
| `raster` | Core's raster functions over an RGBA `Raster`: `decode` (any format core reads), `decodePng`, `encodePng`, `create`, `getPixel`, `setPixel`, `crop`, `bounds`, `opaqueBox`, `scale`, `flipHorizontal`, `parseHex`, `toHex`, `palette` (a bible's), `paletteSwatch`, `resolveStyle`, `applyStyle` (palette snap and alpha rule), `grid` (frames side by side) and `frameGrid`. |
| `qa`     | Core's deterministic checks: `deterministicChecks(strip, expectation)` (frame size and count, transparency, palette), `isCutOut`, `combine`.                                                                                                                                                                                                                                  |
| `prompt` | The bible-to-prompt compiler core's kinds send: `still`, `frame`, `styleNotes`, `subjectOf`, `withNote`.                                                                                                                                                                                                                                                                      |
| `http`   | `http(adapter, { baseURL? })`: the guarded `fetch` for one provider instance ([below](#http)).                                                                                                                                                                                                                                                                                |
| `run`    | `run.current()`: the paid run a call is made in (`{ cleared, id?, dir? }`), or undefined outside one.                                                                                                                                                                                                                                                                         |
| `log`    | `log(message)`: one line to stderr, prefixed with the pack's package name.                                                                                                                                                                                                                                                                                                    |

## http

An adapter's `create(c)` gets `c.fetch`, and `context.http(adapter, c)` builds the same: a `fetch` that refuses any host outside the adapter's `fixedHosts` and, when `endpointFromSettings`, the host of the settings entry's `baseURL`. It follows redirects itself and checks each hop's host before requesting it, so a redirect to an undeclared host is refused and never requested; credentials are dropped when a hop changes host. A refused request fails with exit 4 `provider_error` (provider code `host_refused`), naming the adapter, the host and the hop.

It guards provider-steered URLs (a download link in a result, a redirect), not pack code: a pack is code and can still reach the global `fetch`. So a pack's SDK must take the injected `fetch` (`new SomeSdk({ fetch: c.fetch })`). An SDK that cannot is a recorded exception in [decisions.md](decisions.md#a-packs-network-goes-through-the-injected-fetch-414).

## QA checks

A kind may declare `checks: [{ name, mode, run(input, call) }]`, where `input` is `{ spec, profile, bible, output }` and `run` returns reasons. Core runs them on each candidate after `generate` and adds their reasons to its QA. `mode: "exact"` is a deterministic, free check: core runs it under a `Caller` that refuses every call (exit 2 `invalid_input` if it tries). `mode: "judged"` may call a model through the candidate's `Caller`; list its calls in `planCandidate`.

## Operations and roles

A kind declares the operations it calls as `operations: { "<op>": "<role>" }`, each role taken from core's role table (`image`, `edit`, `vision`, `decisions`, `planning`, `model3d`, `rig3d`, `clips3d`, `embeddings`; [settings.md](settings.md#roles-and-routes)). A pack's operations are named `<pack>:<op>`, for example `"pixel:still": "image"`. Core's kinds declare core operations through the same field: `still` declares `still`, `cutout` and `vision`, and `sprite-strip` declares `edit`, `cutout` and `vision`. `character-3d` declares its 3D, facing, identity, clip-map and reference-view operations.

Core resolves a kind's operation like its own, with the capability check: `routes.<op>`, then `roles.<role>`, then the default route of the role's core operation (`still` for `image`). So a settings route for `pixel:still` sends that operation to its provider while core's `still` stays where the developer put it. The kind reads it as `routes["pixel:still"]` in `planCandidate` and calls it as `call.image("pixel:still", ...)`.

Core refuses, with a message naming the problem:

- at load (exit 2 `extension_refused`), a pack operation not named `<pack>:<op>`, or one whose role is not in the table;
- at load (exit 2 `extension_conflict`), two kinds that declare one operation with different roles, or a core kind that declares a core operation under another role;
- when the extensions load (exit 2 `settings_invalid`), a settings `routes` entry for an operation of a loaded pack that its kinds do not declare;
- at plan (exit 2 `invalid_input`), a pack kind that plans a call on a `<pack>:<op>` operation it does not declare. A pack's kind may still call core's own operations (`still`, `vision`, ...) without declaring them, on their core routes. A call on an operation with no route exits 2 `route_unavailable`.

## Typed call parameters

A kind may pass a small typed set on an image call: `call.image(op, prompt, references, seed, { parameters })`, where `parameters` is a `CallParameters`:

| Parameter | Shape                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| `size`    | `{ width, height }`: the output size in whole pixels.                                                           |
| `tiling`  | `{ x, y }`: whether the output tiles seamlessly across each edge.                                               |
| `palette` | `{ path, dir }`: a palette file, `/`-separated, relative to `dir` (the spec's, bible's or profile's directory). |

Core validates them and refuses a malformed one (exit 2 `invalid_input`), naming it. The palette is checked by the same project-root rule as any bible reference ([target-profile.md](target-profile.md#target-profile)): a path outside the project is refused before any call. Core then reads it and hashes its bytes. The parameters enter the call's journal key (the palette by path and sha256) and its provenance record as `callParameters`. List them on the planned call too (`PlannedCall.parameters`) so they enter the request digest: the job carries the palette by path, and `stage` hashes the palette's bytes into the digest's inputs as it does a bible reference's, so a palette edited after a plan is approved is another request. With none passed, keys and digests are byte-identical to a call without them.

The provider receives them as `ImageRequest.output` (`{ size?, tiling?, palette?: { path, sha256, bytes } }`), and its adapter maps them to its API. An adapter declares the ones it maps in `parameters`. A call that passes one the serving adapter does not declare is refused before any reservation or spend (exit 2 `route_unavailable`), naming the parameter, the provider and the adapter. The scripted adapter declares all three. Core's other adapters declare none yet.

## Spec and profile schemas

A kind may declare zod schemas (the `z` the context hands it):

- `specSchema` validates every spec of the kind, the whole spec object. An invalid spec is refused at plan, before any spend (exit 2 `invalid_input`), naming each field that failed.
- `profileSchema` validates the kind's block in the target profile, `kinds.<kind>`, without its `values` ([target-profile.md](target-profile.md#target-profile)). Without one, the block accepts only `values`.

Neither may declare a routing field. A schema that names a field `endpoint`, `baseURL`, `url`, `model`, `provider`, `providerOptions`, `graph` or `command` (plurals too, in any case, at any depth) is refused at load (exit 2 `extension_refused`), naming the field. Core reads both what the schema accepts and what it gives (so a pipe or transform hides nothing), and a field is named by a property, a required key, a record's key enum, literal or pattern, or a pattern property. A key pattern that admits any name, like a record of strings, names no field. Model, tier and price stay on the route in the developer settings, never in a spec. Core's own kinds declare permissive schemas through the same fields.

## Frames

A kind may declare `frames: "single" | "strip"`, how its output is cut into frames. Core's `still` declares `single` and `sprite-strip` declares `strip`; `character-3d` declares none, and its 3D path (turntable sheets and thumbnails) stays its own. A kind with no `frames` has no frames. Any other value is refused at load (exit 2 `extension_refused`).

A `strip` kind's output carries core's frame layout as `output.fields.frames`, a `FrameLayout`: `{ count, width, height, order?, durationMs? }`, `count` frames of `width` × `height` whole pixels side by side in one row, `order` `"left-to-right"` (the only order; absent means it). After `generate`, core checks it: `count`, `width` and `height` positive whole numbers, `durationMs` (each frame's duration; `sprite-strip` copies the profile's `frames.durationMs`) any positive number, and an image output it can decode must be `count × width` by `height`. A candidate that fails is not shown, and the run records why. Core also records the layout in the candidate's provenance parameters as `frame` (`{ width, height }`) and `frameCount` when the kind left them out; when the kind set them they must agree with the layout.

Core's frame features ask the kind's trait, never its name, and read the layout. The traits are those of core's kinds and the packs the developer settings load: the CLI commands, the MCP tools (the `plan` tool's saved plan included) and the MCP resources read the same ones.

| Feature                                               | A `strip` kind                                                                                                                               | Any other kind                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `plan` / `apply`                                      | Frames are reference-guided edits (`edit`) of an approved `keyPose`, `frames.count` of them; the spec needs `keyPose` and `animationFamily`. | `single`: one generated image (`still`). No `frames`: not planned. |
| `vary`                                                | Refused: vary edits single images.                                                                                                           | `single`: varied. No `frames`: refused.                            |
| Contact sheet                                         | A row of key frames, cut by the layout, with the frames QA flagged.                                                                          | The whole image.                                                   |
| Thumbnails (`browse`, MCP resources), `library stale` | Key frames, cut by the provenance's `frame` and `frameCount`.                                                                                | The whole image.                                                   |
| `atlas-json` and `aseprite-json` presets              | Written from `output.frames`.                                                                                                                | Refused (exit 2 `invalid_input`).                                  |

A preset reads the kind's trait as `PresetContext.frames`.

## Test kit

`@clockgrove/assetgrove/testing` is what a pack's own tests import:

- `ScriptedProvider`, `scriptedAdapter`, `sampleScript()`: the scripted provider core's tests use, which never calls a model.
- `tempProject({ settings? })`: a temporary Git project with its own developer settings and state directory (`dir`, `settingsPath`, `stateDir`, `env`, `writeSettings(settings, { attended? })`, `install(packageDir, name)`), running core's CLI as a child process (`cli(args)`), a core command in process with the pack's extension registered (`run(command, args, { extensions, confirm })`), or core's MCP server in process (`mcp({ extensions })`). Open, it points `ASSETGROVE_CONFIG` at its settings; `close()` restores the environment and removes it.
- `sampleBible()` (a style view), `bibleMarkdown(view?)` (that view as a `BIBLE.md` to write where `--bible` reads it), `sampleProfile()`, `samplePng()`, `extensionContext(name)` (the context core hands a pack), `RefusingCaller`.
- `assertConformance(entry, options)` (and `runConformance`, which returns the report): the conformance suite. It loads the entry as core does and checks the extension's shape and ids; creates each adapter through core (bare `fixedHosts`, a declared billing); plans and generates each kind on the scripted provider from `options.kinds[<kind>]` (`{ spec, bible?, profile?, output?, script? }`, required for every kind) and runs every `exact` check twice, each time under a `Caller` that refuses every call; and parses each preset's sample options, writes, and checks that its `check` passes what it wrote and fails when nothing was written. The whole suite runs with the global `fetch` trapped. An exact check that makes a call (even one it catches), throws, or answers differently the second time fails the suite, as does a pack that reaches the global `fetch`.

```ts
import { assertConformance } from "@clockgrove/assetgrove/testing";
import entry from "../src/index.ts";

test("the pack conforms", () =>
  assertConformance(entry, {
    kinds: { "tiles:tile": { spec: { kind: "tiles:tile", assetId: "t1" } } },
  }));
```

An adapter's provider declares its billing: `settle` (`reported` or `declared`) and `reconcile` (`lookup`, with `callCost`, or `unavailable`), and may implement `estimate(request, kind)`, which can only lower a call's reservation. Its `paid` is replaced by core's: paid unless the settings entry is `free` on a loopback `baseURL` ([settings.md](settings.md#billing)).

A kind's `generate` may return `artifacts`. `stage` writes them to `<run>/c<n>-<kind>/`, with the kind turned into a file-name slug: every run of characters other than lower-case letters, digits and hyphens becomes one hyphen, so `ext:tile` writes to `c1-ext-tile/`. An artifact name the path rules refuse (a character Windows cannot hold such as `:`, a trailing dot or space, a device name, or two names differing only by case) is written under a safe name instead. Only the last segment of a name is kept, split on `/` and on `\`, and each refused character becomes `-`, a device name gets a `_` prefix, and a repeat gets `-2` before its extension. The candidate's record lists each such file with the name the generator returned under `artifactNames`, so a paid candidate is never lost to its artifact names.

## Loading

Only packages named in the developer settings' `extensions` array load:

```json
{ "extensions": ["assetgrove-ext-example"] }
```

Each loads once per process, when the CLI or MCP server starts. A package.json dependency or a shared file never loads anything. Each name must resolve from the working directory (`node_modules/<name>/package.json` there or in a parent), and the package.json is read before any import: `assetgrove.api` must be one core speaks (2), and the `peerDependencies["@clockgrove/assetgrove"]` range must admit core's version, checked with semver, pre-releases included (so `^0.2.0` admits `0.2.1-rc.1` and refuses `0.3.0-rc.1`). The refusal names the api versions core speaks and its version.

| Exit code | Code                    | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2         | `extension_unavailable` | A listed package does not resolve (the message names `extensions[i]` and the settings file), or a `<ext>:<name>` id in a spec `kind`, a profile `handoff[].preset` or `providers.<id>.adapter` names an extension that is not loaded.                                                                                                                                                                                                                                                                                        |
| 2         | `extension_refused`     | The package.json is not a JSON object; `assetgrove.api` is not one core speaks (api 1 is refused with a message saying to rebuild against api 2); the peer range on `@clockgrove/assetgrove` is missing, not a semver range or excludes core's version; `entry` leaves the package; a Git work tree at or above the entry file tracks it; importing the entry fails; the default export is a function that throws; the name is invalid; an id is not `<name>:<id>`. The message names `extensions[i]` and the settings file. |
| 2         | `extension_conflict`    | Two extensions share a name, or an id repeats.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Unknown core-form ids keep their existing codes.

## The search slot

`search?: SearchSlot` is filled by `@clockgrove/assetgrove-search` (design section 7.1); at most one loaded extension may fill it (`extension_conflict` otherwise). Its `find(query, context)`, `index({rebuild?}, context)`, `status(context)` and `setup(context)` back core's commands `find`, `search index`, `search status` and `search setup`, which core declares with `requires: "search"`. While the slot is empty, `--help` and the MCP tool list leave those commands out and a call exits 2 `extension_unavailable`, naming the settings file whose `extensions` list would load the package. A factory that throws an error with code `extension_unavailable` (the search package on darwin-x64) is refused with that code.

Core hands each call a `SearchContext`: `stateDir`, `worktree` (the project), `game`, the settings' `search` block with its defaults, `env` (only the variables `search.store.credentialsEnv` names) and `library`, the library reader. The reader's `list(sources?)` gives every indexable file (`SearchLibraryItem`: picks with their card fields and text, the style bible's references, run candidates unless `search.candidates` is false, and the files of `search.folders`) with size and mtime; `load(item)` reads one, applying the library path rule and reading a Git LFS pointer's local object, never the network; `head()` is the work tree's commit and `clean()` says whether nothing under the library root differs from it; `origin()` is the repository's root commits, sorted (empty outside Git, before the first commit or in a shallow clone); `changedSince(commit)` says whether anything a shared index holds (the library root, the style bible and each of its reference paths) differs between that commit and HEAD, by `git diff --quiet <commit> HEAD -- <those paths>`, and is true when Git cannot tell (a commit the clone lacks). `changedSince` is optional in the contract; without it a shared index is fresh only at the commit it was built from. A shared remote store keys its rows by the sha256 of the game id and `origin()`, so every clone of one repository shares them and another repository with the same game id never does; with `origin()` empty a remote store is refused. `outliers(addresses, context)` returns `{members, ranking: [{address, distance}]}`: every address with an indexed image, ranked by its mean cosine distance to every other member, most distant first, with no cut; it is free and reads only stored vectors. Core reports the addresses it left out (no indexed image) as `unranked` in `find --outliers` and `audit`. Core, not the slot, judges which of the most distant are drawn in another style (`find --outliers`, one `style-outlier` decision each). `find` returns `{hits: [{address, rank, score, source, path, view, fields, sharedText}], fresh, builtFrom}`; with a shared store, `fresh` holds when the store was built at HEAD or nothing it holds changed since the commit it was built from (`changedSince`), so a commit that touches only code leaves it fresh; core adds `sheet`, a numbered PNG of the hits, and the `find` tool returns it as image content.

With `search.embedder: "route"` the context also carries `embedder` (`SearchRouteEmbedder`: `route`, the provider's settings id, `model` and `dimension`, 768), resolved from the `embeddings` role. Its `embed(input)` (one image's bytes or one text, returning the vector) is present only inside a confirmed paid run of `search index` or `find` (any `find` but `--outliers`, which embeds nothing: bringing the index up to date embeds too), where core makes each call through its `Caller`: reserved against the caps, journalled and recorded in the spend ledger. Without it the slot never calls the provider: it answers from stored vectors and refuses words or an image. The slot's optional `forecast({index: {rebuild?}} | {find: query}, context)` is the free plan step: `{images, texts, queries, state}`, what the request would embed, counted without embedding, and `state`, a hash of that pending work which core puts in the request digest. An index built by another embedder refuses with code `embedder_changed` (exit 2).

## Not extensible

Commands, transform operations, formats, spend, confirmation, licences, the prompt policy and provenance stay in core.

## Listing

`assetgrove extensions [--json]` (MCP tool `extensions`) lists core, then each loaded extension, under the field `extensions`: `{name, package, version, entry, kinds, presets, adapters}`.

`assetgrove init` lists every loaded pack's adapters under the field `adapters` (`{adapter, extension, package, hosts, endpointFromSettings, keyEnv}`) and in its data flows, accepts them in `--providers`, and includes their hosts and key variables in the key recipes. `keyEnv` is the variable the adapter will read: a configured provider's `keyEnv` when one using the adapter sets it, else the adapter's `defaultKeyEnv`.

Why settings alone load code: [decisions](decisions.md#extensions-load-only-from-developer-settings).
