# Testing hosts

A checklist for driving the real `assetgrove mcp` server through four harnesses: the `stage` tool, then the `pick` tool on its run. The server is a stdio MCP server; both tools carry `_meta["anthropic/requiresUserInteraction"] = true`.

What the person should see, with a client that declares form elicitation:

- `stage` returns an input-required form. It shows the jobs, candidates, cost forecast, run cap, providers and digest, and has a Boolean `approve`.
- `pick` returns a form showing the run, the contact-sheet path and the digest. It asks for `candidate`, an enum of the run's candidate ids plus `none`, and an optional `note`, which the confirmation record does not store.
- Accepting writes a record at `<configDir>/confirmations/<digest>.json` with method `elicitation`, the client's name and its protocol version.
- Declining exits 8 `confirmation_declined`.
- A client without form elicitation gets exit 8 `confirmation_required`, with `assetgrove confirm <id>` to finish in a terminal.
- `stage` returns the run's contact sheet (`contact.png`) as MCP image content.

## Setup

Run `pnpm install` once. The server runs from the checkout with `node /abs/path/to/repo/src/cli.ts mcp` (Node 24 or later). Use absolute paths in every local config below; the remote session's environment setup uses `src/cli.ts` relative to the checkout it runs from. Key handling for each harness is in [keys.md](keys.md); the steps below carry its ids. If a command has changed, check the harness's current docs.

The calls use the developer's own settings (see `docs/settings.md`): a provider key, and a low run cap such as `--cap 0.10`. Generate one candidate (`candidates: 1`). The `stage` call spends a few cents. Prepare a spec, a style bible and a target profile, and give `pick` a scratch target directory, not a real project.

## Read-only discovery check

For a client that should inspect an existing library, use
`node /abs/path/to/repo/src/cli.ts mcp --read-only --target /abs/path/to/project`
instead. No generation key is needed for library resource reads. The exposed
tools and their effects are listed in [Read-only MCP mounting](library.md#read-only-mcp-mounting).

- [ ] `resources/list` and `resources/templates/list` expose the library; read the
      root, a `by-kind` folder and a card with `resources/read`.
- [ ] `ls` and `cat` browse the same library when the host does not render resources.
- [ ] Read `assetgrove-library://facets` and compare its `kinds` and canonical
      `labels` counts with the fixture cards, including supported kinds with zero assets.
- [ ] Read a listed `assetgrove-candidate://` link and compare its decoded bytes
      with the staged candidate's sha256. Changing the file makes that link refuse
      the read. Oversized media reports a pointer with its hash and size.
- [ ] Direct calls to `card_edit`, `stage` and `pick` are refused, including in
      headless mode; no edit, generation spend or pick is made.
- [ ] Reconnect without `--read-only` to test the spend and pick forms below.
      A client without form elicitation still receives `confirmation_required`
      and the terminal command `assetgrove confirm <id>`; resource support alone
      does not authorize a pick.

## Claude Code, local

Register at user scope, with the key in the server's env (`key:claude-code.user-scope`):

```sh
claude mcp add --scope user --env AI_GATEWAY_API_KEY=<key> assetgrove -- node /abs/path/to/repo/src/cli.ts mcp
```

- `key:claude-code.deny-read`: deny reads of `~/.claude.json`, configDir and stateDir (permissions and sandbox `denyRead`).
- `key:claude-code.deny-edit`: deny edits to configDir and stateDir.
- `key:claude-code.no-provider-hosts`: no provider hosts in the sandbox network allowlist.
- `key:claude-code.shell-env`: the key is not exported from the agent's shell profile.

## Claude Code, remote session (web or phone)

- `key:claude-code-cloud.secret-key`: the environment's setup supplies `AI_GATEWAY_API_KEY` as a secret.
- `key:claude-code-cloud.config-outside-checkout`: the setup writes the settings outside the checkout and sets `ASSETGROVE_CONFIG`. Register the server in the environment's own user-level config. A project `.mcp.json` in the checkout is code the developer reviews; if you use one, leave it uncommitted:

```json
{
  "mcpServers": {
    "assetgrove": {
      "command": "node",
      "args": ["src/cli.ts", "mcp"]
    }
  }
}
```

In this harness the key is in the session's environment, so the agent's shell can read it; expect the key-variable observation to fail and record it.

## GitHub Copilot CLI

- `key:copilot-cli.user-scope`: register with `/mcp add` inside the CLI, or edit `~/.copilot/mcp-config.json`, with the key in the server's `env`:

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

- `key:copilot-cli.shell-env`: the key is not exported from the agent's shell profile.

## Codex

- `key:codex.user-scope`: edit `~/.codex/config.toml`, with the key in the server's `env`. `codex mcp add` can register the command; add the `env` line by hand.

```toml
[mcp_servers.assetgrove]
command = "node"
args = ["/abs/path/to/repo/src/cli.ts", "mcp"]
env = { AI_GATEWAY_API_KEY = "<key>" }
```

- `key:codex.shell-sandbox`: the shell is sandboxed with the network off.
- `key:codex.shell-env-policy`: `shell_environment_policy` keeps key variables out of the shell.

## Observations

Ask the harness to call `stage` with one candidate and a low cap, then `pick` on the run it produced, into a scratch directory. Record each item. Do it in every harness.

- [ ] Spend form shown: `stage` shows jobs, candidates, forecast, cap, providers and digest, and the `approve` Boolean can be answered.
- [ ] Pick form shown: `pick` shows the run, contact-sheet path and digest, and the candidate choice (ids and `none`) can be answered.
- [ ] Decline exits 8 `confirmation_declined`: decline a form and check the exit code and the error.
- [ ] Record written: after accepting, `<configDir>/confirmations/<digest>.json` exists with method `elicitation` and the client's name.
- [ ] Key variable empty in the agent's shell: ask the agent to run `printenv AI_GATEWAY_API_KEY`; it prints nothing.
- [ ] Provider host unreachable from the shell: ask the agent to run `curl -sS https://ai-gateway.vercel.sh` in its shell; it fails.
- [ ] Card shown on web or phone (remote session only).
- [ ] Mark honoured in auto mode: with the harness in its auto, yolo or full-auto mode, it still asks you before calling `stage` and `pick` (both carry `_meta["anthropic/requiresUserInteraction"]`).
- [ ] Progress seen: progress shows in the harness while `stage` runs.
- [ ] Contact sheet reaches the person: record how, as an image rendered inline, a path only, or not at all.
- [ ] Candidate links reach the person: inspect the staging result's `resource_link` content and the pick form's `candidateResources`; read a link before answering the sealed form.
- [ ] Unattended (headless) session: with headless settings (`headless.operator`, see `docs/settings.md`), `stage` runs without a form and `pick` must name its candidate. Record whether the harness can run it unattended.
- [ ] Disconnect: start a `stage` call, then stop or interrupt it mid-run. Note what the harness shows and what the server leaves behind.

## Results

| Observation                | Claude Code local | Claude Code remote | Copilot CLI | Codex |
| -------------------------- | ----------------- | ------------------ | ----------- | ----- |
| Spend form shown (stage)   |                   |                    |             |       |
| Pick form shown, candidate |                   |                    |             |       |
| Decline exits 8            |                   |                    |             |       |
| Record written             |                   |                    |             |       |
| Card on web or phone       | n/a               |                    | n/a         | n/a   |
| Key variable empty (shell) |                   |                    |             |       |
| Provider host unreachable  |                   |                    |             |       |
| Mark honoured, auto        |                   |                    |             |       |
| Progress seen during stage |                   |                    |             |       |
| Contact sheet reaches you  |                   |                    |             |       |
| Unattended (headless)      |                   |                    |             |       |
| Disconnect behaviour       |                   |                    |             |       |

Record the results in `docs/decisions.md`.
