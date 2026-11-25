---
name: assetgrove-icons
description: Load when an Assetgrove project makes icons, one icon per asset at one size, that must stay readable on set backgrounds. Needs the optional @clockgrove/assetgrove-icons package listed in the developer settings; covers the icons:family kind, its profile block, the icons:boundary-contrast and icons:identifiable checks, auditing a family and its limits.
---

# Assetgrove for icons

`@clockgrove/assetgrove-icons` is a pack: it loads only once a person lists it under `extensions` in the developer settings. It adds the kind `icons:family`: one icon per asset, at one size.

## Set it up

- Install it beside core and list `@clockgrove/assetgrove-icons` in `extensions`.
- Add `kinds["icons:family"]` to the target profile. `size` is the side of a square icon in whole pixels. `backgrounds` is a non-empty list of flat `#rrggbb` colours the icon will sit on. `layout` is optional (`kinds.<kind>.layout`).

```json
{
  "kinds": {
    "icons:family": {
      "size": 32,
      "backgrounds": ["#f4efe1", "#1d2b35"],
      "layout": { "media": "assets/icons/{{spec.subject}}/{{spec.assetId}}.{{output.extension}}" }
    }
  }
}
```

A profile without the block exits 2 `invalid_input` at plan.

## Make an icon

An icon family is the assets that share a `subject`. Name it in each spec:

```json
{ "kind": "icons:family", "assetId": "save-idle", "subject": "save" }
```

Then `assetgrove stage --spec <spec.json> --bible <BIBLE.md> --profile <profile.json>`; add `--dry-run` for the forecast. The pack generates with `icons:still` (role `image`), scales the image to fit `size` × `size`, centred, and applies the profile's alpha and colour rule. It sets no typed call parameters, so any image route works. Routes: settings `routes["icons:still"]` and `routes["icons:identify"]`, else roles `image` and `decisions`.

## Read the checks

- `icons:boundary-contrast` is exact, free and filters. It composites the icon over each background and takes the boundary at `style.alpha.threshold`. It fails when the lowest WCAG contrast ratio, between boundary pixels and their adjacent background, is below 3:1. There is one reason per background, naming it and the ratio truncated to three decimals (2.9996 reads `2.999:1`). An icon with nothing visible at the threshold fails. Do not retry the same image.
- Set `style.alpha.threshold` (128 judges the half-covered edge) or `style.alpha.mode: "binary"` in the profile before you make icons. Under soft alpha the default threshold is 1: the faint edge pixels that scaling to `size` leaves become the boundary, and they fail on every background even for a well-contrasted icon. When the check fails on every background, look at the threshold first; otherwise fix the icon or the backgrounds.
- `icons:identifiable` asks a model, once per background, whether the icon is recognisable as its subject. It is advisory (`shadow`) and never filters, as the pack ships no stability entry. Treat its reasons as a prompt for a person.

The first check uses WCAG's formula. It does not prove WCAG conformance, which depends on what the icon conveys and its real surroundings.

## Audit a family

There is no family check. Audit the subject's folder:

```sh
assetgrove audit asset://<game>/by-subject/<family>/ --dry-run
assetgrove audit asset://<game>/by-subject/<family>/
```

It scores each member's style against the bible and the other members, and reports the spread and the set-consistency bar. The audit informs a person; it never rejects or approves.

## Limits

One size per profile. Size sets and icon atlases come after 1.0.
