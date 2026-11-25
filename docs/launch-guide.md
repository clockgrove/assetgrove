# Launch guide: an open asset pipeline for a Godot game

This guide walks one small game from an empty repository to a reviewed, recorded set of sprites in its Godot project. The set mixes three kinds of art on purpose, because most games do:

- art a model generated through Assetgrove;
- art a person drew;
- art from a third party, under a licence.

Assetgrove treats all three the same way once they are in: each is a file in the game's own Git repository, with a record of where it came from, a review history and a licence, handed to Godot by Godot itself. The guide shows each step with the command that does it and links to the reference page that says the rest.

Assetgrove and its Godot pack are independent projects. They are not affiliated with, reviewed by or endorsed by the Godot Engine project or the Godot Foundation. The pack drives a stock Godot 4.7.2 through Godot's own public API, and Godot is one hand-off target among several: the same records work with a manifest of your own or sprite-atlas JSON ([handoff.md](handoff.md)).

## The example

Demo Garden is a synthetic game made up for this guide. Its files are in [examples/launch/](examples/launch/README.md). It has three characters, each labelled by where it came from:

| Asset    | Origin                                                         | Edits                                                 | IPTC digital source type on hand-off                                   |
| -------- | -------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `fern`   | **AI-generated** by Assetgrove (`plan`, `apply`, `pick`)       | Version 2 is a person's hand edit of the generated v1 | `trainedAlgorithmicMedia`, then `compositeWithTrainedAlgorithmicMedia` |
| `mole`   | **Human-made**: drawn by a person in Aseprite                  | None by a model; Assetgrove only renders the strip    | `digitalCreation`, declared by the person                              |
| `beetle` | **Third-party**: a sheet from an outside pack, under CC BY 4.0 | Sliced and matted by Assetgrove, no model edit        | `digitalCreation`, declared from the supplier's statement              |

Nothing in the example names a real game, artist or character, and its URLs use `example.test`, which resolves nowhere.

## 1. Versioned source: everything lives in the game's repository

You need Node 24, Git with Git LFS, a checkout of Assetgrove (the [README's quick start](../README.md#quick-start) gives the `assetgrove` alias), and a Godot 4 project in the game repository. Demo Garden keeps its Godot project in `game/`.

```sh
assetgrove init --directory . --profile-preset sprite-32 --style-preset cozy-storybook --world "Demo Garden"
git lfs install
```

`init` writes the target profile (`.assetgrove/profile.json`), the style bible (`.assetgrove/art-direction/BIBLE.md`), Git LFS rules for the library's media and `.gitignore` rules for the run folders. Then copy each top-level field of [`profile-fragment.json`](examples/launch/profile-fragment.json) over the profile's, keeping the fields the fragment does not have (`format`, `values`, `review`). The fragment sets a pixel-art style, a 32 px frame, media inside the Godot project (`game/assets/…`), a manifest that records each asset's source type and origin, and the Godot hand-off.

`init` put its LFS rules in the preset's library folder, `assets/source/`, before the fragment moved the library to `game/assets/`. Move them with it, or every `pick` refuses the media as not stored in LFS:

```sh
mkdir -p game/assets
mv assets/source/.gitattributes game/assets/.gitattributes
```

The fragment's hand-off names `godot:sprite-frames`, which the Godot pack provides, and a command refuses a profile whose pack is not loaded. So set the pack up now, before the first `pick` (section 6 says what it does), in three steps.

First install it in the game repository: core loads a listed pack only when its name resolves from the directory you run in (`node_modules/@clockgrove/assetgrove-godot/package.json` there or in a parent; [extensions.md](extensions.md#loading)). The pack is not on npm yet, so pack it in your Assetgrove checkout (run there, so the checkout's pinned pnpm builds it) into the game repository's `vendor/`, and install that tarball. `--legacy-peer-deps` stops npm fetching the pack's peer, `@clockgrove/assetgrove`, which is your checkout and not an npm package yet:

```sh
(cd /path/to/assetgrove && pnpm --dir packages/assetgrove-godot pack --pack-destination "$OLDPWD/vendor")
npm install --save-dev --legacy-peer-deps ./vendor/clockgrove-assetgrove-godot-0.2.0.tgz
```

Commit `package.json`, `package-lock.json` and the tarball, and keep `node_modules/` out of Git.

Then list the pack in the developer settings, with no `godot` setting yet:

```json
{
  "extensions": ["@clockgrove/assetgrove-godot"]
}
```

and run its setup, which downloads the pinned Godot 4.7.2, checks it and prints its path:

```sh
assetgrove extensions setup godot
```

Last, put the path it printed in the pack's setting. Do this only after setup: with a `godot` setting that names no file, setup refuses (`names …, which is not a file`) and downloads nothing.

```json
{
  "extensions": ["@clockgrove/assetgrove-godot"],
  "extensionSettings": {
    "@clockgrove/assetgrove-godot": { "godot": "/path/printed/by/setup" }
  }
}
```

The Godot pack is optional: without it, drop the `godot:sprite-frames` entry from the profile's `handoff`, and every step but section 6 works the same.

From here on, the source of truth is Git:

- **Media** is stored in Git LFS (the library's `.gitattributes`, here `game/assets/.gitattributes`, maps `*.png`, `*.glb` and the other media types; `pick` refuses media Git would not store in LFS).
- **Each asset's versions** are a stack in its review record (`<assetId>.review.json`): every pick, edit or adoption appends a version by its sha256, and older ones stay in Git's history ([library.md](library.md#review-records)).
- **Editable sources** stay beside their exports, inside the library: a strip rendered from an `.aseprite` file records that file's path and sha256, so a later edit of the source is staged as a new version of the same asset ([sheet-import.md](sheet-import.md#an-editable-source-aseprite)). `pick` refuses a source outside the library's root.
- **Records are text** (`text eol=lf`, union-merged where two branches can append), so they diff and merge like code.

Assetgrove never runs `git add` or `git commit`. You commit what it writes, as any other change.

## 2. Three ways in

### `fern`: generated by a model

[`fern.json`](examples/launch/fern.json) asks for one still. Forecast it for free, then generate (paid, on your own provider key):

```sh
assetgrove plan --spec fern.json --bible .assetgrove/art-direction/BIBLE.md \
  --profile .assetgrove/profile.json --out .assetgrove/runs/fern-plan.json --dry-run
assetgrove plan --spec fern.json --bible .assetgrove/art-direction/BIBLE.md \
  --profile .assetgrove/profile.json --out .assetgrove/runs/fern-plan.json
assetgrove apply .assetgrove/runs/fern-plan.json
assetgrove pick --run .assetgrove/runs/<run> --candidate c1 --target .
```

A person confirms the spend and picks the candidate; an agent can plan and generate but never picks ([README](../README.md#use-from-a-coding-agent)). The provenance records every call: model, route, prompt, parameters, reference hashes, request ID, time, cost, the provider's terms and the output grant.

### `mole`: drawn by a person

The mole's walk cycle is a person's Aseprite file with a `walk` tag on a 32 × 32 canvas, kept in the library at `game/assets/mole/mole.aseprite`. [`mole-walk.json`](examples/launch/mole-walk.json) names the family. `stage-source` renders the tag into a strip with no model call and no spend:

```sh
assetgrove stage-source --source game/assets/mole/mole.aseprite --spec mole-walk.json \
  --profile .assetgrove/profile.json --digital-source-type digitalCreation
assetgrove pick --run .assetgrove/runs/<run> --candidate c1 --target .
```

An `.aseprite` file carries no source type, so the person declares it: `--digital-source-type digitalCreation` is recorded in the provenance with who declared it, and the card's `origin` reads `human-made`. Without the flag the strip stays `undeclared`, and `pick` refuses to hand it off. Assetgrove never infers human authorship from a file or a tool name.

### `beetle`: from a third party

The beetle is a contact sheet from an outside pack. [`beetle.origin.json`](examples/launch/beetle.origin.json) records what the supplier says, verbatim:

```json
{
  "kind": "third-party",
  "evidence": "Synthetic example: the pack's page states the sheet was drawn by hand and is released under CC BY 4.0, crediting \"Example Artist\".",
  "source": "https://example.test/packs/garden-bugs/beetle-sheet.png",
  "license": "CC-BY-4.0"
}
```

```sh
assetgrove import --sheet art/beetle-sheet.png --profile .assetgrove/profile.json --asset beetle \
  --tool "third-party pack" --origin beetle.origin.json --digital-source-type digitalCreation \
  --frames 16 --no-propose
assetgrove write-families --import .assetgrove/imports/<import> --target .
```

`--no-propose` skips the grouping model, so a clean sheet needs no key. You write the grouping (`grouping.json`, status `confirmed`) yourself before `write-families`, and confirm the write ([sheet-import.md](sheet-import.md#what-each-step-does)). A third-party origin does not assert who made the art, so the source type is declared separately, and only because the supplier's statement says the sheet was drawn by hand; with no such statement, leave it out and the sheet stays `undeclared`, which no hand-off accepts.

## 3. Review

Every hand-off writes the asset's review state as `pending`. Picking is not approving.

```sh
assetgrove review game/assets/mole/mole-walk.md --comment "paw lifts late on frame 3" --frames 3
assetgrove library worklist --open
assetgrove approve game/assets/mole/mole-walk.md
```

`review` appends a note (anchored, here, to one frame of the exact version), `library worklist` lists the open ones, and `approve` records a person's approval with its confirmation; under headless settings it exits 8 and waits for a person ([library.md](library.md#review-actions)). Notes and approvals are annotations in `mole-walk.review.json`, so a reviewer sees them in the pull request with the media. `library diff` compares versions and reviews between commits ([library.md](library.md#reviewing-committed-library-changes)).

## 4. Provenance and a person's edit

A person touches up `fern`'s leaves in an image editor, over `game/assets/fern/idle.png`. Before editing, keep a copy of the generated version (here `../fern-v1.png`); then adopt the edit as the asset's next version:

```sh
assetgrove library adopt game/assets/fern/fern-idle.md --original ../fern-v1.png
```

A person confirms it as they confirm a pick. The new version's provenance keeps every generation call of v1 and adds a `human-edit` step with both pixel hashes. Its source type becomes `compositeWithTrainedAlgorithmicMedia`, and its C2PA content credentials record the generated original as a `parentOf` ingredient, then the edit ([disclosure.md](disclosure.md#content-credentials)). A hand edit of generated art stays AI-derived: the card's `origin` stays `ai-generated`.

What each asset now carries:

| Where                     | What                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<media>.provenance.json` | Calls, route, prompt, parameters, reference hashes, request IDs, cost, provider terms and their date, output grant, transform steps, source-type declaration, how the pick was confirmed          |
| The media file            | The IPTC digital source type and models (XMP), and signed C2PA content credentials for PNG, JPEG and WebP                                                                                         |
| `<assetId>.md` (the card) | `origin` (`ai-generated`, `human-made`, `third-party` or `unknown`), the supplied evidence, source and licence, `state`, `version`, `license` and `lock`                                          |
| `<assetId>.review.json`   | Every version by sha256, every note, request, resolution and approval                                                                                                                             |
| `assets/manifests/…json`  | The file the game reads: the fragment's `source` gives the IPTC digital source type and, for third-party art, the supplier's origin record (`init`'s template would call every asset `generated`) |

## 5. Licence records

Two different things are recorded, and neither is legal advice:

- **A model's output grant.** Each route in the developer settings declares the grant its provider's terms give (`outputGrant`: licence, plan, commercial, relabel, attribution). Every call records it, and hand-off refuses (exit 7 `license_refused`) an output whose grant the target's `license` and `acceptedLicenses` do not cover. A route with no declared grant cannot hand off at all ([decisions.md](decisions.md#provider-output-grants)). These are terms recorded as of a date, not a licence Assetgrove grants.
- **A supplier's licence.** The `license` in an origin record (`CC-BY-4.0` for `beetle`) is kept verbatim in the import, the provenance and the card. It is evidence of what the supplier said. It does not prove ownership or commercial permission, and Assetgrove does not check it against `acceptedLicenses`. Meeting its terms, such as CC BY's credit line, is yours.

The style bible's `referenceLicense` records the terms of the reference images it lists ([target-profile.md](target-profile.md#style-bible)).

## 6. Godot import

The pack was set up in section 1. With `godot:sprite-frames` in the profile's `handoff`, every `pick`, `write-families` and `library adopt` above also builds `game/characters/<assetId>.tres`: Godot 4.7.2, headless in a scratch project, imports the strips, builds one SpriteFrames per asset with an animation per family, saves it with `ResourceSaver` and loads it back. Assetgrove writes no Godot resource by hand, so the UIDs in the `.tres` match the `.import` files Godot made. Running Godot is a command a person approves once ([the pack's README](../packages/assetgrove-godot/README.md#what-a-hand-off-runs)).

In the Godot project:

- New strips get the `.import` options the preset names (lossless, no mipmaps here); an existing `.import` is never touched, so a replaced strip keeps its UID.
- A re-export keeps the animations and settings a developer added in Godot, and refuses (exit 6, `conflict:`) to overwrite a family animation the developer edited.
- Before a pick replaces a version, its confirmation lists the scenes and resources that use the asset (`details.usage`).
- A pixel-art profile warns when `project.godot` leaves the default texture filter at Linear. The pack never edits `project.godot`.

Check the project's hygiene at any time, read-only and with no Godot:

```sh
assetgrove doctor --profile .assetgrove/profile.json --target .
```

It reports orphan and duplicate UIDs, a tracked `.godot/` cache and text resources stored in Git LFS, each with a correction for you to make ([the pack's README](../packages/assetgrove-godot/README.md#the-doctor)).

## 7. Routes and where your data goes

A route is the provider and model that serves one operation (`still`, `edit`, `vision`, `decisions` and the rest). Routes come only from your developer settings, one file per user outside every repository ([settings.md](settings.md#roles-and-routes)): no shared file, plan or run option can choose one. So where data goes is your choice, and `init` lists it: its `providers` field gives, for each routed operation, the provider, the host it reaches, the model vendor behind a gateway route (`upstream`), the terms recorded and `retention` (`local` for a loopback or scripted provider; otherwise not recorded, because Assetgrove cannot know what a provider keeps).

| Route                                         | Where its data goes                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Vercel AI Gateway (`vercel-ai-gateway`)       | `ai-gateway.vercel.sh`, then the model's vendor (`openai` for `openai/gpt-image-2`; `init` names it) |
| OpenAI or Anthropic direct                    | `api.openai.com` or `api.anthropic.com`                                                              |
| Tripo (3D)                                    | `api.tripo3d.ai`                                                                                     |
| `openai-compatible` at a loopback `baseURL`   | Your own machine. With `"free": true` it is never billed ([models.md](models.md#local-only-recipe))  |
| `openai-compatible` at another `baseURL`      | The host you name                                                                                    |
| A pack's adapter, such as `local-style:image` | The endpoint its settings name; `local-style` takes loopback only ([local-style.md](local-style.md)) |

What a route receives: the prompt Assetgrove composes from the spec and the style bible, the bible's reference images, and, for vision and decision operations (QA verdicts, grouping, card descriptions), the candidates or assets themselves. Providers may retain what they receive under their own terms.

What sends nothing to any provider: `stage-source`, `import --no-propose` on a clean sheet, `write-families`, `pick`, `review`, `approve`, `library adopt`, `op` and `recipe`, `doctor`, `disclosure` and every read of the library. In this walkthrough only `fern`'s generation called a model. The Godot pack talks to no provider: setup downloads Godot once from Godot's GitHub release, and each hand-off runs Godot on your machine, whose editor writes its own settings and caches to your user folders.

A fully local setup routes `image`, `vision`, `decisions` and `planning` to loopback servers ([models.md](models.md#local-only-recipe)). With a coding agent, keep the provider hosts out of the agent's shell sandbox and the keys in the MCP server's environment ([keys.md](keys.md)).

## 8. Disclosure, and what it cannot promise

```sh
assetgrove disclosure game/assets --out disclosure.md
```

`disclosure` summarises the library: assets by kind and source type, models, providers, the vendors behind gateway calls, provider terms with their dates, content credentials, and draft text for Steam's AI content survey and itch.io's AI disclosure ([disclosure.md](disclosure.md)). `--selected` limits it to the files in a release. For Demo Garden it counts `fern` as AI-made (a composite after the edit) and `mole` and `beetle` as declared digital creations.

Know its limits before you rely on it:

- **It is not a compliance claim.** The marks and the summary help people see what was made with AI. What a law or a store asks of your game is a question for a lawyer, and the store text is a draft to check against the form as the store shows it.
- **Marks do not survive everything.** PNG, JPEG and WebP carry an XMP mark and signed C2PA credentials; glTF, GLB and KTX2 carry the XMP mark only; other formats carry none. Godot converts imported textures into its own formats under `.godot/imported/`, and an exported game ships those, so do not expect a mark in a build. The provenance record in the repository is the source of truth.
- **The XMP mark is unsigned**, so anyone can rewrite it; the C2PA credentials break when the pixels change. Signed with Assetgrove's local development certificate, they are trusted by no C2PA trust list; name a certificate from a recognised authority in `contentCredentials` before release ([settings.md](settings.md#content-credentials)).
- **Declarations are claims.** `human-made`, `third-party` and `digitalCreation` record what a person or supplier said; Assetgrove does not verify them. An embedded AI source type wins over a conflicting human-made declaration. An unclassified file stays `unknown` and `undeclared`, never assumed human-made, and a `disclosure --selected` release summary lists it as `unresolved`.
- **Prompts are in the record.** No prompt is written into a media file or the summary, but each provenance record holds the prompt. If your game repository is public, so are its prompts and reference hashes.
- **The prompt policy is best-effort.** It refuses prompt text that names a real artist, studio, game, character or person; it cannot police reference images or a model's training data ([prompt-policy.md](prompt-policy.md)).
- **AI output may not be protected by copyright** where you live, and what you may do with it depends on the model's terms, which Assetgrove records but does not change.

## Where next

- Commands, their spend and what they write: [the command reference](../skills/assetgrove/references/commands.md).
- Working through a coding agent: [quick-start.md](quick-start.md) and the skills under `skills/`.
- Tile sets and 3D characters in Godot: [the Godot pack's README](../packages/assetgrove-godot/README.md).
