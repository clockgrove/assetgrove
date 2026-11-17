# Developer settings

Developer settings are one per-user file outside every project, and the only input that steers money, code or keys. Shared files (target profile, style bible, presets, recipes) and request inputs travel between developers, so they never name an endpoint, a cap above the settings, a route, a grant, or a command they may run unapproved (a profile's validator and material commands run only with a person's approval). `src/settings.ts` loads the file, `src/formats.ts` checks its format line and `src/env.ts` supplies every environment value they use.

Every command reads settings when it builds its run context. `assetgrove settings path|show|check` prints the location, the loaded values and the adapter-aware checks.

## Location

1. `$ASSETGROVE_CONFIG`: an absolute path, and the file must exist.
2. Otherwise `<configHome>/assetgrove/settings.json`, where configHome is `$XDG_CONFIG_HOME` or `~/.config`, and `%APPDATA%` on Windows.

`configDir` is the directory that holds the file. If there is no file, there are no providers, the caps are 5/10/5 USD and the mode is attended.

## Schema

The file is JSON, validated with zod. Every object is strict: an unknown field anywhere is refused.

```jsonc
{
  "format": "assetgrove-settings/2",
  "stateDir": "/abs/path",
  "headless": { "operator": "ci:example/repo" },
  "caps": { "runUsd": 5, "dailyUsd": 10, "workItemUsd": 5 },
  "providers": {
    "<id>": {
      "adapter": "vercel-ai-gateway",
      "keyEnv": "AI_GATEWAY_API_KEY",
      "baseURL": "https://relay.example/v1",
      "free": true,
      "usdPerCredit": 0.01,
      "limit": { "kind": "key-budget", "usd": 20, "period": "monthly", "acceptUnlimited": false },
    },
  },
  "roles": {
    "<role>": { "provider": "<id>", "model": "...", "outputGrant": {}, "providerTerms": "..." },
  },
  "routes": {
    "<operation>": {
      "provider": "<id>",
      "model": "...",
      "outputGrant": {},
      "providerTerms": "...",
    },
  },
  "extensions": ["<package>"],
  "environment": { "allow": ["HTTPS_PROXY"] },
  "reconcile": { "marginUsd": 0.05, "marginPct": 5 },
  "spend": { "acknowledgedHolds": ["<hex>"] },
  "keyGuard": { "acknowledgedBlobs": ["<blob id>"] },
  "commands": {
    "approved": [
      { "hash": "<hex>", "kind": "validator", "argv": ["..."], "cwd": "tools", "note": "..." },
    ],
  },
  "promptPolicy": { "allow": ["term"] },
  "contentCredentials": { "certificate": "/abs/chain.pem", "privateKey": "/abs/signer.key" },
  "confirmedBy": { "caps": { "method": "elicitation", "at": "...", "client": "..." } },
  "search": {
    "store": {
      "uri": "s3://bucket/prefix",
      "options": { "endpoint": "https://<account>.r2.cloudflarestorage.com", "region": "auto" },
      "credentialsEnv": { "accessKeyId": "AG_R2_KEY_ID", "secretAccessKey": "AG_R2_SECRET" },
      "writer": true,
    },
    "embedder": "local",
    "model": "siglip2-base",
    "candidates": true,
    "nearMatch": true,
    "folders": ["/abs/concept-art"],
  },
}
```

| Field                  | Meaning                                                                                                                                                                                                                                                                                                               | Default                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `format`               | `assetgrove-settings/2`; a /1 file loads and is moved forward in memory. Required.                                                                                                                                                                                                                                    | —                                                                                             |
| `stateDir`             | Absolute directory for run state; never inside a project.                                                                                                                                                                                                                                                             | `<stateHome>/assetgrove` (`$XDG_STATE_HOME` or `~/.local/state`; `%LOCALAPPDATA%` on Windows) |
| `headless.operator`    | Present: headless mode, run by this operator. Set only by an operator outside the repository.                                                                                                                                                                                                                         | attended                                                                                      |
| `caps`                 | `runUsd`, `dailyUsd`, `workItemUsd`. Shared files may lower them, never raise them.                                                                                                                                                                                                                                   | 5 / 10 / 5                                                                                    |
| `providers.<id>`       | `adapter`, `keyEnv` (the variable that holds the key, never the key), `baseURL`, `free`, `usdPerCredit`, `limit`. An entry may hold only `limit`.                                                                                                                                                                     | none                                                                                          |
| `providers.<id>.limit` | `kind`: `key-budget`, `team-budget`, `project-hard-limit`, `workspace-limit`, `prepaid` or `unlimited` (needs `acceptUnlimited: true`); `usd`; `period`.                                                                                                                                                              | none                                                                                          |
| `roles.<role>`         | `provider`, `model`, `outputGrant` (`license`, `plan`, `commercial`, `relabel`, `attribution`; all but `attribution` required), `providerTerms`, `providerTermsAsOf` (the date, `YYYY-MM-DD`, the terms were read, recorded on each call beside them), `estimatedCostUsd`. See [Roles and routes](#roles-and-routes). | the adapters' default routes                                                                  |
| `routes.<operation>`   | The same fields as a role, for one operation; overrides its role.                                                                                                                                                                                                                                                     | the role                                                                                      |
| `extensions`           | Package names whose extension code may run, each resolved from the project at start. Only this field loads code. See [Extensions](extensions.md).                                                                                                                                                                     | none                                                                                          |
| `environment.allow`    | Refused environment variables (below) that are allowed anyway.                                                                                                                                                                                                                                                        | none                                                                                          |
| `reconcile`            | `marginUsd`, `marginPct`: a gap between the ledger and the provider's usage holds paid runs only above max(`marginUsd`, `marginPct`% of the ledger spend). See [Reconcile](#reconcile).                                                                                                                               | 0 / 0                                                                                         |
| `spend`                | `acknowledgedHolds`: the ids (hex) of spend holds a person has looked at; a listed hold no longer refuses paid runs.                                                                                                                                                                                                  | none                                                                                          |
| `keyGuard`             | `acknowledgedBlobs`: the Git blob ids of tracked file contents a person has checked hold no live key; a listed content no longer refuses by name. See [Tracked keys](#tracked-keys).                                                                                                                                  | none                                                                                          |
| `commands.approved`    | Approved commands, matched by `hash` (the `commandHash`); `kind`, `argv`, `cwd`, `note` are for the reader. The only approvals headless settings honour.                                                                                                                                                              | none                                                                                          |
| `promptPolicy.allow`   | Prompt-policy allow terms.                                                                                                                                                                                                                                                                                            | none                                                                                          |
| `contentCredentials`   | `certificate` (a PEM chain, signer first) and `privateKey` (a PEM PKCS#8 key: ECDSA P-256 or P-384, Ed25519 or RSA), absolute paths outside every project, that sign the C2PA manifests hand-off writes. See [Content credentials](#content-credentials).                                                             | the local development certificate                                                             |
| `confirmedBy.<path>`   | Who confirmed a field: `method`, `at`, `client`.                                                                                                                                                                                                                                                                      | none                                                                                          |

`search` is optional; absent, `Settings.search` is absent too. The local store is always `<stateDir>/search`. Present, `search` is filled with `embedder: "local"` (or `"scripted"`, or `"route"`), `model: "siglip2-base"`, `candidates: true`, `nearMatch: true` and `folders: []`. `search.store` adds a shared remote store: `uri` is an `s3://`, `gs://` or `az://` URI; `options` takes only `endpoint` (https, no user name, password or query) and `region`, default `{}`; `credentialsEnv` is required and names the variables that hold the store's credentials, never the values, in the fields its scheme reads: `accessKeyId`, `secretAccessKey` and optional `sessionToken` for `s3://`, `serviceAccountKey` (the service account key JSON) for `gs://`, `accountName` and `accountKey` for `az://`; any other field, or a missing one, is refused. The search package hands Lance exactly those values under the scheme's object-store keys and never opens a remote store without them, so the store never authenticates with credentials it finds on the machine; a named variable that is unset exits 2 `settings_invalid`; `writer` (default `false`) is true on the one machine that builds the shared index, and `false` makes the store read-only on this machine. The URI, the options and the credential variable names come only from settings. `folders` are absolute paths whose images are indexed beside the library.

**Hosted embeddings** (`search.embedder: "route"`, design section 7.7) embed through the provider the `embeddings` role (or `routes.embed`) names instead of the local model. Its adapter must declare the `embed` capability, which means images and text in one vector space (the gateway's and the scripted adapter's do; on the gateway only a Google multimodal model, such as `google/gemini-embedding-2`, embeds images); otherwise `find` and `search index` exit 2 `route_unavailable` before any reservation. Vectors are asked for 768 wide. The provider receives every indexed image and every query, under its terms, and `init`'s data flows list it as the `embed` operation. Embedding calls are paid: `search index` and every `find` except `--outliers` become paid requests with a plan step (`--dry-run` prints it) that forecasts the images and card texts bringing the index up to date embeds, plus the words or image file to embed, one spend confirmation, and every call reserved against the caps and journalled in its run directory; content embedded before is never paid for again, and a request with nothing to embed pays nothing and asks nothing. `find --outliers` embeds nothing and answers its ranking from the vectors already stored, but it is paid for its `style-outlier` decisions under every embedder (the `decisions` role, [models.md](models.md)): a plan step, one spend confirmation, asked when the call reaches it, and every call reserved and journalled. The `find` MCP tool is therefore marked as asking a spend confirmation (`anthropic/requiresUserInteraction`, except under headless settings) under every embedder, so in Claude Code a paid `--outliers` goes to the person in every permission mode; with the local model a word search through it is free but asks the harness's permission too. The tree's `find` and `like` paths, near matches and every other read never call the provider and answer from the vectors already stored. Each index records the embedder that made its vectors (id, revision, route and model); indexing or querying it with another exits 2 `embedder_changed` until `search index --rebuild` rebuilds it.

## Content credentials

Hand-off signs a C2PA manifest into every PNG, JPEG and WebP it writes ([disclosure.md](disclosure.md#content-credentials)). The signing key and certificate come only from `contentCredentials` here: never from a shared file, the target profile or the repository, and a path inside any project is refused. With no `contentCredentials`, Assetgrove creates a development CA and signer once under `<stateDir>/content-credentials/` (`chain.pem`, `signer.key`, `ca.pem`) and signs with it; the hand-off result, its provenance and the disclosure summary then say the development certificate signed. No C2PA trust list holds it, so readers report the signature valid but untrusted. A certificate from a C2PA-recognised authority is the owner's step before 1.0.

## Refusals

Loading throws `SettingsError`, with the code `settings_invalid`, when:

- the file's real path, or `configDir`, is inside a project (below), whether or not the file exists;
- `$ASSETGROVE_CONFIG` is not absolute or names a missing file;
- the file is not JSON;
- the format is missing, unknown or newer than this build reads;
- any field is unknown, including inside `outputGrant`;
- any field anywhere is named `apiKey`, `key`, `token` or `secret` (in any case); the keys of `providers`, `roles`, `routes` and `confirmedBy` are ids, not field names, so a provider called `key` is accepted;
- `stateDir` is relative or inside a project, or, when it is not set, the default one under the state home is inside a project;
- `contentCredentials.certificate` or `contentCredentials.privateKey` is relative or inside a project;
- `search.store.uri` is not an `s3://`, `gs://` or `az://` URI, or `search.store.options` has any field but `endpoint` and `region`;
- a `search.store.options.endpoint` is not https or carries a user name, a password or a query string;
- a `search.folders` entry is relative;
- a `baseURL` carries a user name, a password or a query string (the message shows only its origin and path);
- a `baseURL` is neither https nor http on a loopback host (`localhost`, `127.0.0.0/8`, `[::1]`);
- `free` is set on a provider without a loopback `baseURL`;
- a role or route names a provider that is not in `providers`;
- a limit of kind `unlimited` lacks `acceptUnlimited: true`.

The projects are found from the cwd, `--target` and the directory of each input file's real path (so an input that is a symlink counts for the project it points into). Each directory at or above one of these, and below the home directory, that holds `.git`, as a directory or a file, is a project. A repository at the home directory itself (a dotfiles repository) is not a project, since it would hold every default config and state directory. The home directory here is the account's as the operating system records it, never `$HOME`, which a command line can set. A `.git` file (a linked worktree or a submodule) also makes a project of the work tree whose `.git` directory holds the Git directory it names: a linked worktree's main checkout, found through its `commondir`, or a submodule's superproject. A `.git` directory also makes a project of each of its linked worktrees, named in `.git/worktrees/<name>/gitdir`, so a sibling worktree counts too. Paths are compared by their native real path (which expands Windows 8.3 short names), case-insensitively on Windows and macOS.

Refusals that depend on the adapter exit 2 with `settings_invalid`, and are checked when the run context is built, for every command:

- an `adapter` that is neither a core adapter nor a `<ext>:<id>` of a loaded extension (an unknown `<ext>:<id>` exits 2 `extension_unavailable`);
- a `baseURL` on a `tripo` or `scripted` entry. Tripo's endpoint is fixed (api.tripo3d.ai).

Refusals of spend exit 3:

- a paid call to a provider with no declared `limit` is `provider_limit_undeclared`, before any spend;
- a gateway HTTP 402, or an HTTP 429 with the code `insufficient_quota`, is `cap_refused`;
- a `--cap` above `caps.runUsd` is `cap_refused`, before anything is written;
- a prepaid limit with `usd` that the provider's balance exceeds is `provider_limit_mismatch` (`spend check`);
- a paid run while a spend hold is not acknowledged is `spend_hold` (see [Reconcile](#reconcile)).

Adapter errors carry only the provider's message, the HTTP status and the provider's error code, never the response body. A command's result document keeps a thrown error's own code when it is in the exit table, so `SettingsError` reports `settings_invalid` and `FormatError` reports `format_unsupported`, both with exit 2.

## Providers

Each provider instance is made by an adapter from `providers.<id>`. The adapter is the entry's `adapter` field, else its id. Paid-ness comes from the adapter's billing, never from the name. The key is read from the variable named by `keyEnv` and passed to the SDK together with the `baseURL`, so `*_BASE_URL` variables never apply.

| Adapter             | Key variable (default)                          | `baseURL`                                                                                 | Cost                                                                                                                             |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY`                            | Allowed: https, or http on a loopback host. Default `https://ai-gateway.vercel.sh/v4/ai`. | Paid. A relay is set here.                                                                                                       |
| `anthropic`         | `ANTHROPIC_API_KEY`                             | Refused. The endpoint is api.anthropic.com.                                               | Paid. No usage reading: a call costs the route estimate.                                                                         |
| `openai`            | `OPENAI_API_KEY`                                | Refused. The endpoint is api.openai.com.                                                  | Paid. No usage reading: a call costs the route estimate.                                                                         |
| `tripo`             | `TRIPO_API_KEY`                                 | Refused. The endpoint is api.tripo3d.ai.                                                  | Paid. `usdPerCredit` prices its credits; without it a call costs the route estimate.                                             |
| `openai-compatible` | none (set `keyEnv` when the server takes a key) | Required: https, or http on a loopback host.                                              | Paid, unless `free` (loopback only). The server reports no cost: a call costs the route estimate.                                |
| `scripted`          | none                                            | Refused.                                                                                  | Free, unless its script sets `paid: true`. It may export `limitReading()`, `reconcile` and `callCost(requestId)`. Used by tests. |

`keyEnv` overrides the key variable of any adapter.

## Roles and routes

Which provider and model serve each operation is a money and licence decision, so it comes only from these settings. There is no default provider, routes file, `--routes` option, or route in run options or plans.

Each operation maps to a role:

| Role                          | Operations                                                                                                                                                                    | Capability          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `image`                       | `still`, `sheet`                                                                                                                                                              | image               |
| `edit`                        | `edit`, `lookdev`, `fix`                                                                                                                                                      | edit                |
| `vision`                      | `vision`, `lookdev-locate`, `lookdev-groom`, `lookdev-markings`, `identity-cast`, `identity-check`, `material-qa`                                                             | vision              |
| `decisions`                   | `identity`, `flicker`, `holes`, `prompt-policy`, `brief-policy`, `reference-view`, `model3d-facing`, `lookdev-marking`, `bible-staleness`, `motion-template`, `style-outlier` | decide              |
| `planning`                    | `compiler`                                                                                                                                                                    | vision              |
| `model3d`, `rig3d`, `clips3d` | the operation of the same name                                                                                                                                                | model, rig, animate |
| `embeddings`                  | `embed` (hosted search embeddings, `search.embedder: "route"`)                                                                                                                | embed               |

An operation's route is `routes.<operation>`, else `roles.<role>`, else the default route of the one configured provider whose adapter has one for it: the gateway and OpenAI serve the 2D operations, Anthropic the vision, decisions and planning ones, Tripo the 3D ones, openai-compatible none (route each role to it), and the scripted adapter (the test stand-in) all of them except `embed`, which no adapter routes by default (set `roles.embeddings`), but only where no other configured provider has a default, so it never takes an operation from a real provider. Which provider serves an operation is the developer's choice, never the order of provider ids: when more than one configured provider (the scripted stand-in aside) has a default route for an operation and neither `routes.<operation>` nor `roles.<role>` is set, reading that operation's route exits 2 `settings_invalid`, naming the providers and the field to set (`settings.roles.<role>`, or `settings.routes.<operation>` for an operation with no role). So `gateway` beside `anthropic` (or `zz-anthropic`) needs `roles.vision`, `roles.decisions` and `roles.planning` set before an operation of those roles runs; `gateway` beside `tripo` needs nothing, since they serve different operations. A command that never uses the ambiguous operation is unaffected, and `routeDataFlows` leaves it out. The route must name a configured provider whose adapter has the role's capability; otherwise the command exits 2 `route_unavailable` before any reservation, naming the operation and the fields that would serve it.

**Grants belong to (provider, model).** A default route carries the grant its provider's terms give, and its terms. An override that names the default's provider and model keeps them, except that one setting its own `providerTerms` without `providerTermsAsOf` drops the default's date, which was recorded for the default's text; one that changes either, or routes an operation with no default, belongs to another pair and takes nothing from the default: it carries only its own `estimatedCostUsd`, `outputGrant`, `providerTerms` and `providerTermsAsOf`, and no size or provider options. Such an override must set `estimatedCostUsd` unless its provider is `free` or scripted; otherwise loading the routes exits 2 `settings_invalid`, since every paid call reserves its estimate before it is made. A call without a grant is refused at hand-off: see [Provider output grants](decisions.md#provider-output-grants). `estimatedCostUsd` sets the amount reserved before each call.

Every call records its route as `<providerId>:<operation>:<model>`. `routeDataFlows(settings)` (src/dataflows.ts) lists, per routed operation, the provider, the host its data goes to, the model vendor behind a gateway route (`upstream`), the terms recorded and `retention` (`local` for a loopback or scripted provider; otherwise not recorded). The terms are recorded, not a licence. `suggestRoles(adapterIds)` gives the roles the adapters' default routes would serve. Typed decisions on the anthropic, openai and openai-compatible adapters go through structured output; the call record's `decision.decisionSource` is `structured-output` there and `decision-model` on the gateway's decision models.

A local-only setup ([recipe](models.md#local-only-recipe)) routes `image` to a loopback OpenAI-compatible image server and `vision`, `decisions` and `planning` to a loopback chat server, each entry `free`:

```jsonc
{
  "providers": {
    "images": {
      "adapter": "openai-compatible",
      "baseURL": "http://127.0.0.1:8080/v1",
      "free": true,
    },
    "chat": { "adapter": "openai-compatible", "baseURL": "http://127.0.0.1:8081/v1", "free": true },
  },
  "roles": {
    "image": {
      "provider": "images",
      "model": "<model>",
      "outputGrant": {
        "license": "<SPDX or LicenseRef-*>",
        "plan": "local",
        "commercial": true,
        "relabel": true,
      },
      "providerTerms": "<the model's licence>",
    },
    "vision": {
      "provider": "chat",
      "model": "<model>",
      "outputGrant": {
        "license": "<SPDX or LicenseRef-*>",
        "plan": "local",
        "commercial": true,
        "relabel": true,
      },
      "providerTerms": "<the model's licence>",
    },
    "decisions": {
      "provider": "chat",
      "model": "<model>",
      "outputGrant": {
        "license": "<SPDX or LicenseRef-*>",
        "plan": "local",
        "commercial": true,
        "relabel": true,
      },
      "providerTerms": "<the model's licence>",
    },
    "planning": {
      "provider": "chat",
      "model": "<model>",
      "outputGrant": {
        "license": "<SPDX or LicenseRef-*>",
        "plan": "local",
        "commercial": true,
        "relabel": true,
      },
      "providerTerms": "<the model's licence>",
    },
  },
}
```

Every call in a provenance needs a grant, vision QA calls included, so each role carries the `outputGrant` its model's licence gives. A role left without one still stages, but `pick` and `write-families` refuse its output (exit 7 `license_refused`).

## Caps and ledger

Every paid call is recorded in the spend ledger `<stateDir>/spend.jsonl`. A call is refused before it is made when it would pass a cap:

| Cap                | Bounds                                                                                                    | Default |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ------- |
| `caps.runUsd`      | One run. `--cap` may only lower it; a `--cap` above it is refused.                                        | $5      |
| `caps.dailyUsd`    | Everything recorded in the last 24 hours.                                                                 | $10     |
| `caps.workItemUsd` | One work item, named by `--work-item` or `ASSETGROVE_WORK_ITEM`. Without one, only the daily cap applies. | $5      |

A target profile's `spend.dailyLimitUsd` and `spend.workItemLimitUsd` lower the daily and work-item caps, never raise them. The limit status reports its `source` as `settings` or `profile`. A paid call to a provider with no declared `limit` is refused with `provider_limit_undeclared`; `kind: "unlimited"` needs `acceptUnlimited: true`. Dry runs report `spend.counted` from the provider's billing.

`assetgrove spend status` shows the ledger against the caps. `assetgrove spend check` reports, per provider, `{provider, adapter, paid, declared, limit, verified, reading, mismatch, note}`. A reading verifies only a `prepaid` limit with `usd` (balance at or below `usd`); a balance above it contradicts the limit and exits 3 with `provider_limit_mismatch`.

### Reconcile

The ledger is an estimate. Where a provider reports its own usage to an ordinary key, a paid run compares the two when it ends and adds `reconcile` to its `run.json`: one `{provider, status, method, ledgerUsd, providerUsd, gapUsd, marginUsd, holdId, pendingId, unmatched, note}` per paid provider its plan names.

| Adapter             | Reconcile       | How                                                                                                                                                 |
| ------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vercel-ai-gateway` | `per-call-cost` | Each call's cost by its generation ID, through the gateway SDK's `getGenerationInfo` (`totalCost`). A cost not reported yet leaves the run pending. |
| `tripo`             | `per-call-cost` | Each task's credits by its task ID (`GET /task/{id}`, `consumed_credit`), priced with `usdPerCredit`; without it, every task is `unmatched`.        |
| `anthropic`         | `unavailable`   | An ordinary key reads no usage.                                                                                                                     |
| `openai`            | `unavailable`   | An ordinary key reads no usage.                                                                                                                     |
| `openai-compatible` | `unavailable`   | The server reports no usage.                                                                                                                        |
| `scripted`          | `unavailable`   | Unless its script sets `reconcile` and `callCost` (tests).                                                                                          |

`settings check` reports each provider's `reconcile`. The ledger side is the run's reservations in `spend.jsonl` that no earlier attempt's end has reconciled, so a resume also compares the spend of an attempt that stopped before its end; the run directory's `reconcile-state.json` keeps what was reconciled. Every reconcile compares the calls the run journaled, each by the ID its provider returned, never an account-wide figure such as a balance: another run on the same key, or credits added mid-run, cannot raise a hold. A call the provider can never look up (no journaled request ID because the call failed or an attempt stopped during it, an ID the provider rejects, no numeric cost, or a Tripo task with no `usdPerCredit` to price it) is counted in `unmatched`, on neither side; a hold is raised only on a gap that stays unexplained among the calls that were looked up. `status` is `unavailable`, `reconciled`, `held`, `pending` or `failed`: a run none of whose paid calls could be looked up (nothing was compared), or a lookup still unanswered a day after its run.

A gap, |provider − ledger|, above max(`reconcile.marginUsd`, `reconcile.marginPct`% of the ledger spend) appends a hold `{id, at, provider, runId, ledgerUsd, providerUsd, gapUsd}` to `<stateDir>/holds.jsonl`. From then on every paid run exits 3 `spend_hold` before it spends, until a person acknowledges the hold, which lists its `id` in `spend.acknowledgedHolds` (`settings change --acknowledge-holds <id>`, or a hand edit). `spend status` lists the holds and whether each is acknowledged.

A lookup the provider cannot answer yet is recorded as pending in `<stateDir>/reconcile.jsonl`. The next paid run retries it at its start, before the hold check, and `spend reconcile` retries it on demand. A retry stops at the first call cost still unreported. A lookup still pending a day after its run resolves as `failed` and is not retried again.

### Provider limits

What a key can carry for each core provider, and whether Assetgrove reads it. The rows describe the provider, not the adapters in this build.

| Provider          | Limit a key can carry                                                   | Assetgrove reads it                                                              | Source                                                                       | Checked                                        |
| ----------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| Vercel AI Gateway | Prepaid AI Gateway credits for the team                                 | Yes: the credits balance, through the gateway SDK's `getCredits` (`/v1/credits`) | <https://vercel.com/docs/ai-gateway/pricing>; `@ai-sdk/gateway` `getCredits` | Not against the page; the SDK call, 2026-11-14 |
| Anthropic         | Workspace spend limits and organization usage tiers, set in the Console | No, declared only: an ordinary API key cannot read them                          | <https://docs.anthropic.com/en/api/rate-limits>                              | Not yet                                        |
| OpenAI            | Project budgets and organization usage limits                           | No, declared only                                                                | <https://platform.openai.com/docs/guides/rate-limits>                        | Not yet                                        |
| Tripo             | Prepaid credits on the account                                          | Yes: `GET /user/balance` (credits; USD with `usdPerCredit`)                      | <https://platform.tripo3d.ai/docs>; `src/gateway/tripo.ts` `balance`         | Not against the page; the client, 2026-11-14   |

The Assetgrove-reads column was checked against this build's code on 2026-11-14. The limit column was written without network access, so it has not been checked against the provider pages it names. A row's Checked cell gets a date once someone reads that page.

## Tracked keys

The tracked-key guard runs at MCP server start, at each paid command's start and on the `pick` and `write-families` target, and refuses (exit 2 `key_tracked`, naming each file and variable, never the value) a tracked file that holds a live credential. It reads each tracked file's staged blob and its working-tree content (Git LFS pointers and files over 4 MB are skipped) and counts two things, for each configured key variable (the adapters' defaults and every provider's `keyEnv`):

- **The exact value** this process holds for the variable, when it is 16 characters or more. This rule is never acknowledged.
- **A key-shaped literal assigned by name**: `NAME=value` or `export NAME=value` at the start of a line, a JSON member `"NAME": "value"`, or a YAML member `NAME: value` in a `.yml` or `.yaml` file, whose value is 16 characters or more with no whitespace and no brackets, is not an expression (`os.environ…`, `process.env…`, `{{ … }}`, `${…}`, a leading `$`) and is not an obvious placeholder (it holds `your`, `here`, `example`, `placeholder`, `changeme`, `replace`, `redacted` or `xxxx` as a whole word between non-alphanumeric separators, is one repeated character, or ends in `...`; a key whose random text merely contains those letters, such as `sk-abcxHeRe9…`, still counts). So `OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")`, `OPENAI_API_KEY=your-api-key-here`, `export ANTHROPIC_API_KEY=sk-ant-...` and `{"OPENAI_API_KEY": "test"}` do not count.

For a by-name hit the refusal also names the Git blob id of the content that hit. A person who has checked that the value is not a live key acknowledges that content by listing the blob id in `keyGuard.acknowledgedBlobs` (`settings change --acknowledge-blobs <id>`, or a hand edit), as a spend hold is acknowledged. Ids compare case-insensitively. The acknowledgement covers exactly that content: editing the file gives it a new blob id, and the refusal comes back if the new content still assigns a key-shaped literal. The candidate value is never sent to a provider or printed.

## Who writes the file

`assetgrove settings change` (MCP tool `settings_change`) is the only command that writes the file, and it writes only the caps, one provider's `limit`, `spend.acknowledgedHolds` and `keyGuard.acknowledgedBlobs`, each on a person's confirmation. An agent may propose a change, but only a confirmed form writes it. An MCP client with form elicitation shows a flat form with the proposed values filled in and `acceptUnlimited` as its own Boolean, and an accept writes the values the person submitted. Otherwise the command exits 8 `confirmation_required`, and `assetgrove confirm <id>` at a terminal writes the change. Headless settings exit 8 and write nothing.

A write edits the file in place with `jsonc-parser`: it changes only the proposed fields and adds `confirmedBy.<field path>` = `{method, at, client?}` for each (`caps.runUsd`, `providers.<id>.limit`, `spend.acknowledgedHolds`, `keyGuard.acknowledgedBlobs`), with method `elicitation` or `terminal`. Every other byte stays as it was: a new field goes on its own indented lines inside an object that spans lines, and on the same line inside a one-line object, and no neighbouring field is re-laid out. Which provider entries exist and which holds are already acknowledged are read from the file at the moment of writing, so a later change in the same server session keeps what an earlier one, or a hand edit, put there. A limit for a core adapter id with no provider entry creates the entry with only `limit`, so a first setup on one core key needs no hand edit. `kind: "unlimited"` is written only with `acceptUnlimited: true`. The result is loaded as settings before it replaces the file, so the command never writes a file the settings would refuse. With no file, the change creates one at the default location holding the format line.

A person edits every other field by hand. Headless mode is set only by an operator who edits the file or the environment outside the repository.

## Format lines

`readFormat(kind, value, source)` checks `format: "assetgrove-<kind>/<n>"` for `target-profile`, `style-bible`, `style-preset`, `recipe`, `settings` and `blocklist`, all currently at /1 except `target-profile` and `settings`, at /2. A `settings` /1 file is valid as /2 (the `search` block is optional), so its migration changes only the format line; `assetgrove migrate <settings file> --kind settings` rewrites the line on disk, and `settings change` also rewrites an older format line to the current one when it writes. It refuses with `format_unsupported` (`FormatError`), with reason `missing` (the message names the line to add), `too_new` or `unknown`. An older version moves forward in memory through steps registered with `registerMigration(kind, from, migrate)`, and the result reports `migratedFrom`.

## Environment

Settings and the refusal rule read the environment through `src/env.ts`. The only variable that steers spend is `ASSETGROVE_WORK_ITEM`; the adapters read only their key variables (`keyEnv`). `checkEnvironment(allow, env, uses)` refuses with `settings_invalid` a set variable, in either case, that `environment.allow` does not list and that can redirect a key or index data, or unwrap the TLS that carries a key, in the configuration in use. `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` are refused whatever is configured. `ANTHROPIC_BASE_URL` is refused only when a provider's adapter is `anthropic`, and `OPENAI_BASE_URL` only when one is `openai` (a provider's adapter is its `adapter`, else its id). The AWS variables Lance's object store reads (`AWS_ENDPOINT_URL`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_ALLOW_HTTP`) are refused only when `search.store.uri` is `s3://`, so an AWS profile exported for other work stops nothing until an s3 store is configured, and then no variable may redirect search index data. The check runs at MCP server start and before every command that can send a key: every paid command, `spend check` and `spend reconcile`. `settings check` lists the refused variables and, when any is, reads no provider. A validator or material command runs with every key variable removed from its environment, and its output is redacted.

## Tests

`test/fixtures/env.ts` makes one temporary directory outside any repository and puts a settings file and that file's `stateDir` in it, then points `ASSETGROVE_CONFIG` there. The ledger is `<stateDir>/spend.jsonl`. The base settings declare a limit for the scripted provider: `providers.scripted.limit = {kind: "prepaid", usd: 100}`. The fixture unsets every variable `checkEnvironment` refuses, in both cases, for the test process and its children. Its helpers `writeSettings`, `useHeadless`, `approveCommand` and `declareLimit` rewrite the settings file; `approve` and `approveProfile` write approval records to `<configDir>/approvals/<hex>.json` for a provider script, a validator or a material command, and those last for the whole test file; `resetSettings` restores the base settings and runs before every top-level test, so a helper's change lasts only for the test that made it and its subtests.
