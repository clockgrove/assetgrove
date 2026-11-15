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
  "format": "assetgrove-settings/1",
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
  "commands": {
    "approved": [
      { "hash": "<hex>", "kind": "validator", "argv": ["..."], "cwd": "tools", "note": "..." },
    ],
  },
  "promptPolicy": { "allow": ["term"] },
  "confirmedBy": { "caps": { "method": "elicitation", "at": "...", "client": "..." } },
}
```

| Field                  | Meaning                                                                                                                                                                                                         | Default                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `format`               | `assetgrove-settings/1`. Required.                                                                                                                                                                              | —                                                                                             |
| `stateDir`             | Absolute directory for run state; never inside a project.                                                                                                                                                       | `<stateHome>/assetgrove` (`$XDG_STATE_HOME` or `~/.local/state`; `%LOCALAPPDATA%` on Windows) |
| `headless.operator`    | Present: headless mode, run by this operator. Set only by an operator outside the repository.                                                                                                                   | attended                                                                                      |
| `caps`                 | `runUsd`, `dailyUsd`, `workItemUsd`. Shared files may lower them, never raise them.                                                                                                                             | 5 / 10 / 5                                                                                    |
| `providers.<id>`       | `adapter`, `keyEnv` (the variable that holds the key, never the key), `baseURL`, `free`, `usdPerCredit`, `limit`. An entry may hold only `limit`.                                                               | none                                                                                          |
| `providers.<id>.limit` | `kind`: `key-budget`, `team-budget`, `project-hard-limit`, `workspace-limit`, `prepaid` or `unlimited` (needs `acceptUnlimited: true`); `usd`; `period`.                                                        | none                                                                                          |
| `roles.<role>`         | `provider`, `model`, `outputGrant` (`license`, `plan`, `commercial`, `relabel`, `attribution`; all but `attribution` required), `providerTerms`, `estimatedCostUsd`. See [Roles and routes](#roles-and-routes). | the adapters' default routes                                                                  |
| `routes.<operation>`   | The same fields as a role, for one operation; overrides its role.                                                                                                                                               | the role                                                                                      |
| `extensions`           | Package names whose extension code may run, each resolved from the project at start. Only this field loads code. See [Extensions](extensions.md).                                                               | none                                                                                          |
| `environment.allow`    | Refused environment variables (below) that are allowed anyway.                                                                                                                                                  | none                                                                                          |
| `reconcile`            | `marginUsd`, `marginPct`: a gap between the ledger and the provider's usage holds paid runs only above max(`marginUsd`, `marginPct`% of the ledger spend). See [Reconcile](#reconcile).                         | 0 / 0                                                                                         |
| `spend`                | `acknowledgedHolds`: the ids (hex) of spend holds a person has looked at; a listed hold no longer refuses paid runs.                                                                                            | none                                                                                          |
| `commands.approved`    | Approved commands, matched by `hash` (the `commandHash`); `kind`, `argv`, `cwd`, `note` are for the reader. The only approvals headless settings honour.                                                        | none                                                                                          |
| `promptPolicy.allow`   | Prompt-policy allow terms.                                                                                                                                                                                      | none                                                                                          |
| `confirmedBy.<path>`   | Who confirmed a field: `method`, `at`, `client`.                                                                                                                                                                | none                                                                                          |

## Refusals

Loading throws `SettingsError`, with the code `settings_invalid`, when:

- the file's real path, or `configDir`, is inside a project (below), whether or not the file exists;
- `$ASSETGROVE_CONFIG` is not absolute or names a missing file;
- the file is not JSON;
- the format is missing, unknown or newer than this build reads;
- any field is unknown, including inside `outputGrant`;
- any field anywhere is named `apiKey`, `key`, `token` or `secret` (in any case); the keys of `providers`, `roles`, `routes` and `confirmedBy` are ids, not field names, so a provider called `key` is accepted;
- `stateDir` is relative or inside a project, or, when it is not set, the default one under the state home is inside a project;
- a `baseURL` carries a user name, a password or a query string (the message shows only its origin and path);
- a `baseURL` is neither https nor http on a loopback host (`localhost`, `127.0.0.0/8`, `[::1]`);
- `free` is set on a provider without a loopback `baseURL`;
- a role or route names a provider that is not in `providers`;
- a limit of kind `unlimited` lacks `acceptUnlimited: true`.

The projects are found from the cwd, `--target` and the directory of each input file's real path (so an input that is a symlink counts for the project it points into). Each directory at or above one of these, and below the home directory, that holds `.git`, as a directory or a file, is a project. A repository at the home directory itself (a dotfiles repository) is not a project, since it would hold every default config and state directory. A `.git` file (a linked worktree or a submodule) also makes a project of the work tree whose `.git` directory holds the Git directory it names: a linked worktree's main checkout, found through its `commondir`, or a submodule's superproject. A `.git` directory also makes a project of each of its linked worktrees, named in `.git/worktrees/<name>/gitdir`, so a sibling worktree counts too. Paths are compared by their native real path (which expands Windows 8.3 short names), case-insensitively on Windows and macOS.

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

| Role                          | Operations                                                                                                                            | Capability          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `image`                       | `still`, `sheet`                                                                                                                      | image               |
| `edit`                        | `edit`, `lookdev`, `fix`                                                                                                              | edit                |
| `vision`                      | `vision`, `flicker`, `holes`, `lookdev-locate`, `lookdev-groom`, `lookdev-markings`, `identity-cast`, `identity-check`, `material-qa` | vision              |
| `decisions`                   | `identity`, `prompt-policy`                                                                                                           | decide              |
| `planning`                    | `compiler`                                                                                                                            | vision              |
| `model3d`, `rig3d`, `clips3d` | the operation of the same name                                                                                                        | model, rig, animate |

An operation's route is `routes.<operation>`, else `roles.<role>`, else the default route of the first configured provider (by id) whose adapter has one for it: the gateway and OpenAI serve the 2D operations, Anthropic the vision, decisions and planning ones, Tripo the 3D ones, openai-compatible none (route each role to it), and the scripted adapter (the test stand-in) all of them, but only where no other configured provider has a default, so it never takes an operation from a real provider. The route must name a configured provider whose adapter has the role's capability; otherwise the command exits 2 `route_unavailable` before any reservation, naming the operation and the fields that would serve it.

**Grants belong to (provider, model).** A default route carries the grant its provider's terms give, and its terms. An override that names the default's provider and model keeps them; one that changes either, or routes an operation with no default, belongs to another pair and takes nothing from the default: it carries only its own `estimatedCostUsd`, `outputGrant` and `providerTerms`, and no size or provider options. Such an override must set `estimatedCostUsd` unless its provider is `free` or scripted; otherwise loading the routes exits 2 `settings_invalid`, since every paid call reserves its estimate before it is made. A call without a grant is refused at hand-off: see [Provider output grants](decisions.md#provider-output-grants). `estimatedCostUsd` sets the amount reserved before each call.

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
| `tripo`             | `balance-delta` | The balance read at the run's start and end (`GET /user/balance`), priced with `usdPerCredit`; without it, `failed`.                                |
| `anthropic`         | `unavailable`   | An ordinary key reads no usage.                                                                                                                     |
| `openai`            | `unavailable`   | An ordinary key reads no usage.                                                                                                                     |
| `openai-compatible` | `unavailable`   | The server reports no usage.                                                                                                                        |
| `scripted`          | `unavailable`   | Unless its script sets `reconcile` and `callCost` (tests).                                                                                          |

`settings check` reports each provider's `reconcile`. The ledger side is the run's reservations in `spend.jsonl` that no earlier attempt's end has reconciled, so a resume also compares the spend of an attempt that stopped before its end; the run directory's `reconcile-state.json` keeps what was reconciled and, for a balance delta, the start reading of an attempt that has not ended (the delta then spans both attempts). A per-call-cost call the provider can never look up (no generation ID, an ID the gateway rejects, or no numeric cost) is counted in `unmatched`, on neither side. `status` is `unavailable`, `reconciled`, `held`, `pending` or `failed`: a balance that could not be read, a run none of whose paid calls could be looked up (nothing was compared), or a lookup still unanswered a day after its run.

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

## Who writes the file

`assetgrove settings change` (MCP tool `settings_change`) is the only command that writes the file, and it writes only the caps, one provider's `limit` and `spend.acknowledgedHolds`, each on a person's confirmation. An agent may propose a change, but only a confirmed form writes it. An MCP client with form elicitation shows a flat form with the proposed values filled in and `acceptUnlimited` as its own Boolean, and an accept writes the values the person submitted. Otherwise the command exits 8 `confirmation_required`, and `assetgrove confirm <id>` at a terminal writes the change. Headless settings exit 8 and write nothing.

A write edits the file in place with `jsonc-parser`: it changes only the proposed fields and adds `confirmedBy.<field path>` = `{method, at, client?}` for each (`caps.runUsd`, `providers.<id>.limit`, `spend.acknowledgedHolds`), with method `elicitation` or `terminal`. Every other byte stays as it was: a new field goes on its own indented lines inside an object that spans lines, and on the same line inside a one-line object, and no neighbouring field is re-laid out. Which provider entries exist and which holds are already acknowledged are read from the file at the moment of writing, so a later change in the same server session keeps what an earlier one, or a hand edit, put there. A limit for a core adapter id with no provider entry creates the entry with only `limit`, so a first setup on one core key needs no hand edit. `kind: "unlimited"` is written only with `acceptUnlimited: true`. The result is loaded as settings before it replaces the file, so the command never writes a file the settings would refuse. With no file, the change creates one at the default location holding the format line.

A person edits every other field by hand. Headless mode is set only by an operator who edits the file or the environment outside the repository.

## Format lines

`readFormat(kind, value, source)` checks `format: "assetgrove-<kind>/<n>"` for `target-profile`, `style-bible`, `style-preset`, `recipe`, `settings` and `blocklist`, all currently at /1. It refuses with `format_unsupported` (`FormatError`), with reason `missing` (the message names the line to add), `too_new` or `unknown`. An older version moves forward in memory through steps registered with `registerMigration(kind, from, migrate)`, and the result reports `migratedFrom`.

## Environment

Settings and the refusal rule read the environment through `src/env.ts`. The only variable that steers spend is `ASSETGROVE_WORK_ITEM`; the adapters read only their key variables (`keyEnv`). `checkEnvironment(allow, env)` refuses with `settings_invalid` when `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` is set, in either case, and `environment.allow` does not list it. Each of these can redirect or unwrap the TLS that carries a key.

## Tests

`test/fixtures/env.ts` makes one temporary directory outside any repository and puts a settings file and that file's `stateDir` in it, then points `ASSETGROVE_CONFIG` there. The ledger is `<stateDir>/spend.jsonl`. The base settings declare a limit for the scripted provider: `providers.scripted.limit = {kind: "prepaid", usd: 100}`. The fixture unsets every variable `checkEnvironment` refuses, in both cases, for the test process and its children. Its helpers `writeSettings`, `useHeadless`, `approveCommand` and `declareLimit` rewrite the settings file; `approve` and `approveProfile` write approval records to `<configDir>/approvals/<hex>.json` for a provider script, a validator or a material command, and those last for the whole test file; `resetSettings` restores the base settings and runs before every top-level test, so a helper's change lasts only for the test that made it and its subtests.
