# Local style route

The local-style extension runs a developer-owned graph through core's approved command runner. It does not train a model or call a paid remote provider. Install `packages/assetgrove-local-style` as a local package and list it in developer settings `extensions`; configure `extensionSettings` for its package with:

```json
{
  "executable": "/absolute/path/to/node",
  "graph": "/absolute/path/to/approved-graph.cjs",
  "model": "my-local-model-version",
  "endpoint": "http://127.0.0.1:8188"
}
```

Configure a provider with adapter `local-style:image`, `free: true`, and `baseURL` equal to the extension endpoint and route the image operation to the exact configured model. The adapter accepts only an HTTP loopback endpoint in its extension settings. Repository provider options never select a graph or destination. Executable and graph must be absolute paths. The developer is responsible for selecting graph code they trust: approved executable code can access the computer's resources.

The command receives graph path, endpoint and model as its arguments. For Node, the graph is the script. It runs in isolated scratch with `input/request.json`, containing the image request, references as media type and base64 bytes, and `identity` with exact model, graph path, graph SHA256 and endpoint. It must write `output/image.png`. Its output evidence is the provider's local request ID, a JSON object with the same identity, approval command hash and output SHA256. The provider ID and model remain in ordinary call provenance. A changed graph changes the approved command digest and requires a fresh approval; approve with the normal `assetgrove confirm` flow or headless `commands.approved` settings.

For a scripted doctor, import the named `doctor` export from the extension entry and call it with the same developer settings. It returns `mediaEndpoint`, `model`, `graph` and `source`; without a source declaration `source` is `unknown`. A local endpoint is a destination disclosure, never evidence about model training sources. A graph must use the supplied destination; it is trusted executable code, not sandboxed code.
