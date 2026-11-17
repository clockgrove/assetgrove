# Keys

Assetgrove reads provider keys from the environment of the server process only. It never writes or prints a key.

The agent holds a shell. The controls below stop an over-eager or drifting agent, and text in shared files that tries to steer one. They do not stop an agent set on getting round them. The hard money limit is the provider's: set a spend limit with the provider (see [settings](settings.md)).

The command line and `NODE_OPTIONS` cannot be defended from inside the process, so a project-scope harness config is code the developer reviews. Register the server at user scope, with the key in the server's `env`, never in the project. If a command has changed, check the harness's current docs.

Each step has a stable id, marked `key:<id>`. [testing-hosts.md](testing-hosts.md) uses the same ids, and a test checks they agree. `src/keys.ts` (`keyRecipe`) holds the same recipes.

`init` lists the adapters of every pack in the settings' `extensions` list with their declared hosts and key variable. A recipe includes them: the Claude Code recipe's provider hosts include a pack adapter's fixed hosts, and each harness's first step names the pack adapters' key variables to put in the server's env beside `AI_GATEWAY_API_KEY`.

## Claude Code

- `key:claude-code.user-scope`: register at user scope with the key in the server's env:

  ```sh
  claude mcp add --scope user --env AI_GATEWAY_API_KEY=<key> assetgrove -- node /abs/path/to/repo/src/cli.ts mcp
  ```

- `key:claude-code.deny-read`: in `~/.claude/settings.json`, deny reads of `~/.claude.json`, `<configDir>` and `<stateDir>`, in the tools and in the sandbox:

  ```json
  {
    "permissions": {
      "deny": ["Read(~/.claude.json)", "Read(//<configDir>/**)", "Read(//<stateDir>/**)"]
    },
    "sandbox": {
      "filesystem": { "denyRead": ["~/.claude.json", "<configDir>", "<stateDir>"] }
    }
  }
  ```

- `key:claude-code.deny-edit`: deny edits to `<configDir>` and `<stateDir>` in `permissions.deny`: `Edit(//<configDir>/**)` and `Edit(//<stateDir>/**)`. Use the absolute paths of the directories `settings check` reports; `//` marks an absolute path.
- `key:claude-code.no-provider-hosts`: keep `ai-gateway.vercel.sh`, `api.anthropic.com`, `api.openai.com` and `api.tripo3d.ai` out of the sandbox network allowlist.
- `key:claude-code.shell-env`: do not export the key from a shell profile the agent's shell starts with.

Limits:

- Deny rules and the sandbox bind the harness's tools and the shell it starts. A shell outside them is not stopped.
- The agent can still run Assetgrove's commands; the caps and the provider's limit bound the spend.

## Claude Code, cloud

- `key:claude-code-cloud.secret-key`: the environment's setup supplies `AI_GATEWAY_API_KEY` as a secret.
- `key:claude-code-cloud.config-outside-checkout`: the setup writes the developer settings outside the checkout and points `ASSETGROVE_CONFIG` at the file. A `.mcp.json` in the checkout is project scope: review it as code and leave it uncommitted.

Limits:

- The key is in the session's environment, so the agent's shell can read it. The provider's cap is the limit.

## GitHub Copilot CLI

- `key:copilot-cli.user-scope`: register in `~/.copilot/mcp-config.json` with the key in the server's `env`:

  ```json
  {
    "mcpServers": {
      "assetgrove": {
        "type": "local",
        "command": "node",
        "args": ["/abs/path/to/repo/src/cli.ts", "mcp"],
        "env": { "AI_GATEWAY_API_KEY": "<key>" },
        "tools": ["*"]
      }
    }
  }
  ```

- `key:copilot-cli.shell-env`: do not export the key from a shell profile the agent's shell starts with.

Limits:

- The CLI has no read deny for the agent's shell: it can read `~/.copilot/mcp-config.json` and `<configDir>`, and reach the provider hosts.

## Codex

- `key:codex.user-scope`: register in `~/.codex/config.toml` with the key in the server's `env`:

  ```toml
  [mcp_servers.assetgrove]
  command = "node"
  args = ["/abs/path/to/repo/src/cli.ts", "mcp"]
  env = { AI_GATEWAY_API_KEY = "<key>" }
  ```

- `key:codex.shell-sandbox`: keep the shell sandboxed with the network off, so it cannot reach the provider hosts.
- `key:codex.shell-env-policy`: set `shell_environment_policy` so the key variables are not passed to the agent's shell.

Limits:

- The agent's shell may still read `~/.codex/config.toml` unless the sandbox hides it, and with the network on it can reach the provider hosts.

## Other harnesses

- `key:other.user-scope`: register `node /abs/path/to/repo/src/cli.ts mcp` in the harness's user-level config, with `AI_GATEWAY_API_KEY` in the server's `env`.
- `key:other.shell-env`: do not export the key from a shell profile the agent's shell starts with.

Limits:

- Whatever the harness does not deny, the agent's shell can read, including the config file that holds the key.
