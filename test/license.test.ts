import "./fixtures/env.ts";
import { approve, approveProfile } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { encodePng } from "../src/image/raster.ts";
import { ProviderSet } from "../src/providers/set.ts";
import { imageGenerators } from "../src/generators/image.ts";
import { pick } from "../src/handoff.ts";
import { combineGrants, grantProblems, LicenseError, licenseDecision } from "../src/license.ts";
import { stage } from "../src/loop.ts";
import { defaultRoutes } from "../src/routes.ts";
import type { Routes } from "../src/routes.ts";
import type { AssetSpec, OutputGrant, Provenance, TargetProfile } from "../src/types.ts";
import { writeSettings } from "./fixtures/env.ts";
import {
  drawSubject,
  scriptedProvider,
  shelterSpec,
  syntheticWorld as plainWorld,
  writeStyleBible,
} from "./fixtures/synthetic.ts";
import type { World } from "./fixtures/synthetic.ts";
import { gitTarget } from "./fixtures/git.ts";

async function syntheticWorld(): Promise<World> {
  const world = await plainWorld();
  gitTarget(world.targetDir);
  approveProfile(world.profile, { targetDir: world.targetDir });
  return world;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const passingScript = fileURLToPath(new URL("./fixtures/script.ts", import.meta.url));
approve(passingScript);

/** Meshy's free plan: CC BY 4.0, commercial use with credit. */
const CC_BY: OutputGrant = {
  license: "CC-BY-4.0",
  plan: "free",
  commercial: true,
  relabel: false,
  attribution: "Model by Meshy (meshy.ai)",
};
/** Tripo's free plan: Tripo keeps all rights, no commercial use. */
const NON_COMMERCIAL: OutputGrant = {
  license: "LicenseRef-tripo-free",
  plan: "free",
  commercial: false,
  relabel: false,
};
const OWNED: OutputGrant = {
  license: "LicenseRef-meshy-pro",
  plan: "pro",
  commercial: true,
  relabel: true,
};

/** The default routes with every image route made under `grant`; vision keeps its default. */
function routesWith(grant: OutputGrant): Routes {
  return {
    ...defaultRoutes,
    still: { ...defaultRoutes.still, outputGrant: grant },
    edit: { ...defaultRoutes.edit, outputGrant: grant },
    sheet: { ...defaultRoutes.sheet, outputGrant: grant },
  };
}

async function staged(world: World, routes: Routes, profile: TargetProfile = world.profile) {
  return stage({
    spec: shelterSpec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile,
    routes,
    provider: scriptedProvider(),
    providerName: "scripted",
    generators: imageGenerators,
    runsDir: world.runsDir,
  });
}

test("an output made on routes that give ownership is declared under the target's MIT licence", async () => {
  const world = await syntheticWorld();
  const { run, runDir } = await staged(world, defaultRoutes);
  const candidate = run.candidates[0]!;
  const p = candidate.provenance;
  assert.equal(p.license, "MIT");
  assert.deepEqual(p.outputGrant, {
    license: "LicenseRef-bfl-api AND LicenseRef-google-api AND LicenseRef-perplexity-api",
    plan: "api",
    commercial: true,
    relabel: true,
  });
  for (const call of p.calls) {
    assert.equal(call.outputGrant?.plan, "api");
    assert.equal(call.outputGrant?.relabel, true);
  }
  await pick({ runDir, candidateId: candidate.id, targetDir: world.targetDir });
  const manifest = JSON.parse(
    await readFile(join(world.targetDir, "assets/manifests/fern/shelter.json"), "utf8"),
  );
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.provenance.generated.license, "MIT");
});

test("a CC BY output is refused by a target that does not accept CC BY, and nothing is written", async () => {
  const world = await syntheticWorld();
  const { run, runDir } = await staged(world, routesWith(CC_BY));
  const p = run.candidates[0]!.provenance;
  // Staging is unaffected: it records the grant and the licence the output really has.
  assert.equal(p.license, "CC-BY-4.0");
  assert.deepEqual(p.outputGrant, {
    license: "CC-BY-4.0",
    plan: "free + api",
    commercial: true,
    relabel: false,
    attribution: CC_BY.attribution,
  });
  await assert.rejects(
    pick({ runDir, candidateId: "c1", targetDir: world.targetDir }),
    (error: unknown) =>
      error instanceof LicenseError &&
      /CC-BY-4\.0/.test(error.message) &&
      /acceptedLicenses/.test(error.message) &&
      /Model by Meshy/.test(error.message),
  );
  assert.deepEqual(await readdir(world.targetDir), [".git", ".gitattributes"]);
});

test("a target that accepts CC BY on purpose takes a CC BY output declared as CC BY, never as MIT", async () => {
  const world = await syntheticWorld();
  // The synthetic validator models a target that permits only MIT, so this target has none.
  const { validator: _validator, ...rest } = world.profile;
  void _validator;
  const profile = { ...rest, acceptedLicenses: ["CC-BY-4.0"] };
  const { run, runDir } = await staged(world, routesWith(CC_BY), profile);
  assert.equal(run.candidates[0]!.provenance.license, "CC-BY-4.0");
  await pick({ runDir, candidateId: "c1", targetDir: world.targetDir });
  const manifest = JSON.parse(
    await readFile(join(world.targetDir, "assets/manifests/fern/shelter.json"), "utf8"),
  );
  // The template reads {{profile.license}}: at hand-off it is the declared licence.
  assert.equal(manifest.license, "CC-BY-4.0");
  const provenance = manifest.provenance.generated;
  assert.equal(provenance.license, "CC-BY-4.0");
  assert.equal(provenance.outputGrant.attribution, CC_BY.attribution);
});

test("a non-commercial output is refused even when the target lists its licence", async () => {
  const world = await syntheticWorld();
  const profile = {
    ...world.profile,
    acceptedLicenses: ["CC-BY-4.0", NON_COMMERCIAL.license],
  };
  const { run, runDir } = await staged(world, routesWith(NON_COMMERCIAL), profile);
  const p = run.candidates[0]!.provenance;
  assert.equal(p.license, NON_COMMERCIAL.license);
  assert.equal(p.outputGrant?.commercial, false);
  await assert.rejects(
    pick({ runDir, candidateId: "c1", targetDir: world.targetDir }),
    (error: unknown) =>
      error instanceof LicenseError && /without commercial use/.test(error.message),
  );
  assert.deepEqual(await readdir(world.targetDir), [".git", ".gitattributes"]);
});

test("hand-off re-derives the grant from the calls, so an edited licence cannot relabel", async () => {
  const world = await syntheticWorld();
  const { runDir } = await staged(world, routesWith(CC_BY));
  const runFile = join(runDir, "run.json");
  const record = JSON.parse(await readFile(runFile, "utf8"));
  for (const c of record.candidates) {
    c.provenance.license = "MIT";
    delete c.provenance.outputGrant;
  }
  await writeFile(runFile, JSON.stringify(record));
  await assert.rejects(
    pick({ runDir, candidateId: "c1", targetDir: world.targetDir }),
    LicenseError,
  );
});

test("the most restrictive grant wins when calls combine", () => {
  assert.equal(combineGrants([]), undefined);
  assert.deepEqual(combineGrants([OWNED, OWNED]), OWNED);
  assert.deepEqual(combineGrants([OWNED, CC_BY]), {
    license: "CC-BY-4.0",
    plan: "pro + free",
    commercial: true,
    relabel: false,
    attribution: CC_BY.attribution,
  });
  const all = combineGrants([CC_BY, NON_COMMERCIAL, OWNED])!;
  assert.equal(all.license, NON_COMMERCIAL.license);
  assert.equal(all.commercial, false);
  assert.equal(all.relabel, false);
  assert.equal(all.attribution, CC_BY.attribution);
});

test("a non-exclusive grant makes the combined grant non-exclusive; terms that say nothing leave it absent", () => {
  const elevenlabs: OutputGrant = { ...OWNED, plan: "pro", exclusive: false };
  assert.equal(combineGrants([OWNED, elevenlabs])!.exclusive, false);
  assert.equal(combineGrants([elevenlabs, { ...OWNED, exclusive: true }])!.exclusive, false);
  assert.equal(combineGrants([{ ...OWNED, exclusive: true }])!.exclusive, true);
  assert.equal("exclusive" in combineGrants([OWNED, { ...OWNED, exclusive: true }])!, false);
  assert.equal("exclusive" in combineGrants([OWNED, CC_BY])!, false);
  assert.deepEqual(grantProblems({ ...OWNED, exclusive: "no" }), [
    "exclusive is not true or false",
  ]);
});

test("licences of several attribution-only grants are a set, whatever the call order", () => {
  const a: OutputGrant = { ...CC_BY, license: "CC-BY-4.0" };
  const b: OutputGrant = { ...CC_BY, license: "LicenseRef-x" };
  const forward = combineGrants([a, b])!;
  assert.equal(forward.license, "CC-BY-4.0 AND LicenseRef-x");
  assert.equal(combineGrants([b, a])!.license, forward.license);
  const profile = (acceptedLicenses: string[]) =>
    ({ name: "game", license: "MIT", acceptedLicenses }) as unknown as TargetProfile;
  for (const grant of [forward, combineGrants([b, a])!]) {
    assert.deepEqual(licenseDecision(profile(["CC-BY-4.0", "LicenseRef-x"]), grant), {
      license: "CC-BY-4.0 AND LicenseRef-x",
    });
    assert.deepEqual(licenseDecision(profile([forward.license]), grant), {
      license: forward.license,
    });
    const refused = licenseDecision(profile(["CC-BY-4.0"]), grant);
    assert.ok("refused" in refused && refused.refused.includes('List "LicenseRef-x" in'));
  }
});

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["src/cli.ts", ...args], { cwd: root }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code as unknown as number) : 0, stdout, stderr }),
    );
  });
}

/** The spec, bible and profile of a world, written to files for the CLI. */
async function worldFiles(world: World, spec: AssetSpec = shelterSpec): Promise<string[]> {
  const specPath = join(world.dir, "spec.json");
  const bible = join(world.bibleDir, "BIBLE.md");
  const profile = join(world.dir, "profile.json");
  await writeFile(specPath, JSON.stringify(spec));
  await writeStyleBible(bible, world.bible);
  await writeFile(profile, JSON.stringify(world.profile));
  return ["--spec", specPath, "--bible", bible, "--profile", profile, "--runs", world.runsDir];
}

async function stageAndPick(world: World, files: string[], extra: string[] = []) {
  const s = await cli([
    "stage",
    ...files,
    ...["--candidates", "1", "--provider-script", passingScript, "--json", ...extra],
  ]);
  assert.equal(s.code, 0, s.stderr);
  const runDir = JSON.parse(s.stdout)["runDir"] as string;
  const r = await cli([
    ...["pick", "--run", runDir, "--candidate", "c1", "--target", world.targetDir, "--json"],
  ]);
  return { staged: JSON.parse(s.stdout) as { candidates: Array<{ provenance: Provenance }> }, r };
}

test("pick of a refused output exits 7 with license_refused", async () => {
  const world = await syntheticWorld();
  writeSettings({
    roles: { edit: { provider: "scripted", model: defaultRoutes.edit.model, outputGrant: CC_BY } },
  });
  const { r } = await stageAndPick(world, await worldFiles(world));
  assert.equal(r.code, 7, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.ok, false);
  assert.equal(d.error.code, "license_refused");
  assert.match(r.stderr, /refused hand-off/);
  assert.deepEqual(await readdir(world.targetDir), [".git", ".gitattributes"]);
});

/** A loopback OpenAI-compatible image server answering every image request with `png`. */
async function imageServer(png: Uint8Array): Promise<{ baseURL: string; close: () => void }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          created: 0,
          data: [{ b64_json: Buffer.from(png).toString("base64") }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}

const denSpec: AssetSpec = {
  kind: "still",
  assetId: "den",
  animationFamily: "idle",
  fields: { semantic: { role: "prop", entity: "grove.den" }, accessibilityLabel: "The den" },
};

test("a grantless openai-compatible route is refused at pick; declaring roles.image.outputGrant lets it hand off", async () => {
  const world = await syntheticWorld();
  const server = await imageServer(encodePng(drawSubject(96, 0)));
  try {
    const files = await worldFiles(world, denSpec);
    const providers = {
      scripted: { limit: { kind: "prepaid", usd: 100 } },
      local: { adapter: "openai-compatible", baseURL: server.baseURL, free: true },
    };
    writeSettings({ providers, roles: { image: { provider: "local", model: "local-image" } } });
    const refused = await stageAndPick(world, files);
    const calls = refused.staged.candidates[0]!.provenance.calls;
    assert.equal(calls[0]!.route, "local:still:local-image");
    assert.equal(calls[0]!.outputGrant, undefined);
    assert.equal(refused.r.code, 7, refused.r.stderr);
    const d = JSON.parse(refused.r.stdout) as { error: { code: string; message: string } };
    assert.equal(d.error.code, "license_refused");
    assert.match(d.error.message, /local:still:local-image/);
    assert.match(d.error.message, /roles\.image\.outputGrant/);
    assert.deepEqual(await readdir(world.targetDir), [".git", ".gitattributes"]);

    writeSettings({
      providers,
      roles: {
        image: {
          provider: "local",
          model: "local-image",
          outputGrant: OWNED,
          providerTerms: "Local model licence (synthetic)",
        },
      },
    });
    // The settings changed but the request did not: a new round makes a new run.
    const handed = await stageAndPick(world, files, ["--round", "2"]);
    assert.equal(handed.r.code, 0, handed.r.stderr);
    const manifest = JSON.parse(
      await readFile(join(world.targetDir, "assets/manifests/den/idle.json"), "utf8"),
    );
    assert.equal(manifest.license, "MIT");
  } finally {
    server.close();
  }
});

test("a gateway route whose model is overridden without its own grant is refused at pick", async () => {
  const world = await syntheticWorld();
  const settings = {
    providers: { gateway: { adapter: "vercel-ai-gateway" } },
    roles: {},
    routes: { edit: { provider: "gateway", model: "bfl/flux-kontext-max", estimatedCostUsd: 0.2 } },
    path: "settings.json",
  };
  const routes = ProviderSet.fromSettings(settings, { env: {} }).routes;
  assert.equal(routes.edit.outputGrant, undefined);
  // The gateway's calls are answered by the scripted stand-in, recorded under the gateway's id.
  const { runDir } = await stage({
    spec: shelterSpec,
    specDir: world.dir,
    bible: world.bible,
    bibleDir: world.bibleDir,
    profile: world.profile,
    routes,
    provider: scriptedProvider(),
    providerName: "gateway",
    generators: imageGenerators,
    runsDir: world.runsDir,
  });
  await assert.rejects(
    pick({ runDir, candidateId: "c1", targetDir: world.targetDir }),
    (error: unknown) =>
      error instanceof LicenseError &&
      /gateway:edit:bfl\/flux-kontext-max/.test(error.message) &&
      /routes\.edit\.outputGrant/.test(error.message),
  );
  assert.deepEqual(await readdir(world.targetDir), [".git", ".gitattributes"]);
});
