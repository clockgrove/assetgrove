# Assetgrove agent rules

Assetgrove is a public repository. These rules apply to every contributor, human or agent.

## Public repository

- Never commit secrets, credentials, tokens, personal data or anything private. Use synthetic values in tests and examples. Model provider keys come from the environment, never from files.
- Never commit a game's private art, style references or prompts unless that game's owner has published them. Test fixtures are synthetic.
- If a task seems to need something private, stop and ask in the issue.

## Scope

- Assetgrove is generic. Anything specific to one game — its style bible, its manifest format, its validator — lives in that game's repository and reaches Assetgrove as data (a target profile), never as code here.
- Model providers sit behind adapters (`src/providers/adapter.ts`) that declare how their calls are billed; core decides what is paid. Provider SDK types never leak past them.
- Every generated file carries provenance: model, route, prompt, parameters, seed where supported, request ID, time and cost.
- Spend is bounded: every run reserves against a cost cap before calling a provider, and refuses when it would exceed it. Every paid call also reserves against the cross-run ledger `<stateDir>/spend.jsonl`, whose caps come from the developer settings (`src/spend.ts`, docs/settings.md).
- Approval is human. Assetgrove filters and presents candidates; it never marks an asset approved.
- Media is format-agnostic: each output declares its own media type, and `.gitattributes` decides Git LFS storage. Code never lists allowed formats.

## Dependencies

- Use an existing SDK or library before writing your own. For a protocol, a file format, a codec or a provider's API, look first for the official SDK, then for a maintained library whose licence this repository can take. Reason: hand-written protocol code falls behind its standard, and every line of it is ours to maintain.
- Write it yourself only when nothing fits: no library exists, the licence doesn't fit, it needs an install script or a native binary this repository avoids, or the output must be byte-for-byte deterministic and no library guarantees that. Record the exception in [docs/decisions.md](docs/decisions.md): what you looked at, and why it didn't fit.
- Say in the pull request which SDK or library you chose, or which recorded exception applies. A reviewer treats new hand-written protocol, format or codec code with no recorded exception as a finding.

## Tests

Tests use a scripted generation provider and never call a real model by default. Real-provider checks are opt-in and skip cleanly without a key.

The merge queue runs the whole suite on Linux, macOS and Windows; a pull request runs Linux only. Write code and tests that hold on all three:

- Compare files and folders by real path, never by the path as typed. macOS keeps its temp folder behind a symlink (`/var` is `/private/var`) and Windows can hand back an 8.3 short name, so a typed path and Git's top level differ for the same folder.
- A test that makes a temp folder takes its real path first (`realpathSync(await mkdtemp(...))`) when it will compare paths or ask Git about the folder.
- Don't assume `/` in a path the system returns, a POSIX signal name on a killed process, or that a folder named for one system exists on another.

Reason: a failure only macOS or Windows shows is not seen until the merge queue, and each one costs a queue run and a fix.
