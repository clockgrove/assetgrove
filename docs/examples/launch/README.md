# Demo Garden: the launch guide's synthetic example

The files the [launch guide](../../launch-guide.md) uses. Demo Garden is an invented game; its assets, artist and URLs are synthetic (`example.test` is a reserved name that resolves nowhere).

| File                    | What                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile-fragment.json` | The target profile fields the guide changes from `init`'s: a pixel-art style, a 32 px frame, media inside the Godot project, and the `godot:sprite-frames` hand-off. |
| `fern.json`             | The spec of `fern`, an AI-generated still.                                                                                                                           |
| `mole-walk.json`        | The spec of `mole`'s walk, drawn by a person in Aseprite.                                                                                                            |
| `beetle.origin.json`    | The origin record of `beetle`, a third-party sheet under CC BY 4.0.                                                                                                  |

Merge `profile-fragment.json` into the `.assetgrove/profile.json` that `init` writes; keep `format` and the `manifest` template `init` wrote. `test/launch-guide.test.ts` checks that these files parse and that the guide's commands exist.
