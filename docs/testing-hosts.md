# Testing hosts

A checklist for driving the real `assetgrove mcp` server through four harnesses: the `stage` tool, then the `pick` tool on its run. The server is a stdio MCP server; both tools carry `_meta["anthropic/requiresUserInteraction"] = true`.

What the person should see, with a client that declares form elicitation:

- `stage` returns an input-required form. It shows the jobs, candidates, cost forecast, run cap, providers and digest, and has a Boolean `approve`.
- `pick` returns a form showing the run, the contact-sheet path and the digest. It asks for `candidate`, an enum of the run's candidate ids plus `none`, and an optional `note`.
- Accepting writes a record at `<configDir>/confirmations/<digest>.json` with method `elicitation`, the client's name and its protocol version.
- Declining exits 8 `confirmation_declined`.
- A client without form elicitation gets exit 8 `confirmation_required`, with `assetgrove confirm <id>` to finish in a terminal.
- `stage` returns the run's contact sheet (`contact.png`) as MCP image content.

## Setup

Run `pnpm install` once. The server runs from the checkout with `node /abs/path/to/repo/src/cli.ts mcp` (Node 24 or later). Use absolute paths in every local config below; the remote-session `.mcp.json` uses `src/cli.ts` relative to the repo root, because the session runs from its own checkout. If a command has changed, check the harness's current docs.

The calls use the developer's own settings (see `docs/settings.md`): a provider key, and a low run cap such as `--cap 0.10`. Generate one candidate (`candidates: 1`). The `stage` call spends a few cents. Prepare a spec, a style bible and a target profile, and give `pick` a scratch target directory, not a real project.

## Claude Code, local

Register:

```sh
claude mcp add assetgrove -- node /abs/path/to/repo/src/cli.ts mcp
```

## Claude Code, remote session (web or phone)

Add a project `.mcp.json` entry in the checkout the session uses. Do not commit it.

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

## GitHub Copilot CLI

Register with `/mcp add` inside the CLI, or edit `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "assetgrove": {
      "type": "local",
      "command": "node",
      "args": ["/abs/path/to/repo/src/cli.ts", "mcp"],
      "tools": ["*"]
    }
  }
}
```

## Codex

Register:

```sh
codex mcp add assetgrove -- node /abs/path/to/repo/src/cli.ts mcp
```

Or edit `~/.codex/config.toml`:

```toml
[mcp_servers.assetgrove]
command = "node"
args = ["/abs/path/to/repo/src/cli.ts", "mcp"]
```

## Observations

Ask the harness to call `stage` with one candidate and a low cap, then `pick` on the run it produced, into a scratch directory. Record each item. Do it in every harness.

- [ ] Spend form shown: `stage` shows jobs, candidates, forecast, cap, providers and digest, and the `approve` Boolean can be answered.
- [ ] Pick form shown: `pick` shows the run, contact-sheet path and digest, and the candidate choice (ids and `none`) can be answered.
- [ ] Decline exits 8 `confirmation_declined`: decline a form and check the exit code and the error.
- [ ] Record written: after accepting, `<configDir>/confirmations/<digest>.json` exists with method `elicitation` and the client's name.
- [ ] Card shown on web or phone (remote session only).
- [ ] Mark honoured in auto mode: with the harness in its auto, yolo or full-auto mode, it still asks you before calling `stage` and `pick` (both carry `_meta["anthropic/requiresUserInteraction"]`).
- [ ] Progress seen: progress shows in the harness while `stage` runs.
- [ ] Contact sheet reaches the person: record how, as an image rendered inline, a path only, or not at all.
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
| Mark honoured, auto        |                   |                    |             |       |
| Progress seen during stage |                   |                    |             |       |
| Contact sheet reaches you  |                   |                    |             |       |
| Unattended (headless)      |                   |                    |             |       |
| Disconnect behaviour       |                   |                    |             |       |

Record the results, and the chosen third gate harness, in `docs/decisions.md`.
