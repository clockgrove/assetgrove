# @clockgrove/assetgrove-search

Optional search package for Assetgrove (design section 7). Core never imports it.

## Near matches before paid generation

With the package loaded and `search.nearMatch` on, the plan step of `plan`, `stage`, `apply` and `generate-sheet` lists up to three picked assets of exactly the spec's kind and subject in `WorkPlan.nearMatches`, with a sheet. The spend form names them; the request digest leaves them out.

**An empty list does not mean no near matches exist.** The image-similarity threshold (`src/image-threshold.json`) is not yet measured and ships as `null`:

- A request **with references** lists no near matches, because none can be shown to clear the threshold.
- A request **without references** ranks same-kind, same-subject picks by words; the threshold is not applied.

The bench run of orchestrator step o-2 measures the threshold; its commit sets the number in `image-threshold.json` and `docs/decisions.md`, and a test keeps the two equal.
