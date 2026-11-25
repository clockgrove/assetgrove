# Demo Garden: the launch guide's synthetic example

The files the [launch guide](../../launch-guide.md) uses. Demo Garden is an invented game; its assets, artist and URLs are synthetic (`example.test` is a reserved name that resolves nowhere).

| File                    | What                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `profile-fragment.json` | The target profile fields the guide changes from `init`'s: a pixel-art style, a 32 px frame, media inside the Godot project, a manifest recording each asset's source type and origin, and the `godot:sprite-frames` hand-off. |
| `fern.json`             | The spec of `fern`, an AI-generated still.                                                                                                                                                                                     |
| `mole-walk.json`        | The spec of `mole`'s walk, drawn by a person in Aseprite.                                                                                                                                                                      |
| `beetle.origin.json`    | The origin record of `beetle`, a third-party sheet under CC BY 4.0.                                                                                                                                                            |

Copy each top-level field of `profile-fragment.json` over the `.assetgrove/profile.json` that `init` writes, keeping `format`, `values` and `review`. The fragment's `manifest` replaces `init`'s template, whose `source` block labels every asset `generated` by `assetgrove`: here `source` records the IPTC digital source type the hand-off resolved and, for third-party art, the supplier's origin record, so a human-made or third-party asset is never labelled generated in the file the game reads.

`test/launch-guide.test.ts` runs the guide's `init`, this merge, its LFS step, `stage-source`, `pick` and `import` on these files in a scratch repository; the Godot pack's `test/launch-guide.test.ts` runs the same profile with the pack loaded, through `doctor` and, with Godot on PATH, a `pick` that builds the SpriteFrames.
