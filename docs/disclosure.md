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

## Content credentials

Beside the IPTC mark, every PNG, JPEG and WebP hand-off writes (the media, image sidecars and any image a preset writes) carries a signed C2PA manifest. Unlike the XMP mark, it cannot be rewritten without breaking its signature, and its hard binding fails when the pixels change. Its `c2pa.actions.v2` assertion records `c2pa.created` with the IPTC digital source type (`trainedAlgorithmicMedia` for a generated asset) and the models as the action's `softwareAgent` (the same text as `AISystemUsed`). An assertion `org.clockgrove.assetgrove.input` names the sha256 of the bytes it signed, the signing certificate's sha256 and whether it is the development certificate. The prompt is never written.

An asset a person edited by hand and adopted with `library adopt` ([library.md](library.md)) carries `c2pa.opened` of the AI-made original, which is its `parentOf` ingredient with its own manifest, then `c2pa.edited` with the source type `compositeWithTrainedAlgorithmicMedia`.

The signer is the certificate and key the developer settings name in `contentCredentials`, or else Assetgrove's local development certificate, created once in the state directory ([settings.md](settings.md#content-credentials)). The hand-off result's `contentCredentials` (and its provenance's) records which certificate signed: its sha256, subject, issuer, serial number, algorithm and `development`; with the development certificate the result carries a `warning`, and the disclosure summary says so. Re-running a hand-off on an unchanged asset keeps the file already there when its manifest holds for the same bytes, claim and certificate, so its bytes stay identical.

The manifests are built and read by the Content Authenticity Initiative's SDK ([decisions.md](decisions.md#c2pa-content-credentials-on-the-cais-webassembly-sdk)). glTF, GLB and KTX2 keep the IPTC/XMP mark only.

## The check

Each hand-off preset's check reads the mark back from the media and from every file the preset wrote in a format that can carry it, the atlas images of `atlas-json` and `aseprite-json` included. A file that lacks the mark, or whose mark differs from the provenance's source type or models, fails the hand-off with exit 6 `handoff_check_failed`, and nothing reaches the library.

For a PNG, JPEG or WebP the check also reads the C2PA manifest back and validates it, offline: its signature, its certificate chain, its assertions' hashes and its hard binding to the bytes. An untrusted signing credential passes (no trust list is configured); any other failure does not. Each problem in `error.problems` names the file (`file`, relative to the target) and a `code`: `credentials_missing` (no manifest), `credentials_mismatch` (the manifest does not match the file's bytes), `credentials_invalid` (any other validation failure, or actions, source type or models that differ from the provenance), and `mark_missing` or `mark_invalid` for the IPTC mark.

## `disclosure`

```
assetgrove disclosure [root] [--out <file>] [--json]
```

The `disclosure` tool takes the same arguments. It reads the cards under `root` (the current directory by default) and the provenance each names (or the manifest that embeds it; a card with neither is read from its media file's mark). It reports:

- assets by kind and by IPTC source type;
- models and providers, with the number of assets each made;
- provider terms, with the date each was recorded as of;
- content credentials: how many assets were signed, by which certificate, and, when any were signed with Assetgrove's local development certificate, a note that no C2PA trust list holds it and that a certificate from a C2PA-recognised authority (developer settings `contentCredentials`) replaces it before release;
- text for Steam's AI content survey and tags and text for itch.io's AI disclosure.

No prompt text is read or shown. `--out` writes the same summary as Markdown, to a path inside the current directory. The Steam and itch.io text is a draft for the developer to check against the form as the store shows it today.
