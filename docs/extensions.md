# Extensions

An extension adds asset kinds, engine presets and provider adapters. Core registers through the same contract (`src/extensions/core.ts`): kinds `still`, `sprite-strip` and `character-3d`; presets `manifest`, `atlas-json` and `aseprite-json`; adapters `vercel-ai-gateway`, `anthropic`, `openai`, `openai-compatible`, `tripo` and `scripted`.

## Contract

`@clockgrove/assetgrove/extension` (`dist/extension/api.js`, `api.d.ts`) exports `EXTENSION_API` (1) and these types:

| Type               | Shape                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Extension`        | `{ api: 1, name, kinds?, presets?, adapters? }`                                                                                                             |
| `ExtensionContext` | `{ api: 1, z }`: zod, so an extension imports no core module.                                                                                               |
| `AssetKind`        | `kind`, `planCandidate(spec, profile, routes)`, `generate(ctx)`.                                                                                            |
| `EnginePreset`     | `name`, zod `optionsSchema`, `write(ctx, options)`, `check(ctx, options, files, read)`.                                                                     |
| `ProviderAdapter`  | `id`, `capabilities`, `defaultKeyEnv?`, `fixedHosts`, `endpointFromSettings`, `defaultRoutes?` (by operation), `create(c)` returning a generation provider. |

A package declares `"assetgrove": { "api": 1, "entry": "./index.js" }` in package.json and lists `@clockgrove/assetgrove` as a peer dependency. The entry's default export is an `Extension`, or a function `(context) => Extension | Promise<Extension>`. Runtime helpers come through the context.

Every extension name matches `^[a-z][a-z0-9-]*$` and is not `core`. Each kind, preset and adapter id is `<name>:<id>`.

A kind's `generate` may return `artifacts`. `stage` writes them to `<run>/c<n>-<kind>/`, with the kind turned into a file-name slug: every run of characters other than lower-case letters, digits and hyphens becomes one hyphen, so `ext:tile` writes to `c1-ext-tile/`.

## Loading

Only packages named in the developer settings' `extensions` array load:

```json
{ "extensions": ["assetgrove-ext-example"] }
```

Each loads once per process, when the CLI or MCP server starts. A package.json dependency or a shared file never loads anything. Each name must resolve from the working directory (`node_modules/<name>/package.json` there or in a parent), and the package.json is read before any import.

| Exit code | Code                    | When                                                                                                                                                                                                                                                                                                                                |
| --------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2         | `extension_unavailable` | A listed package does not resolve (the message names `extensions[i]` and the settings file), or a `<ext>:<name>` id in a spec `kind`, a profile `handoff[].preset` or `providers.<id>.adapter` names an extension that is not loaded.                                                                                               |
| 2         | `extension_refused`     | The package.json is not a JSON object; `assetgrove.api` is not 1; `entry` leaves the package; the working directory's Git tracks the entry file; importing the entry fails; the default export is a function that throws; the name is invalid; an id is not `<name>:<id>`. The message names `extensions[i]` and the settings file. |
| 2         | `extension_conflict`    | Two extensions share a name, or an id repeats.                                                                                                                                                                                                                                                                                      |

Unknown core-form ids keep their existing codes.

## Not extensible

Commands, transform operations, formats, spend, confirmation, licences, the prompt policy and provenance stay in core.

## Listing

`assetgrove extensions [--json]` (MCP tool `extensions`) lists core, then each loaded extension, under the field `extensions`: `{name, package, version, entry, kinds, presets, adapters}`.

Why settings alone load code: [decisions](decisions.md#extensions-load-only-from-developer-settings).
