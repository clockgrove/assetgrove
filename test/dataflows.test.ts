import assert from "node:assert/strict";
import { test } from "node:test";
import { routeDataFlows } from "../src/dataflows.ts";
import { defaultRoutes, OPERATION_ROLES } from "../src/routes.ts";
import type { Settings } from "../src/settings.ts";

const settings: Pick<Settings, "providers" | "roles" | "routes" | "path"> = {
  path: "settings.json",
  providers: {
    gateway: { adapter: "vercel-ai-gateway" },
    tripo: {},
    local: { adapter: "openai-compatible", baseURL: "http://127.0.0.1:8080/v1", free: true },
  },
  roles: { image: { provider: "local", model: "local-image" } },
  routes: {},
};

test("every configured operation appears once with its host, and gateway routes name their upstream vendor", () => {
  const flows = routeDataFlows(settings, { env: {} });
  const operations = flows.map((f) => f.operation);
  assert.equal(new Set(operations).size, operations.length, "each operation once");
  assert.deepEqual(
    [...operations].sort(),
    Object.keys(OPERATION_ROLES)
      .filter((op) => op !== "fix" && op !== "prompt-policy")
      .sort(),
  );

  const byOperation = new Map(flows.map((f) => [f.operation, f]));
  // The image role goes to the loopback server: a direct route, data kept local, no terms recorded.
  for (const op of ["still", "sheet"]) {
    assert.deepEqual(byOperation.get(op), {
      operation: op,
      providerId: "local",
      host: "127.0.0.1:8080",
      upstream: null,
      providerTerms: null,
      retention: "local",
    });
  }
  // Gateway routes name the model vendor behind the gateway.
  const edit = byOperation.get("edit")!;
  assert.equal(edit.providerId, "gateway");
  assert.equal(edit.host, "ai-gateway.vercel.sh");
  assert.equal(edit.upstream, "bfl");
  assert.equal(edit.providerTerms, defaultRoutes.edit.providerTerms);
  assert.equal(edit.retention, null);
  assert.equal(byOperation.get("vision")!.upstream, "google");
  assert.equal(byOperation.get("identity")!.upstream, "perplexity");
  // Tripo is a direct route.
  const model3d = byOperation.get("model3d")!;
  assert.equal(model3d.providerId, "tripo");
  assert.equal(model3d.host, "api.tripo3d.ai");
  assert.equal(model3d.upstream, null);
  for (const flow of flows) assert.ok(flow.host, `${flow.operation} names its host`);
});

test("an operation no configured provider serves is left out", () => {
  const flows = routeDataFlows({ ...settings, providers: { tripo: {} }, roles: {} }, { env: {} });
  assert.deepEqual(flows.map((f) => f.operation).sort(), ["clips3d", "model3d", "rig3d"]);
});
