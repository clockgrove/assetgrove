# AI marks and the disclosure summary

Assetgrove marks every file it hands off, and `disclosure` summarises the library for the forms stores ask a developer to fill in. The marks and the summary help people see which assets were made with AI. **They make no claim that a game complies with any law or store policy.** What Article 50 of the EU AI Act, or a store's rules, ask of Assetgrove or of a game stays a question for a lawyer.

## The marks

Each handed-off file carries the IPTC digital source type, and, where IPTC defines AI-system properties, the models in `AISystemUsed`. It also carries `assetgrove:callsSha256`, the sha256 of the provenance record's calls, which ties the record to the file ([decisions](decisions.md#provenance-is-bound-to-its-media)); it names no prompt. The prompt is never written into a file.

| Format          | Where the mark lives                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------ |
| PNG, JPEG, WebP | an XMP packet (`iTXt`, APP1, `XMP ` chunk)                                                       |
| glTF, GLB       | the `KHR_xmp_json_ld` extension                                                                  |
| KTX2            | the key-value entry `XMP`, holding the same packet                                               |
| WAV             | an XMP packet in the `_PMX` chunk                                                                |
| Ogg Vorbis      | Vorbis comments: `DIGITALSOURCETYPE` (the IPTC URI), `AISYSTEMUSED` and `ASSETGROVE_CALLSSHA256` |

Other formats cannot carry the mark. Engines and packers can also strip a mark, so the provenance record always holds the source type too ([docs/library.md](library.md)).

## Content credentials

Beside the IPTC mark, every PNG, JPEG and WebP hand-off writes (the media, image sidecars and any image a preset writes) carries a signed C2PA manifest. Unlike the XMP mark, it cannot be rewritten without breaking its signature, and its hard binding fails when the pixels change. Its `c2pa.actions.v2` assertion records `c2pa.created` with the IPTC digital source type (`trainedAlgorithmicMedia` for a generated asset) and the models as the action's `softwareAgent` (the same text as `AISystemUsed`). An assertion `org.clockgrove.assetgrove.input` names the sha256 of the bytes it signed, the signing certificate's sha256 and whether it is the development certificate. The prompt is never written.

An asset a person edited by hand and adopted with `library adopt` ([library.md](library.md)) carries `c2pa.opened` of the AI-made original, which is its `parentOf` ingredient with its own manifest, then `c2pa.edited` with the source type `compositeWithTrainedAlgorithmicMedia`.

The signer is the certificate and key the developer settings name in `contentCredentials`, or else Assetgrove's local development certificate, created once in the state directory ([settings.md](settings.md#content-credentials)). The hand-off result's `contentCredentials` (and its provenance's) records which certificate signed: its sha256, subject, issuer, serial number, algorithm and `development`; with the development certificate the result carries a `warning`, and the disclosure summary says so. Re-running a hand-off on an unchanged asset keeps the file already there when its manifest holds for the same bytes, claim and certificate, so its bytes stay identical.

An Ogg Vorbis rendition ([transform.md](transform.md#named-renditions-from-a-mezzanine-version)) carries the same manifest as a sidecar, `<stem>.c2pa` beside it, because the SDK cannot embed one in Ogg. The sidecar is bound to the Ogg through `org.clockgrove.assetgrove.input`, whose sha256 must be the Ogg's.

The manifests are built and read by the Content Authenticity Initiative's SDK ([decisions.md](decisions.md#c2pa-content-credentials-on-the-cais-webassembly-sdk)). glTF, GLB and KTX2 keep the IPTC/XMP mark only.

## The check

Each hand-off preset's check reads the mark back from the media and from every file the preset wrote in a format that can carry it, the atlas images of `atlas-json` and `aseprite-json` included. A file that lacks the mark, or whose mark differs from the provenance's source type or models, fails the hand-off with exit 6 `handoff_check_failed`, and nothing reaches the library.

For a PNG, JPEG or WebP the check also reads the C2PA manifest back and validates it, offline: its signature, its certificate chain, its assertions' hashes and its hard binding to the bytes. An untrusted signing credential passes (no trust list is configured); any other failure does not. Each problem in `error.problems` names the file (`file`, relative to the target) and a `code`: `credentials_missing` (no manifest), `credentials_mismatch` (the manifest does not match the file's bytes), `credentials_invalid` (any other validation failure, or actions, source type or models that differ from the provenance), and for the IPTC mark `mark_missing` (the file carries no digital source type) or `mark_invalid` (the file cannot be read, or its source type or models differ from the provenance's). The code comes from the check that found the problem, never from the problem's wording.

## `disclosure`

```
assetgrove disclosure [root] [--out <file>] [--json]
```

The `disclosure` tool takes the same arguments. It reads the cards under `root` (the current directory by default) and the provenance each names (or the manifest that embeds it; a card with neither is read from its media file's mark). It reports:

- assets by kind and by IPTC source type;
- models and providers, with the number of assets each made. A provider is the settings id at the head of each call's route (`<providerId>:<operation>:<model>`), so a direct call whose model id has no slash counts as surely as a gateway call, and a local server's model id never names its provider. A record whose calls carry no such route counts the provenance's `route`;
- the model vendors behind gateway calls (`vendors`): the model id's prefix on a call whose provider's adapter is `vercel-ai-gateway`, by the rule `init` uses for each route's data flow. It needs the developer settings to know which provider is a gateway; without them the list is empty;
- provider terms, with the date each was recorded as of: the call's `providerTermsAsOf`, which each route records beside `providerTerms`. Only for a record made before calls carried that field is the date read from the text's `(as of YYYY-MM-DD)`;
- content credentials: how many assets were signed, by which certificate, and, when any were signed with Assetgrove's local development certificate, a note that no C2PA trust list holds it and that a certificate from a C2PA-recognised authority (developer settings `contentCredentials`) replaces it before release;
- text for Steam's AI content survey and tags and text for itch.io's AI disclosure;
- a sound line per audio asset (a kind whose media trait is `audio`: `sfx`, `ambience`, `music`), from its calls' route records, in `sounds` and appended to both the Steam and the itch.io text: `Sound: <asset> (<kind>): <models> via <provider>, <plan> plan`, then `, non-exclusive` when the output grant says the output may not be unique across users, and the training opt-out the developer declared for the route, with its date. A card without a route record says `route record unavailable`.

No prompt text is read or shown. `--out` writes the same summary as Markdown, to a path inside the current directory. The Steam and itch.io text is a draft for the developer to check against the form as the store shows it today.

## Release selection and store policy snapshot (2026-11-19)

The optional `selected` array (tool/API; CLI `--selected` array) names exact root-relative media paths, using `/`. Only those carded files contribute; an empty array selects none. Omit it for the existing whole-library summary. Missing selections, missing media and unclassified source types produce `unresolved` with affected paths. Never interpret unresolved as absence of AI. No media is sent to a provider.

Godot's [submission fields](https://docs.godotengine.org/en/stable/community/asset_store/submitting_to_asset_store.html) require AI usage disclosure; its [FAQ](https://docs.godotengine.org/en/stable/community/asset_store/faq.html) requires what was generated and how AI was used. `godot.what` names media and `godot.how` lists recorded models; the developer must complete the process description, which provenance cannot establish fully.

The chosen [Playdate Catalog policy](https://help.play.date/catalog-developer/ai-disclosure/) is the April 2026 policy for new titles: generated art, audio, music, text and dialogue are excluded. `playdate.affectedAssets` names selected generated/composite media; `unresolvedAssets` names evidence needing investigation. Previously approved titles and AI coding assistance have different disclosure treatment. These outputs are evidence about selected media, never a guarantee of title eligibility or an assessment of code or runtime generation.
