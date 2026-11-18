---
name: art-direction
description: Load when generating or reviewing art for a world using Assetgrove, or when reading, writing or changing its style bible (BIBLE.md).
---

# Art direction

A world's look lives in one file, its style bible `BIBLE.md` (`.assetgrove/art-direction/BIBLE.md` after `assetgrove init`), which the target repository owns. `init` also writes a target-owned copy of this skill that links that bible. Before generating or reviewing art, read the bible: its front matter, its positive and negative anchor images, and its Do's and Don'ts. The bible is a constitution: a brief adjusts only what its `adjustable` section allows and cannot override the rest.

To read, write or change a bible, follow [the BIBLE.md reference](references/bible-format.md): every field, which commands read it, and the steps to change one safely (`assetgrove bible describe` validates it without a model call).

Starting presets: [Cozy storybook (painterly)](presets/cozy-storybook.md), [Flat cartoon, kids](presets/flat-cartoon-kids.md), [Dark gritty isometric](presets/dark-gritty-isometric.md). `assetgrove bible preset` rewrites a bible's look and tone from one and keeps its palette, anchors and identity locks.

The target repository owns the bible and [prompt template](default.md).

A bible that lists anchor, identity-lock or perspective images sets `referenceLicense` (an SPDX identifier, `LicenseRef-*` or `NOASSERTION`), the terms those images were provided under; an anchor may set its own `license`. Provenance records these terms and does not check them. Every image path must stay inside the project root.
