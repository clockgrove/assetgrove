# Quick start

The short path from nothing to a first picked asset, in Claude Code. Other harnesses follow the same steps with their own recipe in [keys.md](keys.md).

You need Node 24, Git with Git LFS, a game repository, and one provider key with a spend limit set at the provider.

## 1. Install

Until the 0.2.0 release candidate is published, check this repository out at a pinned commit and install its dependencies:

```sh
git clone https://github.com/clockgrove/assetgrove.git && cd assetgrove
pnpm install --frozen-lockfile
```

## 2. Keys: register the server

Each step carries its id from the Claude Code recipe (`keyRecipe("claude-code")` in `src/keys.ts`, the same ids as [keys.md](keys.md) and [testing-hosts.md](testing-hosts.md)). A test checks that the ids here match the recipe. `init` returns the same steps, with your own config and state directories filled in.

- `key:claude-code.user-scope`: register the server at user scope, with the key in the server's env:

  ```sh
  claude mcp add --scope user --env AI_GATEWAY_API_KEY=<key> assetgrove -- node /abs/path/to/assetgrove/src/cli.ts mcp
  ```

- `key:claude-code.deny-read`: in `~/.claude/settings.json`, deny reads of `~/.claude.json`, the config directory and the state directory, in the tools and in the sandbox.
- `key:claude-code.deny-edit`: in the same file, deny edits to the config and state directories.
- `key:claude-code.no-provider-hosts`: keep the provider hosts out of the sandbox network allowlist.
- `key:claude-code.shell-env`: do not export the key from a shell profile the agent's shell starts with.

Never put the key in the game repository, in a project-scope `.mcp.json` or in the agent's shell.

## 3. init

In Claude Code, in the game repository, ask the agent to set up Assetgrove. It runs the `init` tool, the same as:

```sh
node /abs/path/to/assetgrove/src/cli.ts init --directory . --profile-preset sprite-32 --style-preset cozy-storybook --world "My World" --json
```

`init` writes the target profile (`.assetgrove/profile.json`), the style bible (`.assetgrove/art-direction/BIBLE.md`), the prompt template, the `art-direction` skill in `.claude/skills/` and `.agents/skills/`, and `.gitignore` rules for the output folders. It refuses a repository that tracks a key, and never writes a key, the settings file or a harness config. Running it again changes nothing. It returns the steps still to take, the questions to draft the bible with, and where each route sends data (`providers`). Providers may retain what they receive.

## 4. Settings: caps and the provider's limit

The agent calls `settings_change` with the caps and your provider's limit; you confirm them in the form, or with `assetgrove confirm <id>` at a terminal. Only your confirmation writes the settings. Then the agent runs `spend check` to show whether each provider's limit is declared and verified. Provider endpoints and roles are hand edits ([settings.md](settings.md)).

## 5. A first asset

Ask the agent for an asset. It stages candidates with `stage` (a `--dry-run` first shows the cost), and hands you the run directory and candidate ids. You look at them and pick one:

```sh
node /abs/path/to/assetgrove/src/cli.ts pick --run .assetgrove/runs/<run> --candidate <id> --target .
```

`pick` writes the file and its manifest with full provenance and review pending. Commit it as any other change.
