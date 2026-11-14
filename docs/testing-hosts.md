# Testing hosts

A checklist for trying `scripts/host-probe.ts` in four harnesses. The probe is a throwaway stdio MCP server named `assetgrove-host-probe` with one tool, `probe`.

What `probe` does:

- Carries `_meta["anthropic/requiresUserInteraction"] = true`.
- Asks an elicitation form: an `approve` Boolean and a `choice` enum (`red`, `green`, `blue`).
- After acceptance, sends `notifications/progress` every `intervalSeconds` (default 5) for `durationSeconds` (default 120), first tick at once.
- Returns a text block `choice: <value>` and a 64×64 PNG in the chosen colour.
- Declining, cancelling or `approve=false` returns `isError`.
- Logs each progress tick and any cancellation to stderr.

## Setup

Run `pnpm install` once. The probe runs with `node scripts/host-probe.ts` from the repo root (Node 24 or later). Use absolute paths in every config below. If a command has changed, check the harness's current docs.

## Claude Code, local

Register:

```sh
claude mcp add assetgrove-host-probe -- node /abs/path/to/repo/scripts/host-probe.ts
```

## Claude Code, remote session (web or phone)

Add a project `.mcp.json` entry in the checkout the session uses. Do not commit it.

```json
{
  "mcpServers": {
    "assetgrove-host-probe": {
      "command": "node",
      "args": ["scripts/host-probe.ts"]
    }
  }
}
```

## GitHub Copilot CLI

Register with `/mcp add` inside the CLI, or edit `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "assetgrove-host-probe": {
      "type": "local",
      "command": "node",
      "args": ["/abs/path/to/repo/scripts/host-probe.ts"],
      "tools": ["*"]
    }
  }
}
```

## Codex

Register:

```sh
codex mcp add assetgrove-host-probe -- node /abs/path/to/repo/scripts/host-probe.ts
```

Or edit `~/.codex/config.toml`:

```toml
[mcp_servers.assetgrove-host-probe]
command = "node"
args = ["/abs/path/to/repo/scripts/host-probe.ts"]
```

## Observations

Ask the harness to call `probe` with default arguments, then record each item. Do it in every harness.

- [ ] Form shown: the `approve` and `choice` fields appear and can be answered.
- [ ] Card shown on web or phone (remote session only).
- [ ] Mark honoured in auto mode: with the harness in its auto, yolo or full-auto mode, it still asks you before calling `probe`.
- [ ] Progress seen: ticks show in the harness while the call runs.
- [ ] Image seen: the PNG renders in the chosen colour.
- [ ] Two-minute call completes with default arguments and returns `choice: <value>`.
- [ ] Disconnect: start a call, then stop or interrupt it mid-progress. Note what the harness shows and what the probe logs on stderr.

## Results

| Observation          | Claude Code local | Claude Code remote | Copilot CLI | Codex |
| -------------------- | ----------------- | ------------------ | ----------- | ----- |
| Form shown           |                   |                    |             |       |
| Card on web or phone | n/a               |                    | n/a         | n/a   |
| Mark honoured, auto  |                   |                    |             |       |
| Progress seen        |                   |                    |             |       |
| Image seen           |                   |                    |             |       |
| Two-minute call      |                   |                    |             |       |
| Disconnect behaviour |                   |                    |             |       |

Record the results, and the chosen third gate harness, in `docs/decisions.md`.
