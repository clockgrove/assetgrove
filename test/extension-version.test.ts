/**
 * Pack versioning (#414): core reads a pack's `assetgrove.api` and its peer range on
 * `@clockgrove/assetgrove` from package.json before importing it, checks the range against its own
 * version with semver (pre-releases included), and refuses a pack it cannot load, naming the api
 * versions it speaks. Nothing refused is imported.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { EXTENSION_API, EXTENSION_APIS } from "../src/extension/api.ts";
import { loadExtensions } from "../src/extensions/registry.ts";
import { compatibilityProblem, coreVersion } from "../src/extensions/version.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-pack-version-")));
after(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
/** A project with one pack installed; returns the project, the pack's name and its import marker. */
function project(manifest: Record<string, unknown>): {
  dir: string;
  name: string;
  marker: string;
} {
  const dir = join(root, `p${++count}`);
  const name = `pack-version-${count}`;
  const pkg = join(dir, "node_modules", name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", ...manifest }),
  );
  writeFileSync(
    join(pkg, "index.js"),
    `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./imported.marker", import.meta.url), "imported\\n");
export default ({ api }) => ({ api, name: "versioned" });
`,
  );
  return { dir, name, marker: join(pkg, "imported.marker") };
}

async function load(manifest: Record<string, unknown>) {
  const { dir, name, marker } = project(manifest);
  try {
    const registry = await loadExtensions({ extensions: [name], path: "settings.json" }, dir);
    return { registry, error: undefined, imported: existsSync(marker) };
  } catch (error) {
    return {
      registry: undefined,
      error: error as Error & { code?: string },
      imported: existsSync(marker),
    };
  }
}

const peer = (range: string) => ({ peerDependencies: { "@clockgrove/assetgrove": range } });

test("core speaks api 3 only", () => {
  assert.equal(EXTENSION_API, 3);
  assert.deepEqual(EXTENSION_APIS, [3]);
});

test("a valid v3 pack whose range admits core loads", async () => {
  const r = await load({
    assetgrove: { api: 3, entry: "./index.js" },
    ...peer(`^${coreVersion()}`),
  });
  assert.equal(r.error, undefined, r.error?.message);
  assert.ok(r.registry?.loaded.some((e) => e.name === "versioned"));
  assert.equal(r.imported, true);
});

test("a pack with api 1 is refused before import with a clear message naming api 3", async () => {
  const r = await load({ assetgrove: { api: 1, entry: "./index.js" }, ...peer(">=0.0.0") });
  assert.equal(r.error?.code, "extension_refused");
  assert.match(r.error!.message, /extensions\[0\] "pack-version-\d+" of settings\.json/);
  assert.match(r.error!.message, /api 1 is the pre-0\.3 contract.*rebuild the pack against api 3/);
  assert.match(r.error!.message, /speaks api 3/);
  assert.equal(r.imported, false);
});

test("a pack with api 2, the contract before the audio call kind, is refused naming api 3", async () => {
  const r = await load({ assetgrove: { api: 2, entry: "./index.js" }, ...peer(">=0.0.0") });
  assert.equal(r.error?.code, "extension_refused");
  assert.match(
    r.error!.message,
    /api 2 is the contract before the audio call kind.*rebuild the pack against api 3/,
  );
  assert.match(r.error!.message, /speaks api 3/);
  assert.equal(r.imported, false);
});

test("an unknown api is refused before import, naming the versions core speaks", async () => {
  for (const api of [4, "3", null]) {
    const r = await load({ assetgrove: { api, entry: "./index.js" }, ...peer(">=0.0.0") });
    assert.equal(r.error?.code, "extension_refused", String(api));
    assert.match(r.error!.message, /does not speak api .*; it speaks api 3/);
    assert.equal(r.imported, false);
  }
});

test("a peer range that excludes core, or none at all, is refused before import", async () => {
  const excluded = await load({ assetgrove: { api: 3, entry: "./index.js" }, ...peer("^99.0.0") });
  assert.equal(excluded.error?.code, "extension_refused");
  assert.match(
    excluded.error!.message,
    /peer range "\^99\.0\.0" .* excludes this Assetgrove .*speaks api 3/,
  );
  assert.equal(excluded.imported, false);
  const none = await load({ assetgrove: { api: 3, entry: "./index.js" } });
  assert.equal(none.error?.code, "extension_refused");
  assert.match(none.error!.message, /declares no peerDependencies\["@clockgrove\/assetgrove"\]/);
  assert.equal(none.imported, false);
  const invalid = await load({
    assetgrove: { api: 3, entry: "./index.js" },
    ...peer("not a range"),
  });
  assert.match(invalid.error!.message, /is not a semver range/);
});

test("the range is checked with pre-releases included", () => {
  // A pre-release core inside a range's bounds is admitted...
  assert.equal(compatibilityProblem(3, peer(">=0.2.0").peerDependencies, "0.3.0-rc.1"), undefined);
  assert.equal(compatibilityProblem(3, peer("^0.2.0").peerDependencies, "0.2.1-beta.0"), undefined);
  // ...and one past them is refused, naming its version.
  const problem = compatibilityProblem(3, peer("^0.2.0").peerDependencies, "0.3.0-rc.1");
  assert.match(problem ?? "", /excludes this Assetgrove 0\.3\.0-rc\.1/);
  assert.match(
    compatibilityProblem(3, peer("~0.2.0").peerDependencies, "0.2.0-alpha.1") ?? "",
    /excludes this Assetgrove 0\.2\.0-alpha\.1/,
  );
});
