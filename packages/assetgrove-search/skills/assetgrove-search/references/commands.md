# Assetgrove search commands

One section per command: its usage, its flags, and the MCP tool that serves it and that tool's arguments. Every command takes `--help` and `--json`, and needs the search package listed in the developer settings. None spends; they write only under the state directory.

### `find`

```text
find [words] [--like <address|path>] [--where <filter>...] [--source <source>...] [--game all] [--limit 20] [--target <dir>] [--json]
```

Searches the library of the project at `--target` (default: the working directory's Git top level). Words rank by Reciprocal Rank Fusion over the image vector, the card-text vector and full text. `--like` ranks by look against an `asset://` address's indexed image or an image file; with words too, every ranking is fused. `--where` keeps rows whose fields match: `field=value`, `!=`, `<`, `>` or `tag=value`, over `kind`, `subject`, `state`, `bible`, `license`, `source`, `game`, `id`, `address`, `path`, `view` and `title`; an unknown field exits 2 `invalid_input`. `--source` keeps `pick`, `reference`, `candidate` or `folder` rows. `--game all` searches every game in the store. `--limit` caps the hits.

Returns `{hits: [{address, rank, score, source, path, view, fields, sharedText}], fresh, builtFrom, sheet}`: one hit per asset at its best view, card text only under `sharedText`, and `sheet`, a PNG of the hits numbered by rank (numbers only), which the tool also returns as image content. The index is brought up to date first unless another process is writing it; `fresh` is false then, or when a shared index was built from another HEAD.

MCP tool: `find`, arguments `words`, `like`, `where`, `source`, `game`, `limit`, `target`.

### `search index`

```text
search index [--rebuild] [--target <dir>] [--json]
```

Waits for the index's write lock and indexes what changed since the last run, embedding only content it has not seen. With a shared store and `writer: true` it also builds the shared index from pick and reference rows, and refuses (exit 2 `invalid_input`) while anything under the library root differs from HEAD; with `writer: false` it never writes the shared store. `--rebuild` starts the local index afresh.

MCP tool: `search_index`, arguments `rebuild`, `target`.

### `search status`

```text
search status [--target <dir>] [--json]
```

Reports the local store, the embedder and whether its model is installed, what the index was built from, and the shared store with whether it is fresh for this HEAD. Reads only.

MCP tool: `search_status`, arguments `target`.

### `search setup`

```text
search setup [--target <dir>] [--json]
```

Downloads the pinned SigLIP2 model to `<stateDir>/models` from Hugging Face, else the project's release mirror, and checks every file against the sha256 values the package ships. A failed download or a mismatch exits 4 `provider_error`. Needs no project.

MCP tool: `search_setup`, arguments `target`.
