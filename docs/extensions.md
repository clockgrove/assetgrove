# Extensions

An extension adds asset kinds, engine presets and provider adapters. Core registers through the same contract (`src/extensions/core.ts`): kinds `still`, `sprite-strip` and `character-3d`; presets `manifest`, `atlas-json` and `aseprite-json`; adapters `vercel-ai-gateway`, `anthropic`, `openai`, `openai-compatible`, `tripo` and `scripted`.

## Contract

`@clockgrove/assetgrove/extension` (`dist/extension/api.js`, `api.d.ts`) exports `EXTENSION_API` (1) and these types:

| Type               | Shape                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Extension`        | `{ api: 1, name, kinds?, presets?, adapters?, search? }`                                                                                                    |
| `ExtensionContext` | `{ api: 1, z }`: zod, so an extension imports no core module.                                                                                               |
| `AssetKind`        | `kind`, `planCandidate(spec, profile, routes)`, `generate(ctx)`.                                                                                            |
| `EnginePreset`     | `name`, zod `optionsSchema`, `write(ctx, options)`, `check(ctx, options, files, read)`.                                                                     |
| `ProviderAdapter`  | `id`, `capabilities`, `defaultKeyEnv?`, `fixedHosts`, `endpointFromSettings`, `defaultRoutes?` (by operation), `create(c)` returning a generation provider. |

A package declares `"assetgrove": { "api": 1, "entry": "./index.js" }` in package.json and lists `@clockgrove/assetgrove` as a peer dependency. The entry's default export is an `Extension`, or a function `(context) => Extension | Promise<Extension>`. Runtime helpers come through the context.

Every extension name matches `^[a-z][a-z0-9-]*$` and is not `core`. Each kind, preset and adapter id is `<name>:<id>`.

A kind's `generate` may return `artifacts`. `stage` writes them to `<run>/c<n>-<kind>/`, with the kind turned into a file-name slug: every run of characters other than lower-case letters, digits and hyphens becomes one hyphen, so `ext:tile` writes to `c1-ext-tile/`. An artifact name the path rules refuse (a character Windows cannot hold such as `:`, a trailing dot or space, a device name, or two names differing only by case) is written under a safe name instead. Only the last segment of a name is kept, split on `/` and on `\`, and each refused character becomes `-`, a device name gets a `_` prefix, and a repeat gets `-2` before its extension. The candidate's record lists each such file with the name the generator returned under `artifactNames`, so a paid candidate is never lost to its artifact names.

## Loading

Only packages named in the developer settings' `extensions` array load:

```json
{ "extensions": ["assetgrove-ext-example"] }
```

Each loads once per process, when the CLI or MCP server starts. A package.json dependency or a shared file never loads anything. Each name must resolve from the working directory (`node_modules/<name>/package.json` there or in a parent), and the package.json is read before any import.

| Exit code | Code                    | When                                                                                                                                                                                                                                                                                                                                   |
| --------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2         | `extension_unavailable` | A listed package does not resolve (the message names `extensions[i]` and the settings file), or a `<ext>:<name>` id in a spec `kind`, a profile `handoff[].preset` or `providers.<id>.adapter` names an extension that is not loaded.                                                                                                  |
| 2         | `extension_refused`     | The package.json is not a JSON object; `assetgrove.api` is not 1; `entry` leaves the package; a Git work tree at or above the entry file tracks it; importing the entry fails; the default export is a function that throws; the name is invalid; an id is not `<name>:<id>`. The message names `extensions[i]` and the settings file. |
| 2         | `extension_conflict`    | Two extensions share a name, or an id repeats.                                                                                                                                                                                                                                                                                         |

Unknown core-form ids keep their existing codes.

## The search slot

`search?: SearchSlot` is filled by `@clockgrove/assetgrove-search` (design section 7.1); at most one loaded extension may fill it (`extension_conflict` otherwise). Its `find(query, context)`, `index({rebuild?}, context)`, `status(context)` and `setup(context)` back core's commands `find`, `search index`, `search status` and `search setup`, which core declares with `requires: "search"`. While the slot is empty, `--help` and the MCP tool list leave those commands out and a call exits 2 `extension_unavailable`, naming the settings file whose `extensions` list would load the package. A factory that throws an error with code `extension_unavailable` (the search package on darwin-x64) is refused with that code.

Core hands each call a `SearchContext`: `stateDir`, `worktree` (the project), `game`, the settings' `search` block with its defaults, `env` (only the variables `search.store.credentialsEnv` names) and `library`, the library reader. The reader's `list(sources?)` gives every indexable file (`SearchLibraryItem`: picks with their card fields and text, the style bible's references, run candidates unless `search.candidates` is false, and the files of `search.folders`) with size and mtime; `load(item)` reads one, applying the library path rule and reading a Git LFS pointer's local object, never the network; `head()` is the work tree's commit and `clean()` says whether nothing under the library root differs from it; `origin()` is the repository's root commits, sorted (empty outside Git, before the first commit or in a shallow clone). A shared remote store keys its rows by the sha256 of the game id and `origin()`, so every clone of one repository shares them and another repository with the same game id never does; with `origin()` empty a remote store is refused. `find` returns `{hits: [{address, rank, score, source, path, view, fields, sharedText}], fresh, builtFrom}`; core adds `sheet`, a numbered PNG of the hits, and the `find` tool returns it as image content.

## Not extensible

Commands, transform operations, formats, spend, confirmation, licences, the prompt policy and provenance stay in core.

## Listing

`assetgrove extensions [--json]` (MCP tool `extensions`) lists core, then each loaded extension, under the field `extensions`: `{name, package, version, entry, kinds, presets, adapters}`.

Why settings alone load code: [decisions](decisions.md#extensions-load-only-from-developer-settings).
