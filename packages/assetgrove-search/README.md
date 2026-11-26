# @clockgrove/assetgrove-search

Optional search package for Assetgrove (design section 7). Core never imports it.

## Extension API

The package declares `"assetgrove": { "api": 3 }` and a peer range on `@clockgrove/assetgrove` that the installed core must satisfy, or core refuses it. It imports only from core's public exports: the search types from `@clockgrove/assetgrove/extension` (type-only, so the built package needs nothing from core at runtime) and, in its tests, the pack test kit `@clockgrove/assetgrove/testing` (a temporary project, core's CLI and MCP server, and the conformance suite in `test/conformance.test.ts`). It keeps no copy of core's contract. The tests run with `node --conditions=assetgrove-source`, which resolves the linked core to its TypeScript source; the same condition is in `tsconfig.json` for `tsc`.

## Near matches before paid generation

With the package loaded and `search.nearMatch` on, the plan step of `plan`, `stage`, `apply` and `generate-sheet` lists up to three picked assets in `WorkPlan.nearMatches`, with a sheet, ranked closest to the request: its kind, subject and brief as words, fused with image similarity to its references (the spec's key pose, its subject's identity turnaround and, for `stage` and `generate-sheet`, the style bible's subject references tagged with the spec's subject and look; never the bible's style anchors). Only the kind filters. No similarity number cuts the list, because any number would be calibrated on one library's art; the person looking at the spend confirmation is the one who can judge whether one serves. The spend form names them; the request digest leaves them out.

With a paid (hosted) embedder nothing is embedded before the person confirms: neither the request nor library files not yet indexed. The list searches the index as it stands (reported not fresh), by stored vectors and full text only, and a reference counts only when an indexed file has the same bytes.
