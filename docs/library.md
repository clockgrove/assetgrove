# The library: cards, review records, indexes and logs

A game's library is an Open Knowledge Format (OKF 0.2) bundle in its repository. Git is the record: cards, review records, indexes and logs are files beside the media. Provenance and review records are the records; a card's machine fields, `index.md` and `log.md` are projections rebuilt from them.

The modules under `src/library/` read, validate and write these files.

| File                      | Module                  | What it holds                                  |
| ------------------------- | ----------------------- | ---------------------------------------------- |
| `<assetId>.md`            | `src/library/card.ts`   | The asset's card: YAML front matter and a body |
| `<assetId>.review.json`   | `src/library/review.ts` | A W3C Web Annotation `AnnotationCollection`    |
| `index.md`, `log.md`      | `src/library/folder.ts` | Each folder's listing and history              |
| any path read from a file | `src/library/paths.ts`  | The library path rule                          |
| media                     | `src/library/lfs.ts`    | Media reads that understand Git LFS pointers   |

## The path rule

Every path Assetgrove reads from a card, a review record or an index or log row must resolve inside the library root, with symlinks resolved; otherwise the read exits 2 `invalid_input`. Paths use `/`. An absolute path, a drive letter, a URL scheme (a `:` before the first `/`), a `\` or a NUL is refused. A shared card therefore cannot point Assetgrove at a file elsewhere on the machine. The card's `bible` source is written for other readers and is never followed.

## Media and Git LFS

A media file that is a Git LFS pointer (spec v1: `version`, `oid sha256:<64 hex>`, `size`) counts as present. Its oid is the media's sha256 and is compared with the expected one (`lock.sha256`). Its bytes come from `<git dir>/lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>` when that object is local and its size and hash match the pointer; the git directory is the nearest `.git` at or above the file, following a `gitdir:` file and a worktree's `commondir`. Otherwise the read reports a pointer with no bytes. A file that looks like a pointer (it starts with the spec's `version` line) but fails the strict parse is refused with exit 2 `invalid_input`. Assetgrove never runs `git lfs`, never fetches, and never returns pointer text as media.

## Cards

A card is `<assetId>.md` beside the media, format `assetgrove-card/1`:

```markdown
---
type: Game Asset
format: assetgrove-card/1
title: Porch lantern
description: A brass lantern for the porch, lit.
resource: lantern-porch.png
tags: [prop, light]
generated: { by: "assetgrove/0.2.0 via openai:gpt-image-2", at: "2026-11-20T21:04:00Z" }
verified:
  - { by: "process:assetgrove-qa", at: "2026-11-20T21:04:30Z" }
  - { by: "human:developer", at: "2026-11-20T21:10:00Z", method: elicitation }
sources:
  - { id: provenance, resource: lantern-porch.png.provenance.json }
  - { id: review, resource: lantern-porch.review.json }
  - { id: bible, resource: ../BIBLE.md }
kind: still
subject: lantern
state: approved
version: 2
bible: "3"
license: CC-BY-4.0
lock: { sha256: "<64 hex>", bible: "3" }
---

Used beside the front door; the glow should match the window light.
```

Required: `type` (`Game Asset`), `format`, `title` and `resource`. The format line is read through `readFormat`, so a missing, unknown or newer one exits 2 `format_unsupported`.

**Machine fields** are rebuilt from the records on every write, in this order:

| Field       | Value                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`      | `Game Asset`                                                                                                                                                                                |
| `format`    | `assetgrove-card/1`                                                                                                                                                                         |
| `resource`  | the media file, beside the card                                                                                                                                                             |
| `generated` | `by`: `assetgrove/<version> via <provenance route>`; `at`: provenance `finishedAt`                                                                                                          |
| `verified`  | `process:assetgrove-qa` at `finishedAt`; the current version's pick: `human:developer` with its confirmation method, or `process:headless:<operator>`; each approval of the current version |
| `sources`   | `provenance` and `review` records, and the `bible` (never followed)                                                                                                                         |
| `kind`      | the asset's kind                                                                                                                                                                            |
| `subject`   | the bible subject                                                                                                                                                                           |
| `state`     | the current version's status: `approved`, `rejected`, `changes-requested` or `pending`                                                                                                      |
| `version`   | the current version's position in the stack                                                                                                                                                 |
| `bible`     | provenance `bibleVersion`                                                                                                                                                                   |
| `license`   | provenance `license` (SPDX spelling, as in provenance)                                                                                                                                      |
| `lock`      | `sha256` of the current version's media, and the bible version                                                                                                                              |

**Person fields** are `title`, `description`, `tags`, the body and every field Assetgrove does not own. They are set at the first pick and then kept; unknown fields are kept, as OKF requires.

A card parsed and written again is byte-identical. A machine-field rewrite replaces only the top-level entries of machine fields, appends missing ones in the order above and drops ones that no longer apply; every other entry, comments included, and the body keep their bytes. Rewriting a card that already matches its records changes nothing.

## Review records

A picked asset has `<assetId>.review.json` beside it, format `assetgrove-review/1` (in `ag:format`), a W3C Web Annotation `AnnotationCollection`:

```text
{
"@context": ["http://www.w3.org/ns/anno.jsonld",{"ag":"https://github.com/clockgrove/assetgrove/ns/review#"}],
"id": "asset://my-game/lantern-porch/review",
"type": "AnnotationCollection",
"ag:format": "assetgrove-review/1",
"ag:versions": [
{"sha256":"<64 hex>","at":"2026-11-20T21:10:00Z","candidate":"2","confirmation":{"digest":"…","method":"elicitation"},"run":"r-…"},
{"sha256":"<64 hex>","answers":["#c41a09e2d7f3b815"],"at":"2026-11-22T09:00:00Z","candidate":"1","confirmation":{"digest":"…","method":"tty"},"run":"r-…"}
],
"first": { "type": "AnnotationPage", "items": [
{"id":"#c41a09e2d7f3b815","body":[{"purpose":"editing","type":"TextualBody","value":"tail tip darker"}],"created":"2026-11-21T08:00:00Z","motivation":"editing","target":{"ag:frame":3,"ag:version":"<64 hex>","selector":{"conformsTo":"http://www.w3.org/TR/media-frags/","type":"FragmentSelector","value":"xywh=percent:25,10,12.5,12.5"},"source":"lantern-porch.png"},"type":"Annotation"}
] }
}
```

**Layout.** The header lines (`@context`, `id`, `type`, `ag:format`, then any other top-level member, one per line) and the footer lines are fixed. Each version and each annotation is one line of canonical JSON, versions with `sha256` first and annotations with `id` first, the other keys sorted. Versions are sorted by `at`, annotations by `created`, then by sha256 or id. Readers take strict JSON, or else read line by line: a missing, extra or doubled comma between item lines is tolerated and a duplicated line counts once. So two branches that each appended a line merge with Git's union driver into a file that reads as the union of both, and the canonical rewrite is strict JSON again.

**Versions** (`ag:versions`) are identified by their media `sha256`. A version's number `n` is its position in the stack (by `at`, then sha256), never stored. Members: `sha256`, `at` (ISO-8601 UTC), optional `provenanceSha256`, `run`, `candidate`, `answers` (the ids of the `editing` annotations it answers, each present in the record) and `confirmation` (`method`, `digest`, and `operator` when `method` is `headless`). Which version answered a request is recorded only here.

**Annotations.** An id is `#` and the first 16 hex of the sha256 of the annotation's canonical JSON without `id`, so the same content always has the same id; a record whose id does not match its content is refused. Members Assetgrove writes:

- `type`: `Annotation`; `created`: ISO-8601 UTC.
- `motivation`: `commenting` and `replying`; `assessing` for decisions, with `ag:action` `approve` or `reject`; `editing` for change requests; `describing` and `tagging` for card edits, optionally with `ag:action: "card-edit"`; `moderating` for Assetgrove's other actions, with `ag:action` `pick`, `replace`, `answer`, `card-edit`, `adopt` or `resolve`. A `resolve` names the request it closes in `ag:resolves`. An approval may carry `ag:confirmation` (`method`, `digest`).
- `body`: one or more `TextualBody` (`value`, `purpose`, `format`, `language`) or `SpecificResource` (`source`, `purpose`).
- `target`: a source path, or `{source, ag:version, ag:frame, ag:view, ag:mask, selector}`. `ag:version` is the version's sha256; `ag:frame` and `ag:view` are non-negative integers; `ag:mask` is a path. `selector` is a `FragmentSelector` conforming to `http://www.w3.org/TR/media-frags/` with an `xywh=` box in pixels (`xywh=` or `xywh=pixel:`) or percent (`xywh=percent:`, inside 0 to 100). Assetgrove writes percent boxes so they fit a version of another size.

Masks and references a request names live in `<assetId>.review/<sha256>.<ext>`, so a record names only paths inside the library root; every target source, mask and `SpecificResource` source is checked by the path rule. A resolution is a new annotation; past lines are never rewritten. Readers keep members they do not know.

**Status.** A version's status is its latest `assessing` annotation (`approved` or `rejected`). Without one it is `changes-requested` while an `editing` annotation targets it that no version answers and no `resolve` names, else `pending`. The card's `state` is the current (last) version's status.

## Folder index

`index.md` sits in every folder from the library root to each card. The root index carries OKF front matter:

```markdown
---
okf_version: 0.2
type: Asset Library
game: my-game
---

# my-game

## Folders

- [props/](props/index.md)

## Assets

- [Porch lantern](lantern-porch.md): A brass lantern for the porch, lit.
```

Other folders have no front matter. Folders are listed first, then assets by id; a section with nothing in it is left out. Both lists are sorted by code unit, so the same records render the same bytes in any order. Titles and descriptions are card text, which is shared: newlines fold to a space and `\`, `[`, `]`, `<`, `>` and `|` are escaped with a backslash, and each link target is percent-encoded per segment, so card text cannot forge a link. Readers merge duplicated headings and rows left by a union merge, and every row's target is checked by the path rule.

## Folder log

`log.md` sits in every folder that holds cards. It is OKF's history file, newest first under UTC `## YYYY-MM-DD` headings:

```markdown
# Log

## 2026-11-22

- 09:00:00Z answer [Porch lantern](lantern-porch.md): version 2; tail tip darker
- 08:10:00Z bible 2 → 3

## 2026-11-20

- 21:10:00Z pick [Porch lantern](lantern-porch.md): version 1
```

Each line is rendered from an annotation carrying `ag:action` (other than `resolve`): `pick`, `replace`, `approve`, `reject`, `answer`, `card-edit` or `adopt`, with the version number and the first text body as detail. A hand edit has no annotation and is never logged. The root log also carries one `bible <old> → <new>` line per style bible change. Lines within a day sort by time, then text; duplicated headings and lines from a union merge collapse when the log is normalised.

## Writes

`pick`, `write-families` and the 3D hand-off (which runs through `pick`) write the library after every hand-off preset check passes and before the target's validator runs ([target-profile.md](target-profile.md#library) sets the root, the game id and whether logs are kept).

- **Asset id.** The spec's `assetId`, or `<assetId>-<animationFamily>` when the spec names an animation family, since each family is its own strip. The card and review record sit beside the media. Before anything is written, an id of `index`, `log` or a view name (`by-kind`, `by-subject`, `by-tag`, `stale`, `runs`, `find`, `like`, `where`, in any case) exits 2 `asset_id_reserved`, and an id already carded in another folder of the library exits 2 `asset_conflict`. Media outside the library root, or an existing card or review record of the asset that does not parse or names a path outside the root, exits 2 `invalid_input`.
- **One lock.** The whole hand-off holds the library write lock, `assetgrove/library.lock` in the repository's common Git directory (`.git/assetgrove/library.lock`), an exclusive create holding the pid, taken over from a dead process like a run's lock. A second writer while a live process holds it exits 2 `run_in_progress`. A target outside any Git repository locks a file under `<stateDir>/library-locks/` instead.
- **Atomic files.** Every file, media included, is written to a temporary file in its own folder and renamed over the target.
- **Order.** The media and the hand-off's other files, the provenance, then the review record, which is the commit point: the version exists once its entry is written. Then the card, each `index.md` from the library root down, and the folder's `log.md`.
- **Versions.** The version is appended to `ag:versions` with its `sha256`, `provenanceSha256` (when provenance is its own file), `run`, `candidate`, `at` and `confirmation` (`method`, `digest`, and `operator` when headless), with a `moderating` annotation whose `ag:action` is `pick` for the first version and `replace` for a later one. A later hand-off into the same asset id replaces the media at the same path and appends a version; the card's machine fields follow the new version and its person fields and body are kept.
- **Candidate annotations.** The candidate's record, `<run>/reviews/<candidate>.review.json` (for `write-families`, `<import>/reviews/<family>.review.json`), when present, is carried into the asset's record: each object target's `source` becomes the media file and its `ag:version` the new version, replies and resolutions follow the ids they name, and each mask or linked file is copied to `<assetId>.review/<sha256>.<ext>`.
- **Card.** The first hand-off sets the person fields from the spec's `fields`: `title` (else the asset id), `description` and `tags`. The `provenance` source is the provenance file, or the manifest that embeds it, when that lies inside the library root.
- **Indexes and log.** Every `index.md` from the root to each card is regenerated from the cards found under the root (dot folders, `node_modules` and `<id>.review` folders are skipped); one whose text is unchanged is not rewritten. The folder's `log.md` is rendered from the review records of the cards in it. The root log keeps its `bible` lines and gains one when the bible version is newer than its latest bible line, or, without one, than the newest bible any card already recorded. `library.log: false` writes no log.
- **Completing a half-finished hand-off.** Re-running the same pick completes it. If the record lacks the version it is appended; if it has it, nothing is appended and only the card, indexes and log are rewritten. Nothing is counted twice.

## Merges

`index.md`, `log.md` and `*.review.json` are meant for Git's union merge driver, so two branches that write into one folder never conflict; the readers above accept what that driver produces.
