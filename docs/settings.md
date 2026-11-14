# Developer settings

Developer settings are one per-user file outside every project, and the only input that steers money, code or keys. Shared files (target profile, style bible, presets, recipes) and request inputs travel between developers, so they never name an endpoint, a cap above the settings, a route, a grant or a command. `src/settings.ts` loads the file, `src/formats.ts` checks its format line and `src/env.ts` supplies every environment value they use.

`assetgrove settings path|show|check` reads them without changing anything, and `assetgrove spend status|check` reports the caps, the ledger and the provider limits. Both are also MCP tools with an `action` argument. `settings show` never holds a key: it shows each provider's `keyEnv` and `keyPresent`.

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
  "routes": { "<operation>": { "provider": "<id>", "model": "..." } },
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

| Field                  | Meaning                                                                                                                                                  | Default                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `format`               | `assetgrove-settings/1`. Required.                                                                                                                       | —                                                                                             |
| `stateDir`             | Absolute directory for run state; never inside a project.                                                                                                | `<stateHome>/assetgrove` (`$XDG_STATE_HOME` or `~/.local/state`; `%LOCALAPPDATA%` on Windows) |
| `headless.operator`    | Present: headless mode, run by this operator. Set only by an operator outside the repository.                                                            | attended                                                                                      |
| `caps`                 | `runUsd`, `dailyUsd`, `workItemUsd`. Shared files may lower them, never raise them.                                                                      | 5 / 10 / 5                                                                                    |
| `providers.<id>`       | `adapter`, `keyEnv` (the variable that holds the key, never the key), `baseURL`, `free`, `usdPerCredit`, `limit`. An entry may hold only `limit`.        | none                                                                                          |
| `providers.<id>.limit` | `kind`: `key-budget`, `team-budget`, `project-hard-limit`, `workspace-limit`, `prepaid` or `unlimited` (needs `acceptUnlimited: true`); `usd`; `period`. | none                                                                                          |
| `roles.<role>`         | `provider`, `model`, `outputGrant` (`license`, `plan`, `commercial`, `relabel`, `attribution`), `providerTerms`.                                         | none                                                                                          |
| `routes.<operation>`   | `provider`, `model`.                                                                                                                                     | none                                                                                          |
| `extensions`           | Packages whose extension code may run.                                                                                                                   | none                                                                                          |
| `environment.allow`    | Refused environment variables (below) that are allowed anyway.                                                                                           | none                                                                                          |
| `reconcile`            | `marginUsd`, `marginPct`.                                                                                                                                | none                                                                                          |
| `spend`                | `acknowledgedHolds`: hex hashes of acknowledged holds.                                                                                                   | none                                                                                          |
| `commands.approved`    | Approved commands: `hash` (hex), `kind`, `argv`, `cwd`, `note`.                                                                                          | none                                                                                          |
| `promptPolicy.allow`   | Prompt-policy allow terms.                                                                                                                               | none                                                                                          |
| `confirmedBy.<path>`   | Who confirmed a field: `method`, `at`, `client`.                                                                                                         | none                                                                                          |

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
- a role or route names a provider that is not in `providers`.

The projects are found from the cwd, `--target` and the directory of each input file's real path (so an input that is a symlink counts for the project it points into). Each directory at or above one of these, and below the home directory, that holds `.git`, as a directory or a file, is a project. A repository at the home directory itself (a dotfiles repository) is not a project, since it would hold every default config and state directory. A `.git` file (a linked worktree or a submodule) also makes a project of the work tree whose `.git` directory holds the Git directory it names: a linked worktree's main checkout, found through its `commondir`, or a submodule's superproject. Paths are compared by their native real path (which expands Windows 8.3 short names), case-insensitively on Windows and macOS.

Refusals that depend on the adapter happen when providers are created: an adapter id that is unknown, or a `baseURL` on the `tripo` adapter. A limit of kind `unlimited` without `acceptUnlimited: true` loads, and is refused at call time (below). A command's result document keeps a thrown error's own code when it is in the exit table, so `SettingsError` reports `settings_invalid` and `FormatError` reports `format_unsupported`, both with exit 2.

## Providers

Every provider instance carries a billing descriptor from its adapter (`src/providers/adapter.ts`). An entry without `adapter` uses its own id as the adapter id. Whether a call is paid comes from the billing, never from the provider's name.

| Adapter             | Billing                                                                            | Entry fields                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `vercel-ai-gateway` | Paid. Key from `keyEnv`, else `AI_GATEWAY_API_KEY`. Host `ai-gateway.vercel.sh`.   | `keyEnv`, `baseURL` (only here), `limit`                                                                                                  |
| `tripo`             | Paid. Key from `keyEnv`, else `TRIPO_API_KEY`. Credits priced with `usdPerCredit`. | `keyEnv`, `usdPerCredit`, `limit`. A `baseURL` exits 2 (`settings_invalid`). Without `usdPerCredit` a call settles at its route estimate. |
| `scripted`          | Free unless its script sets `paid: true` (tests only).                             | none                                                                                                                                      |

The key and `baseURL` are passed to the SDK explicitly, so `*_BASE_URL` environment variables never apply. An adapter's errors keep only the message, the HTTP status and the provider's code, never a response body.

## Caps

`caps` holds `runUsd` (default 5), `dailyUsd` (10) and `workItemUsd` (5). A run's cap is `--cap` when given, else the command's own default, and never above `caps.runUsd`; a `--cap` above `caps.runUsd` exits 3 (`cap_refused`) before any work. The daily and work-item limits are the settings value or the target profile's `spend.dailyLimitUsd` / `spend.workItemLimitUsd`, whichever is lower. A limit's `source` is `settings` or `profile`.

## Ledger

The ledger is `<stateDir>/spend.jsonl`. A reservation records the provider, route, work item and `amountUsd`; a settlement records the cost. The work item is `--work-item` or `ASSETGROVE_WORK_ITEM`; no other spend variable is read.

## Provider limits

A paid call to a provider with no declared `providers.<id>.limit` exits 3 (`provider_limit_undeclared`) before any spend. A limit of kind `unlimited` without `acceptUnlimited: true` is refused the same way at call time. What a key can carry, checked 2026-11-14:

| Provider          | Limit a key can carry                         | Assetgrove reads it                                       | Source                 | Checked    |
| ----------------- | --------------------------------------------- | --------------------------------------------------------- | ---------------------- | ---------- |
| Vercel AI Gateway | Team credit balance, prepaid                  | Yes: `GET /v1/credits`, through the AI SDK's `getCredits` | Vercel AI Gateway docs | 2026-11-14 |
| Anthropic         | Workspace spend limits, set in the Console    | No: declared only                                         | Anthropic Console docs | 2026-11-14 |
| OpenAI            | Project budgets and organization usage limits | No: declared only                                         | OpenAI platform docs   | 2026-11-14 |
| Tripo             | Prepaid credit balance                        | Yes: `GET /user/balance`                                  | Tripo API docs         | 2026-11-14 |

`spend check [--provider <id>]` reports, per configured provider, `{provider, adapter, paid, declared, limit, verified, reading, readingError?, mismatch}`. The gateway reports `remainingUsd`; Tripo reports `credits`, and `remainingUsd` when `usdPerCredit` is set. Anthropic and OpenAI adapters are not in core yet, so their limits are declared only. A reading that contradicts the declaration exits 3 (`provider_limit_mismatch`): a reported `limitUsd` that differs from the declared `usd` by more than a cent, or a prepaid declared limit whose `remainingUsd` exceeds the declared `usd` by more than a cent. A gateway 402 quota error and an OpenAI quota 429 (code `insufficient_quota`) map to `cap_refused` (exit 3).

## Format lines

`readFormat(kind, value, source)` checks `format: "assetgrove-<kind>/<n>"` for `target-profile`, `style-bible`, `style-preset`, `recipe`, `settings` and `blocklist`, all currently at /1. It refuses with `format_unsupported` (`FormatError`), with reason `missing` (the message names the line to add), `too_new` or `unknown`. An older version moves forward in memory through steps registered with `registerMigration(kind, from, migrate)`, and the result reports `migratedFrom`.

## Environment

Settings and the refusal rule read the environment through `src/env.ts`. The provider setup (`src/providers/index.ts`) and the gateway adapters (`src/gateway/vercel.ts`, `src/gateway/tripo.ts`) read `process.env` for provider keys. `checkEnvironment(allow, env)` refuses with `settings_invalid` when `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` is set, in either case, and `environment.allow` does not list it. Each of these can redirect or unwrap the TLS that carries a key.

## Tests

`test/fixtures/env.ts` makes one temporary directory outside any repository and puts a settings file and that file's `stateDir` (which holds the spend ledger) in it, then points `ASSETGROVE_CONFIG` there. It unsets every variable `checkEnvironment` refuses, in both cases, for the test process and its children. Its helpers `writeSettings`, `useHeadless`, `approveCommand` and `declareLimit` rewrite the settings file; `resetSettings` restores the base settings (`format`, `stateDir` and a declared limit for the `scripted` provider, so a script with `paid: true` may spend) and runs before every top-level test, so a helper's change lasts only for the test that made it and its subtests.
