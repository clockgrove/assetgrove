# @clockgrove/assetgrove-search

Optional search package for Assetgrove (design section 7). Core never imports it.

## Near matches before paid generation

With the package loaded and `search.nearMatch` on, the plan step of `plan`, `stage`, `apply` and `generate-sheet` lists up to three picked assets in `WorkPlan.nearMatches`, with a sheet, ranked closest to the request: its kind, subject and brief as words, fused with image similarity to its references. Only the kind filters. No similarity number cuts the list, because any number would be calibrated on one library's art; the person looking at the spend confirmation is the one who can judge whether one serves. The spend form names them; the request digest leaves them out.

With a paid (hosted) embedder nothing about the request is embedded: the list uses stored vectors and full text only, and a reference counts only when an indexed file has the same bytes.
