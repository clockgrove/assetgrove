# Assetgrove search commands

One section per command: its usage, its flags, and the MCP tool that serves it and that tool's arguments. Every command takes `--help` and `--json`, and needs the search package listed in the developer settings. With the local model none spends; they write only under the state directory. With a hosted embedder (`search.embedder: "route"`), `search index` and `find` with words or an image file are paid requests: they take `--dry-run`, `--cap`, `--work-item` and `--runs`, ask one spend confirmation and reserve every embedding against the caps; everything else answers from stored vectors and spends nothing. An index built by another embedder exits 2 `embedder_changed` until `search index --rebuild`.

### `find`

```text
find [words] [--like <address|path>] [--where <filter>...] [--source <source>...] [--game all] [--limit 20] [--outliers <set>] [--target <dir>] [--cap <usd>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Searches the library of the project at `--target` (default: the working directory's Git top level). Words rank by Reciprocal Rank Fusion over the image vector, the card-text vector and full text. `--like` ranks by look against an `asset://` address's indexed image or an image file; with words too, every ranking is fused. `--where` keeps rows whose fields match: `field=value`, `!=`, `<`, `>` or `tag=value`, over `kind`, `subject`, `state`, `bible`, `license`, `source`, `game`, `id`, `address`, `path`, `view`, `title` and `form` (a music card's `track` or `cue`), and numerically, also with `<=` and `>=`, over `width`, `height`, `durationS` (a WAV's measured duration in seconds) and `tempo` (a music card's requested bpm), which a row without the value never matches; an unknown field exits 2 `invalid_input`. An audio asset is found by its card text (title, labels, kind, subject, form) and these fields: `find victory --where kind=music --where 'durationS<20'`. On `bible`, `<` and `>` order values as versions, numbers by their value (`2` before `10`, `v3` before `v10`): the bible values the rows in scope hold are sorted that way and the term keeps those before or after the given one, so `bible<10` keeps assets under bibles 1 to 9. On every other field they compare strings character by character. `--source` keeps `pick`, `reference`, `candidate` or `folder` rows; one or several, the store keeps only those sources before anything is ranked, so the best matches of the requested sources come back however many rows of other sources outrank them. `--game all` searches every game in the store. `--limit` caps the hits. `--outliers <set>` replaces the search: `<set>` is an `asset://` folder address (the game root, `by-kind/<kind>/`, `by-subject/<subject>/`, `by-tag/<tag>/` or `stale/`), and the command asks which of its members are drawn in a different style. The index ranks every member with an indexed image by its mean cosine distance to every other member, most distant first, with no cut; it reads the vectors already stored, so a member not yet indexed is not ranked (it is listed under `unranked`, and `search index` brings it in): a free ranking, never a verdict, since the distance tracks subject and pose as much as style. Then for the five most distant members (all but the least distant in a set of six or fewer, so at least one typical member is shown; none in a set under three) one `style-outlier` decision each (decisions role, $0.001 estimate on the default route) is shown the member's image (512 px), a contact sheet of up to eight typical members (the least distant) and the style bible's world, axes and Do's and Don'ts: is this image drawn in a different art style from the rest? The yes answers are listed. It ignores the other search options and embeds nothing.

Returns `{hits: [{address, rank, score, source, path, view, fields, sharedText}], fresh, builtFrom, sheet}`: one hit per asset at its best view, card text only under `sharedText`, and `sheet`, a PNG of the hits numbered by rank (numbers only), which the tool also returns as image content. The index is brought up to date first unless another process is writing it; `fresh` is false then, or when a shared index was built from a commit since which something it holds changed: a file under the library root, the style bible or one of its references (`git diff <builtFrom.head> HEAD` over those paths). A commit that touches only code keeps it fresh.

With `--outliers` it returns `{set, members, outliers: [{address, distance, probability}], ranking: [{address, distance, differentStyle?, probability?}], unranked, typical, notJudged, spentUsd}` instead of hits and a sheet: `outliers` holds the members judged drawn in another style, `members` the count of ranked members, `ranking` every ranked member, most distant first, with the answer on those judged, `unranked` the members of the set with no indexed image (not ranked or judged until `search index` indexes them), `typical` the members the contact sheet shows and `notJudged` the members among the most distant whose image is not on this machine (a Git LFS pointer, not an image). The human output prints the whole ranking, then the members not ranked, and its last line counts the ranked members and how many of the set were not ranked, so a set whose new members are not yet indexed never reads as a pass.

With a hosted embedder, a find with words or an image file for `--like` is a paid request: `--dry-run` prints its plan (the images, card texts and query to embed and their forecast), `--cap` caps the run (at most `caps.runUsd`), `--work-item` names the spend ledger's work item, `--runs` is where its run directory goes and `--round` is part of its digest; it asks one spend confirmation and reserves each embedding. Any other find answers from the vectors already stored, does not bring the index up to date (`fresh` false) and spends nothing.

`--outliers` is a paid request under every embedder, the local model too: `--dry-run` prints its plan (one `style-outlier` call per member judged), `--cap`, `--work-item`, `--runs` and `--round` work as above, it asks one spend confirmation and reserves each decision against the caps and the spend ledger. The same request run again is answered from its run's journal and pays nothing twice. Answers are not cached across requests.

MCP tool: `find`, arguments `words`, `like`, `where`, `source`, `game`, `limit`, `outliers`, `target`, `cap`, `workItem`, `runs`, `round`.

### `search index`

```text
search index [--rebuild] [--target <dir>] [--cap <usd>] [--work-item <label>] [--provider-script <module>] [--runs .assetgrove/runs] [--round 1] [--dry-run] [--json]
```

Waits for the index's write lock and indexes what changed since the last run, embedding only content it has not seen. With a shared store and `writer: true` it also builds the shared index from pick and reference rows, and refuses (exit 2 `invalid_input`) while anything under the library root differs from HEAD; with `writer: false` it never writes the shared store. `--rebuild` starts the local index afresh.

With a hosted embedder it is a paid request: its plan step forecasts one embedding per image view and card text not embedded yet (`--dry-run` prints it), one spend confirmation covers it, each call is reserved against the caps and journalled, and content embedded before is never paid for again; `--cap`, `--work-item`, `--runs` and `--round` work as for `find`. An index built by another embedder exits 2 `embedder_changed` until `--rebuild` rebuilds it under this one.

MCP tool: `search_index`, arguments `rebuild`, `target`, `cap`, `workItem`, `runs`, `round`.

### `search status`

```text
search status [--target <dir>] [--json]
```

Reports the local store, the embedder and whether its model is installed, what the index was built from, and the shared store with whether it is fresh for this HEAD: built at it, or nothing under the library root, the style bible or its references changed since the commit it was built from. Reads only.

MCP tool: `search_status`, arguments `target`.

### `extensions setup search`

```text
assetgrove extensions setup search [--json]
```

Downloads the pinned SigLIP2 model to `<stateDir>/models` from Hugging Face, else the project's release mirror, and checks every file against the sha256 values the package ships. A failed download or a mismatch exits 4 `provider_error`. Needs no project.

MCP tool: `extensions_setup`, argument `name` (`search`).

## Search paths in the asset tree

While the package is listed, the server's resource templates add three paths under the game root. Each is a read of the library tree, so it never spends and writes no sheet; it runs the same search as `find` with the same input and returns `{address, hits, fresh, builtFrom}`, the hits as `find` returns them (card text only under `sharedText`). Without the package no search template is listed and reading one is an unknown address.

| Template                        | Same as                              |
| ------------------------------- | ------------------------------------ |
| `asset://<game>/find/{words}`   | `find "<words>"`                     |
| `asset://<game>/like/{asset}`   | `find --like asset://<game>/<asset>` |
| `asset://<game>/where/{filter}` | `find --where "<filter>"`            |

Percent-encode each segment (`find/red%20lantern`, `where/kind%3Dsprite`). A path takes one value; use the `find` tool for several filters, sources or a limit. The names `find`, `like` and `where` are reserved asset ids.
