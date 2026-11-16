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

A media file that is a Git LFS pointer (spec v1: `version`, `oid sha256:<64 hex>`, `size`) counts as present. Its oid is the media's sha256 and is compared with the expected one (`lock.sha256`). Its bytes come from `<git dir>/lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>` when that object is local and its size and hash match the pointer; the git directory is the nearest `.git` at or above the file, following a `gitdir:` file and a worktree's `commondir`. Otherwise the read reports a pointer with no bytes. A file that looks like a pointer (it starts with the spec's `version` line) but fails the strict parse is refused with exit 2 `invalid_input`. Reading media never runs `git lfs`, never fetches, and never returns pointer text as media.

**Setup (`init`).** `init` needs a Git work tree (else exit 2 `git_required`, nothing written) and runs `git lfs version`; a missing Git LFS is a `needs-person` step naming the install, and missing LFS hooks give a `git lfs install` step for the person to run. It writes one marked block (`# BEGIN assetgrove` … `# END assetgrove`) in `<library.root>/.gitattributes`, never in the repository root; a second run changes nothing, and lines outside the block are kept:

- `filter=lfs diff=lfs merge=lfs -text` for `*.png`, `*.jpg`, `*.jpeg`, `*.webp`, `*.gif`, `*.glb` and `*.ktx2`;
- `text eol=lf` for `*.md`, `*.review.json` and `*.provenance.json`, so cards, indexes, logs and records are byte-identical on every system;
- `merge=union` for `index.md`, `log.md` and `*.review.json`, so two branches that each append a line merge and keep both.

The `notice.lfs-metering` step says the Git host meters LFS storage and bandwidth, with the size of the LFS objects committed under the library root. `init` never commits, migrates history or runs `git lfs install`.

**Pick.** `pick` asks Git, not `.gitattributes`: a target outside a work tree exits 2 `git_required`, and media (and image sidecars) whose `git check-attr filter` is not `lfs` exits 2 `lfs_required`, both before any write. Assetgrove never runs `git add` or `git commit`.

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

**Stamps order the record.** A version's `at` and an annotation's `created` are order stamps: each writer stamps what it appends with its clock, or 1 ms after the latest `at` or `created` already in the record when that is later, read under the lock that guards the record. So a pick, adopt, review, approve or card edit that succeeds is the record's latest entry afterwards, even when another machine whose clock was ahead wrote the entry before it; a stamp can read later than the writer's own clock. Two branches' records merged by union still sort by stamp, then sha256 or id, into one order, and `library rebuild` brings the card's machine fields in line with it.

**Versions** (`ag:versions`) are identified by their media `sha256`. A version's number `n` is its position in the stack (by `at`, then sha256), never stored. Members: `sha256`, `at` (ISO-8601 UTC), optional `provenanceSha256`, `contentSha256` (the media's sha256 before its C2PA content credentials were signed in), `run`, `candidate`, `answers` (the ids of the `editing` annotations it answers, each present in the record) and `confirmation` (`method`, `digest`, and `operator` when `method` is `headless`). Which version answered a request is recorded only here.

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

Each line is rendered from an annotation carrying `ag:action` (other than `resolve`): `pick`, `replace`, `approve`, `reject`, `answer`, `card-edit` or `adopt`, with the version number (an `adopt` line carries it too) and the first text body as detail. A hand edit has no annotation and is never logged. The root log also carries one `bible <old> → <new>` line per style bible change. Lines within a day sort by time, then text; duplicated headings and lines from a union merge collapse when the log is normalised.

## Writes

`pick`, `write-families` and the 3D hand-off (which runs through `pick`) write the library after every hand-off preset check passes and before the target's validator runs ([target-profile.md](target-profile.md#library) sets the root, the game id and whether logs are kept).

- **Asset id.** The spec's `assetId`, or `<assetId>-<animationFamily>` when the spec names an animation family, since each family is its own strip. The card and review record sit beside the media. Before anything is written, an id of `index`, `log` or a view name (`by-kind`, `by-subject`, `by-tag`, `stale`, `runs`, `find`, `like`, `where`, in any case) exits 2 `asset_id_reserved`, and an id already carded in another folder of the library, or carded in the same folder for another media file, exits 2 `asset_conflict`. A spec whose plain `assetId` equals another spec's joined `<assetId>-<animationFamily>` is therefore refused rather than sharing its card. Media outside the library root, or an existing card or review record of the asset that does not parse or names a path outside the root, exits 2 `invalid_input`.
- **One lock.** The whole hand-off holds the library write lock, `assetgrove/library.lock` in the repository's common Git directory (`.git/assetgrove/library.lock`), an exclusive create holding the pid, taken over from a dead process like a run's lock. A second writer while a live process holds it exits 2 `run_in_progress`. A library outside any Git repository locks a file under `<stateDir>/library-locks/` named for the library root's real path instead, the same file `review`, `approve`, `card edit` and `library rebuild` lock, so those writers exclude each other there as they do inside Git.
- **Atomic files.** Every file, media included, is written to a temporary file in its own folder and renamed over the target.
- **Order.** The media and the hand-off's other files, the provenance, then the review record, which is the commit point: the version exists once its entry is written. Then the card, each `index.md` from the library root down, and the folder's `log.md`.
- **Versions.** The version is appended to `ag:versions` with its `sha256`, `provenanceSha256` (when provenance is its own file), `run`, `candidate`, `at` and `confirmation` (`method`, `digest`, and `operator` when headless), with a `moderating` annotation whose `ag:action` is `pick` for the first version and `replace` for a later one. A later hand-off into the same asset id replaces the media at the same path and appends a version; the card's machine fields follow the new version and its person fields and body are kept. Media identical to an older version (not the current one) exits 2 `version_exists` before any write: a version is identified by its sha256, so it cannot be appended twice. A signed image is new bytes each time it is signed, so media whose `contentSha256` (the bytes before signing) is an older version's also exits `version_exists`.
- **The pick form.** A `pick` into an asset that already has a version names that version (number and sha256) in its form, and its sha256 goes into the pick's digest, so a stored confirmation does not outlive a new version. When the working media differs from the card's `lock.sha256` (a Git LFS pointer's oid counts as its bytes), the form warns that replacing it discards an outside change. If the current version is no longer the one the pick confirmed replacing by the time it writes, it exits 2 `version_changed` before any write: the check runs again once the library write lock is held, so of two picks prepared against the same version the second to commit writes nothing. `write-families` has no pick form and compares nothing.
- **Candidate annotations.** The candidate's record, `<run>/reviews/<candidate>.review.json` (for `write-families`, `<import>/reviews/<family>.review.json`), when present, is carried into the asset's record: each object target's `source` becomes the media file and its `ag:version` the new version, replies and resolutions follow the ids they name, and each mask or linked file is copied to `<assetId>.review/<sha256>.<ext>`.
- **Card.** The first hand-off sets the person fields from the spec's `fields`: `title` (else the asset id), `description` and `tags`. The `provenance` source is the provenance file, or the manifest that embeds it, when that lies inside the library root.
- **Indexes and log.** Every `index.md` from the root to each card is regenerated from the cards found under the root (dot folders, `node_modules` and `<id>.review` folders are skipped); one whose text is unchanged is not rewritten. The folder's `log.md` is rendered from the review records of the cards in it. The root log keeps its `bible` lines and gains one when the bible version is newer than its latest bible line, or, without one, than the newest bible any card already recorded. `library.log: false` writes no log.
- **Completing a half-finished hand-off.** Re-running the same pick completes it. If the record lacks the version it is appended; if it has it, nothing is appended and only the card, indexes and log are rewritten. Nothing is counted twice.

## Commands

`library check`, `library rebuild`, `library stats` and `library drift` (`src/library/maintain.ts`, `src/commands/library.ts`) take `--target` and `--profile` (default `<target>/.assetgrove/profile.json`).

- **`library check`** (read-only) reports `problems: [{file, code}]` (files relative to the library root) and exits 6 `library_check_failed` when there are any: `card_missing`, `card_invalid`, `review_missing`, `review_invalid`, `media_missing`, `media_not_lfs` (`git check-attr filter` is not `lfs`; skipped outside a Git repository), `machine_field_mismatch`, `provenance_unrecorded` (the provenance the card names, a file of its own or a manifest that embeds it, carries a `human-edit` step made on the current version: it describes an adopted edit no version records), and `index_*` or `log_*` with `missing`, `mismatch` or `invalid`. Indexes and logs are compared after normalising order and duplicate headings and rows; review records are compared after reading them as the union of their lines. A file that holds the same content in another layout (a union merge, a non-canonical review record) is listed under `needsRebuild` and is not a problem. `kind` and `subject` have no record besides the card, so they are kept from it.
- **`library rebuild`** rewrites machine fields, every `index.md` and `log.md` and the canonical layout of review records under the library write lock, then checks again; a second run changes nothing. The root log's `bible` lines are read from the existing file and kept, so a root log deleted with its bible lines cannot get them back.
- **`library stats`** gives counts by `kind` and `state`, and `changeRequests`: `total`, `approvedWithinTwoVersions` and their `share`. A change request counts when one of the next two versions after the one it targets is approved.
- **`library drift`** lists `stale` assets (the card's `bible` is older than the style bible's `version`, read from `--bible`, default `<target>/.assetgrove/art-direction/BIBLE.md`) and `modified` ones (the file's sha256, or a Git LFS pointer's oid, differs from `lock.sha256`; a matching pointer is not modified). It is computed from the cards and stores nothing.
- **`library adopt`** is described under [Review actions](#review-actions).

## The asset tree

The library is served as `asset://<game>/` addresses, read by one resolver (`src/tree/`): the MCP server's resources (`resources/read`) and the commands `ls` and `cat` (tools `ls`, `cat`) return the same documents. The tree serves the project at `--target` (`mcp`, `ls`, `cat`), or the working directory's Git top level: its `.assetgrove/profile.json`, the profile `init` writes, names the game and library root, and its runs are `.assetgrove/runs`. Reading never picks, spends, edits or waits on a write.

```text
asset://<game>/                          views, counts and the root index.md
  by-kind/<kind>/  by-subject/<subject>/  by-tag/<tag>/  stale/
  runs/  runs/<run>/  runs/<run>/<candidate>
  <asset>/                               the asset's files and machine fields
  <asset>/card  <asset>/provenance  <asset>/review  <asset>/log
  <asset>/image  <asset>/image/full
  <asset>/versions/  <asset>/versions/<n>
```

- **Assets by id.** An asset is found by its card's id (`<id>.md`), wherever its folder; its media, provenance and review record are the paths its card names, each checked by the path rule. A card naming a path outside the library root makes every read of the asset exit 2 `invalid_input`.
- **Folders.** Every folder address returns a JSON document `{address, kind: "folder", children: [{address, name, kind, state?}], next?}` with at most 200 children per read, sorted by name (the root lists its five views first); `next` is the folder address with `?after=<last name>`. The game root carries `counts` and, after the JSON, the root `index.md` as Markdown. A card whose id is a view's name (`by-kind`, `by-subject`, `by-tag`, `stale`, `runs`) has no address of its own, so the tree leaves it out and the root lists it under `reserved`. A view lists asset folders by their own address. `stale/` holds the assets `library drift` calls stale: those whose card's bible is older than the style bible's version (`.assetgrove/art-direction/BIBLE.md`). A run folder lists each staged candidate (`staged` or `picked`) and each one QA filtered out (`rejected`, `c<n>`).
- **Card text.** In JSON documents card text (`title`, `description`, the body) appears only under `sharedText: [{source, text}]`, with `source` `card.title`, `card.description` or `card.body`. The asset folder's `asset` holds the card's machine fields and tags.
- **Files.** `card` and `log` (the asset's own lines, rendered from its review record) are Markdown; `provenance` and `review` are the records' JSON; `image` is a PNG thumbnail of at most 512 px, a strip's key-frame row, or for a 3D asset `{path, frames}` with a row of its turntable renders; `image/full` is the file. `versions/<n>` is the version record (its number, sha256, time, run, candidate, confirmation, status and whether it is current) with a thumbnail when the bytes are the working file's, a run candidate's or in the local Git LFS store (`image` says which), and none otherwise. `runs/<run>/<candidate>` is the candidate's QA reasons and cost, with its thumbnail.
- **Size.** A read's encoded content (text bytes, base64 for images) stays at or under 64 KB. A thumbnail shrinks until it fits; content that cannot is replaced by `{address, kind: "file", path, mediaType, bytes, tooLarge: true, limit}`. `cat --out <file>` writes the whole file; it is CLI only, so the read-only `cat` tool never writes. Thumbnails are cached in `<stateDir>/thumbs/`.
- **Listing.** `resources/list` returns the game root, every folder address and every card address, 200 per page by cursor, so an @-mention finds an asset; `resources/templates/list` names the asset, view and candidate address templates. The search paths (`find/`, `like/`, `where/`) belong to the search package.
- **Live.** The server compares the project's cards, review records and run folders before and after each of its own tool calls (and at each progress update) and sends `notifications/resources/updated` for each changed `<asset>/` (a new version or annotation) and `runs/<run>/` (a staged candidate), on a 2025-era connection only to addresses the client subscribed to; a 2026-era connection's `subscriptions/listen` filter decides. It sends `notifications/resources/list_changed` after a `pick` or `write_families` it served, or when the listing changed. Other changes show at the next read. A refused read answers JSON-RPC `-32602` with `data.code` `invalid_input`.

## Review actions

`review`, `approve`, `library adopt` and `card edit` act on the library's records after a pick. Each takes an address: the asset's card, media or review record. `--version` names a version by number or sha256, the current one by default. A candidate is addressed by its run directory and `--candidate`; its record is read and written holding a lock beside it (`<candidate>.review.json.lock`), and a second annotator waits for it rather than losing its line. The library root and the game are found from the root `index.md`, and the log is written when the folder already has a `log.md`. Each holds the library write lock and ends by rewriting the card, the indexes and the log. Tool results carry annotation and card text only under `sharedText`.

- **Review annotations.** `review` appends one annotation: `commenting` for `--comment`, `replying` for `--reply` with its text in `--comment`, `moderating` with `ag:action` `resolve` for `--resolve`, and `assessing` with `ag:action` `reject` for `--reject`. Existing lines never change. It needs no confirmation.
- **Approve.** A person confirms it with a pick confirmation whose digest body is `{command, asset, card, candidate, version, head}`; `head` is the last annotation's id and the sha256 of the canonical item lines, so a record that gained a line needs a new confirmation. Under headless settings it exits 8 `confirmation_required` and writes nothing. If the record changes between confirming and writing, it exits 2 `plan_changed`. It appends an `assessing` annotation with `ag:action` `approve` and `ag:confirmation`, then rewrites the card's state, `verified` and `lock`. The manifest's `review` stays pending.
- **Library adopt.** For a file a person edited by hand (`src/library/adopt.ts`): `library adopt <address> --original <file>`, or `--asset <id>` in the library of `--target`'s profile. `--original` is the AI-made version whose sha256 is the card's `lock.sha256`. The free QA checks run again on the edited file; the transparency check follows the asset: partial alpha is refused only when the style (`style.alpha.mode`) of the profile of the run or import that made the asset is `binary` (default `soft`), the error naming the rule and the count of pixels, and a fully transparent pixel is required only when the original (the version being replaced) has one; a failure exits 5 `qa_found_nothing`. A person confirms it with a pick confirmation whose digest body is `{command, asset, card, candidate, version, replaces, original, originalSha256, target, run, runRecord, profile, profileSha256, head}`, never under headless settings; the confirmation's summary names the run and the sha256 of the profile that will drive the writes, so a changed run record asks again. `assetgrove confirm` rebuilds it from the card and the original. The edit is then a hand-off of the adopted bytes through `pick`'s path (`src/handoff.ts`), rendered from the run that made the asset: the newest version with a run, whose id must be one path segment (else exit 2), read from `<target>/.assetgrove/runs/<run>` (the record gives the profile, spec, bible version, the candidate's media type and fields and sidecars; a run without the version's candidate exits 2) or, for a family `write-families` handed off, from the import `<target>/.assetgrove/imports/<run>/import.json` (the family's spec and fields, its bounds and palette measured from the edited strip, as `write-families` measures them). A record in neither place exits 2. The hand-off keeps the version's media type: edited bytes that are not that type (a PNG saved over a `.glb`) exit 2, so a GLB, glTF or KTX2 is marked like an image, and a GLB under `profile.model3d` is shaped as at pick. The media is compared with the asset's own file as a real path, so an address through a link or another spelling of the project reaches it. The provenance is the asset's current record (the card's provenance source, else the file or manifest where the profile's layout puts it, inside the library root or not, else the candidate's) with the composite `digitalSourceType`, a `human-edit` step (the original's and the edit's pixel hashes) and the confirmation; the hand-off adds the metadata step, the signer and the validator's command step. The file gets the IPTC mark `compositeWithTrainedAlgorithmicMedia` and C2PA credentials recording `c2pa.opened` of the original (a `parentOf` ingredient) then `c2pa.edited`. Every file the profile's presets write, the manifest included (so `contentHash` names the adopted version, review pending), is rendered again and read back, and the validator runs under pick's rules: only with an approval tied to its exact command (else exit 8 before any write), without keys, its output redacted. Unlike pick, the validator runs before the library, so a rejection records no version. Every file the adopt writes is read before the first write: the hand-off's files and the library's own (the review record, the card, every `index.md` and every `log.md` it rewrites). A file that is absent is new, and one that cannot be read for any other reason (its permissions, a folder in its place) stops the adopt before anything is written, and is left as it is. A file reached through a symbolic link is written through it, so the link stays a link and the bytes the library records are the bytes at the path the game reads. After a failed adopt (a file write, the read-back (exit 6 `handoff_check_failed`), the validator's error or rejection (exit 6 `validator_rejected`), or the library write), every file it wrote holds its earlier bytes and permission bits again and every file it created is gone, with the folders made for it; a file it wrote where a symbolic link pointed at nothing is that link again: the working file holds the person's edit, the manifest, the preset files, the sidecars and the provenance hold what they held before, and the review record, card, lock, indexes and log are as they were, so no version is recorded and no manifest step or provenance describes one. A failure while putting one file back does not stop the others; the error is the one that made the adopt fail, naming each file that could not be put back and why (a rejection's result lists them as `notRestored`). An adopt stopped before it could put them back (a crash) leaves a provenance whose `human-edit` step was made on the current version; a retry drops that step and the commands recorded after it, and `library check` reports the provenance (`provenance_unrecorded`) when the card names it. Otherwise the version is appended with its confirmation, empty `run` and `candidate` and `digitalSourceType`, with a `moderating` annotation whose `ag:action` is `adopt`, and the log line reads `version N`. A Git LFS pointer exits 2, and a file equal to the current version or to an older one exits 2 `version_exists`.
- **Card edit.** Changes the person fields (title, description, tags, the body and fields Assetgrove does not own). Naming a machine field exits 2 `card_field_owned`. A `describing` annotation (`tagging` when only the tags change) with `ag:action` `card-edit` is appended, and its body names the changed fields; the index and log follow.

## Change requests

`request-change` records its request as annotations once the spend is confirmed, before the first provider call. Each region becomes an `editing` annotation on the current version. Its target is `ag:version` with `ag:frame` or `ag:view`, `ag:mask`, and a media-fragment selector in percent, `xywh=percent:`: a pixel box converts through the frame's or the image's size, and stays `xywh=pixel:` only on a 3D view, whose render size the record does not know. Its body is the note, plus a SpecificResource linking each copied reference. `ag:run` names the request's run. The version turns changes-requested.

Masks and references are copied to `<assetId>.review/<sha256>.<ext>` beside the record, so the record does not depend on files outside it.

`pick` of one of the run's candidates answers the request. The version is appended with `answers` naming the requests, and a `moderating` annotation with `ag:action` `answer` and no body is written. Which version answered a request lives only in `ag:versions[].answers`; `log.md`'s `answer` line reads `answers #…` from there. Re-running a pick of the same candidate completes it rather than exiting `version_changed`. A candidate made on an older version exits 2 `version_changed`.

## Merges

`index.md`, `log.md` and `*.review.json` are meant for Git's union merge driver, so two branches that write into one folder never conflict; the readers above accept what that driver produces.
