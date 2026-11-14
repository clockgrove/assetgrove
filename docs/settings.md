# Developer settings

Developer settings are one per-user file outside every project, and the only input that steers money, code or keys. Shared files (target profile, style bible, presets, recipes) and request inputs travel between developers, so they never name an endpoint, a cap above the settings, a route, a grant or a command. `src/settings.ts` loads the file, `src/formats.ts` checks its format line and `src/env.ts` supplies every environment value they use.

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

## Providers and spend

Providers come from `providers`. An entry's adapter is its `adapter`, else its id. The core adapters:

- `vercel-ai-gateway`: key `AI_GATEWAY_API_KEY`, fixed host `ai-gateway.vercel.sh`; accepts a `baseURL`.
- `tripo`: key `TRIPO_API_KEY`, fixed host `api.tripo3d.ai`; takes no `baseURL`; `usdPerCredit` prices its credits.
- `scripted`: tests and offline runs (`--provider-script`); free unless the script sets `paid: true`. A script may supply `limitReading()` returning `{ balanceUsd }`.

`keyEnv` names the key variable; the default is per adapter. `apiKey` and `baseURL` are passed to the SDK explicitly, so `*_BASE_URL` variables (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `AI_GATEWAY_BASE_URL`) never apply. Paid-ness comes from the adapter's billing descriptor, never the provider's name. Without `--provider-script`, a command uses the first configured provider with adapter `vercel-ai-gateway` (`tripo` for 3D calls), else that core adapter under its own id with no settings. Adapters copy only the message, status and provider code into errors, never a response body.

Spend is recorded in `<stateDir>/spend.jsonl`. The run cap is the lower of `caps.runUsd` and `--cap` (or the command's own default); a `--cap` above `caps.runUsd` exits 3 (`cap_refused`). The daily and work-item caps are the settings value or the target profile's `spend.dailyLimitUsd` and `spend.workItemLimitUsd`, whichever is lower. The work item comes from `--work-item` or `ASSETGROVE_WORK_ITEM`. A plan's `capUsd` is clipped to `caps.runUsd`.

A paid call to a provider with no declared `limit`, or `unlimited` without `acceptUnlimited: true`, exits 3 (`provider_limit_undeclared`) before any spend. Only a `prepaid` limit with `usd` is verified from a balance: verified when the balance is at most `usd`, and a balance above it exits 3 (`provider_limit_mismatch`). A gateway 402 quota error and an OpenAI 429 `insufficient_quota` exit 3 (`cap_refused`).

What a key can carry, and what Assetgrove reads, as checked on 2026-11-14:

| Provider          | Limit a key can carry                                      | Read by Assetgrove                                                                   | Source                                                                                            | Checked    |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------- |
| Vercel AI Gateway | Prepaid team credits; per-key budgets set in the dashboard | Yes: the credits balance, through the gateway credits endpoint (AI SDK `getCredits`) | https://vercel.com/docs/ai-gateway/pricing, https://ai-sdk.dev/docs/reference/ai-sdk-core/gateway | 2026-11-14 |
| Anthropic         | Workspace spend limits set in the Console                  | No: not readable by an ordinary API key; declared only                               | https://docs.claude.com/en/api/rate-limits                                                        | 2026-11-14 |
| OpenAI            | Project budgets and usage limits set in the dashboard      | No: not readable with an ordinary key; declared only                                 | https://platform.openai.com/docs/guides/rate-limits                                               | 2026-11-14 |
| Tripo             | Prepaid credits                                            | Yes: the account balance (`/user/balance`)                                           | https://platform.tripo3d.ai/docs/balance                                                          | 2026-11-14 |

## Commands

- `settings path|show|check [--json]`: read-only. `show` never holds a key. `check` reports, per provider, `keyPresent`, `declared`, `verified`, `reading` and `reconcile`, plus the refused environment variables that are set.
- `spend status [--work-item <label>]`: the ledger, caps, work item, `todayUsd` and limits.
- `spend check [--provider <id>] [--provider-script <module>]`: per configured provider, `{ provider, adapter, paid, declared, verified, reading }`. Gateway credits and the Tripo balance are read; Anthropic and OpenAI are declared only.

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

Refusals that depend on the adapter happen when providers are created, in every command: an unknown adapter id, or a `baseURL` on an adapter that takes none, is `settings_invalid`. A limit of kind `unlimited` without `acceptUnlimited: true` loads, but a paid call to that provider exits 3 (`provider_limit_undeclared`). A command's result document keeps a thrown error's own code when it is in the exit table, so `SettingsError` reports `settings_invalid` and `FormatError` reports `format_unsupported`, both with exit 2.

## Format lines

`readFormat(kind, value, source)` checks `format: "assetgrove-<kind>/<n>"` for `target-profile`, `style-bible`, `style-preset`, `recipe`, `settings` and `blocklist`, all currently at /1. It refuses with `format_unsupported` (`FormatError`), with reason `missing` (the message names the line to add), `too_new` or `unknown`. An older version moves forward in memory through steps registered with `registerMigration(kind, from, migrate)`, and the result reports `migratedFrom`.

## Environment

Settings and the refusal rule read the environment through `src/env.ts`. The spend ledger and the provider setup do not read `process.env` for the ledger or the limits; the providers read only their key variables (`AI_GATEWAY_API_KEY`, `TRIPO_API_KEY`, or the `keyEnv` named in settings), and `ASSETGROVE_WORK_ITEM` is the one spend variable. `checkEnvironment(allow, env)` refuses with `settings_invalid` when `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` is set, in either case, and `environment.allow` does not list it. Each of these can redirect or unwrap the TLS that carries a key.

## Tests

`test/fixtures/env.ts` makes one temporary directory outside any repository and puts a settings file and that file's `stateDir` in it, then points `ASSETGROVE_CONFIG` there; the spend ledger is `spend.jsonl` in that `stateDir`. The base settings declare a limit for the `scripted` provider; a test that needs none rewrites the settings. The fixture unsets every variable `checkEnvironment` refuses, in both cases, for the test process and its children. Its helpers `writeSettings`, `useHeadless`, `approveCommand` and `declareLimit` rewrite the settings file; `resetSettings` restores the base settings and runs before every top-level test, so a helper's change lasts only for the test that made it and its subtests.
