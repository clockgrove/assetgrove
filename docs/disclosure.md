# AI marks and the disclosure summary

Assetgrove marks every file it hands off, and `disclosure` summarises the library for the forms stores ask a developer to fill in. The marks and the summary help people see which assets were made with AI. **They make no claim that a game complies with any law or store policy.** What Article 50 of the EU AI Act, or a store's rules, ask of Assetgrove or of a game stays a question for a lawyer.

## The marks

Each handed-off file carries the IPTC digital source type, and, where IPTC defines AI-system properties, the models in `AISystemUsed`. The prompt is never written into a file.

| Format          | Where the mark lives                               |
| --------------- | -------------------------------------------------- |
| PNG, JPEG, WebP | an XMP packet (`iTXt`, APP1, `XMP ` chunk)         |
| glTF, GLB       | the `KHR_xmp_json_ld` extension                    |
| KTX2            | the key-value entry `XMP`, holding the same packet |

Other formats cannot carry the mark. Engines and packers can also strip a mark, so the provenance record always holds the source type too ([docs/library.md](library.md)).

## The check

Each hand-off preset's check reads the mark back from the media and from every file the preset wrote in a format that can carry it, the atlas images of `atlas-json` and `aseprite-json` included. A file that lacks the mark, or whose mark differs from the provenance's source type or models, fails the hand-off with exit 6 `handoff_check_failed`, and nothing reaches the library.

## `disclosure`

```
assetgrove disclosure [root] [--out <file>] [--json]
```

The `disclosure` tool takes the same arguments. It reads the cards under `root` (the current directory by default) and the provenance each names (or the manifest that embeds it; a card with neither is read from its media file's mark). It reports:

- assets by kind and by IPTC source type;
- models and providers, with the number of assets each made;
- provider terms, with the date each was recorded as of;
- text for Steam's AI content survey and tags and text for itch.io's AI disclosure.

No prompt text is read or shown. `--out` writes the same summary as Markdown, to a path inside the current directory. The Steam and itch.io text is a draft for the developer to check against the form as the store shows it today.
