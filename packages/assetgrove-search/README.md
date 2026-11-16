# @clockgrove/assetgrove-search

Optional search package for Assetgrove (design section 7). Core never imports it.

## Near matches before paid generation

With the package loaded and `search.nearMatch` on, the plan step of `plan`, `stage`, `apply` and `generate-sheet` lists up to three picked assets in `WorkPlan.nearMatches`, with a sheet, ranked closest to the request: its kind, subject and brief as words, fused with image similarity to its references (the spec's key pose and its subject's identity turnaround, not the bible's style anchors). Only the kind filters. No similarity number cuts the list, because any number would be calibrated on one library's art; the person looking at the spend confirmation is the one who can judge whether one serves. The spend form names them; the request digest leaves them out.

With a paid (hosted) embedder nothing is embedded before the person confirms: neither the request nor library files not yet indexed. The list searches the index as it stands (reported not fresh), by stored vectors and full text only, and a reference counts only when an indexed file has the same bytes.
