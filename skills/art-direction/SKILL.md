---
name: art-direction
description: Load when generating or reviewing art for a world using Assetgrove.
---

# Art direction

Run assetgrove bible init to package a target-owned style bible. The generated skill links its target-owned BIBLE.md. Read that bible, its positive and negative anchor paths, and Do's and Don'ts before generating.

Starting presets: [Cozy storybook (painterly)](presets/cozy-storybook.md), [Flat cartoon, kids](presets/flat-cartoon-kids.md), [Dark gritty isometric](presets/dark-gritty-isometric.md).

The target repository owns the bible and [prompt template](default.md), and briefs cannot override the constitution.

The `BIBLE.md` front matter starts with `format: assetgrove-style-bible/1`; `assetgrove migrate BIBLE.md --kind style-bible` adds it to an older bible. A bible that lists anchors or identity-lock references sets `referenceLicense` (an SPDX identifier, `LicenseRef-*` or `NOASSERTION`), the terms those images were provided under. An anchor may set its own `license`. Provenance records these terms and does not check them. Reference paths must stay inside the project root.
