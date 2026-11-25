import "./fixtures/env.ts";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { REFUSED_VARIABLES } from "../src/env.ts";
import { planDelivery } from "../src/delivery.ts";
import { encodePng } from "../src/image/raster.ts";
import { lfsObjectPath } from "../src/library/lfs.ts";
import {
  appendAnnotation,
  appendVersion,
  emptyReview,
  placeholderBody,
  writeReview,
} from "../src/library/review.ts";
import type { AnnotationInput, ReviewRecord } from "../src/library/review.ts";
import { sha256Hex } from "../src/library/canonical.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType } from "../src/metadata.ts";
import type { ReleasePolicy } from "../src/release-policy.ts";
import { validateProfile } from "../src/profile.ts";
import { gitTarget } from "./fixtures/git.ts";
import { drawSubject, syntheticProfile } from "./fixtures/synthetic.ts";

const image = (n: number) =>
  embedDigitalSourceType(
    encodePng(drawSubject(16, n)),
    "image/png",
    DIGITAL_SOURCE_TYPES.generated,
  );

const temporary: string[] = [];
after(async () => {
  await Promise.all(temporary.map((d) => rm(d, { recursive: true, force: true })));
});

interface Fixture {
  dir: string;
  target: string;
  assets: string;
  base: string;
}

async function setup(): Promise<Fixture> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-release-test-")));
  temporary.push(dir);
  const target = gitTarget(join(dir, "target"));
  const assets = join(target, "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(
    join(target, "index.md"),
    "---\nokf_version: 0.2\ntype: Asset Library\ngame: test-grove\n---\n\n# test-grove\n",
  );
  const base = join(dir, "project");
  await mkdir(join(base, "recipes"), { recursive: true });
  await writeFile(
    join(base, "recipes", "icon.json"),
    JSON.stringify({
      format: "assetgrove-recipe/1",
      steps: [{ op: "scale", params: { factor: 2 } }],
    }),
  );
  return { dir, target, assets, base };
}

type Mark = "placeholder" | "approve" | "reject";

/**
 * A two-version asset `lantern` licensed `LicenseRef-Vendor-EULA`, both versions' bytes present
 * (the current one as the media file, the older one in the local LFS store), with `marks[i]` the
 * annotations a person wrote on version i + 1.
 */
async function lantern(f: Fixture, marks: Mark[][] = [[], []], license = "LicenseRef-Vendor-EULA") {
  const versions = [image(1), image(2)];
  let record: ReviewRecord = emptyReview("asset://test-grove/lantern/review");
  for (const [i, bytes] of versions.entries()) {
    record = appendVersion(record, {
      sha256: sha256Hex(bytes),
      at: `2026-01-0${i + 1}T00:00:00Z`,
      run: "r-lantern",
      candidate: "c1",
      confirmation: { method: "tty" },
    });
  }
  let minute = 10;
  for (const [i, kinds] of marks.entries()) {
    const target = { source: "lantern.png", "ag:version": sha256Hex(versions[i]!) };
    for (const kind of kinds) {
      const created = `2026-01-05T00:${minute++}:00Z`;
      const annotation: AnnotationInput =
        kind === "placeholder"
          ? {
              type: "Annotation",
              motivation: "tagging",
              created,
              body: [placeholderBody()],
              target,
            }
          : {
              type: "Annotation",
              motivation: "assessing",
              created,
              target,
              "ag:action": kind,
              ...(kind === "reject" && {
                body: [{ type: "TextualBody", purpose: "assessing", value: "too dark" }],
              }),
            };
      record = appendAnnotation(record, annotation);
    }
  }
  await writeFile(join(f.assets, "lantern.review.json"), writeReview(record));
  await writeFile(join(f.assets, "lantern.png"), versions[1]!);
  await writeFile(
    join(f.assets, "lantern.md"),
    `---\ntype: Game Asset\nformat: assetgrove-card/1\ntitle: lantern\nresource: lantern.png\nversion: 2\nlicense: ${license}\nlock: { sha256: ${sha256Hex(versions[1]!)} }\n---\n`,
  );
  const path = lfsObjectPath(join(f.target, ".git"), sha256Hex(versions[0]!));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, versions[0]!);
  return versions.map((v) => sha256Hex(v));
}

async function select(f: Fixture, version: number) {
  const path = join(f.base, `selection-${version}.json`);
  await writeFile(
    path,
    JSON.stringify({
      format: "assetgrove-delivery/1",
      recipes: "recipes",
      items: [{ asset: "../target/assets/lantern.md", version, recipe: "icon", to: "icons" }],
    }),
  );
  return path;
}

async function files(root: string, rel = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await files(root, path)));
    else found.push(path);
  }
  return found.sort();
}

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function deliverCli(args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const name of REFUSED_VARIABLES) {
    delete env[name];
    delete env[name.toLowerCase()];
  }
  delete env.AI_GATEWAY_API_KEY;
  return exec(process.execPath, [CLI, "deliver", ...args], { env }).then(
    (r) => ({ code: 0, stdout: r.stdout }),
    (e: { code: number; stdout: string }) => ({ code: e.code, stdout: e.stdout }),
  );
}

async function profile(f: Fixture, release: ReleasePolicy) {
  const path = join(f.base, "profile.json");
  await writeFile(path, JSON.stringify(syntheticProfile({ release })));
  return path;
}

const NOW = new Date("2026-11-25T12:00:00Z");

test("a selected placeholder fails a release delivery naming its asset and version; an eligible version clears it", async () => {
  const f = await setup();
  const [v1, v2] = await lantern(f, [["placeholder"], []]);
  const out = join(f.dir, "out");

  const refused = await deliverCli(["--selection", await select(f, 1), "--out", out]);
  assert.equal(refused.code, 2);
  assert.match(refused.stdout, /delivery refused: 1 problem\(s\), nothing written/);
  assert.match(
    refused.stdout,
    new RegExp(`item 1: placeholder_selected: lantern version 1 \\(${v1}\\) is a placeholder`),
  );
  assert.equal(existsSync(out), false);

  const json = await deliverCli(["--selection", await select(f, 1), "--out", out, "--json"]);
  const doc = JSON.parse(json.stdout);
  assert.equal(doc.error.code, "invalid_input");
  assert.deepEqual(
    doc.problems.map((p: { code: string }) => p.code),
    ["placeholder_selected"],
  );
  assert.equal(doc.release, false);
  const failed = doc.policy.filter((p: { status: string }) => p.status === "failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].asset, "lantern");
  assert.equal(failed[0].version, 1);
  assert.equal(failed[0].sha256, v1);
  assert.equal(failed[0].evidence.marks.length, 1);
  assert.match(failed[0].evidence.marks[0].annotation, /^#[0-9a-f]{16}$/);

  const cleared = await deliverCli(["--selection", await select(f, 2), "--out", out, "--json"]);
  assert.equal(cleared.code, 0);
  const done = JSON.parse(cleared.stdout);
  assert.deepEqual(done.problems, []);
  assert.equal(done.release, true);
  assert.equal(done.written, true);
  assert.deepEqual(
    done.policy.map((p: { check: string; status: string; sha256: string }) => [
      p.check,
      p.status,
      p.sha256,
    ]),
    [["placeholder", "passed", v2]],
  );
  assert.deepEqual(await files(out), ["delivery.json", "icons/lantern.png"]);
  const manifest = JSON.parse(await readFile(join(out, "delivery.json"), "utf8"));
  assert.equal("draft" in manifest, false, "a release manifest is unchanged");
});

test("when the project policy enables them, a release refuses an unapproved version and an expired licence with the evidence", async () => {
  const f = await setup();
  const [v1] = await lantern(f, [["reject"], []]);
  const out = join(f.dir, "out");
  const selection = await select(f, 1);
  const policy: ReleasePolicy = {
    requireApproval: true,
    licenseWindows: [
      { license: "LicenseRef-Vendor-EULA", from: "2024-01-01", until: "2026-06-30" },
    ],
  };

  const without = await planDelivery({ selection, out, preview: true, now: NOW });
  assert.deepEqual(without.problems, []);
  assert.deepEqual(
    without.policy.map((p) => p.check),
    ["placeholder"],
    "without the policy only the placeholder check applies",
  );

  const refused = await planDelivery({ selection, out, policy, now: NOW });
  assert.equal(refused.written, false);
  assert.equal(refused.release, false);
  assert.deepEqual(await files(out), []);
  assert.deepEqual(
    refused.problems.map((p) => p.code),
    ["version_unapproved", "license_window"],
  );
  const [approval, window] = refused.policy.filter((p) => p.status === "failed");
  assert.equal(approval!.check, "approval");
  assert.deepEqual(approval!.evidence, {
    check: "approval",
    state: "rejected",
    assessment: {
      annotation: (approval!.evidence as { assessment: { annotation: string } }).assessment
        .annotation,
      action: "reject",
      created: "2026-01-05T00:10:00Z",
    },
  });
  assert.match(
    refused.problems[0]!.message,
    new RegExp(`lantern version 1 \\(${v1}\\) is not approved \\(state rejected\\): reject by #`),
  );
  assert.deepEqual(window!.evidence, {
    check: "license-window",
    license: "LicenseRef-Vendor-EULA",
    date: "2026-11-25",
    windows: policy.licenseWindows,
    outside: policy.licenseWindows,
  });
  assert.match(
    refused.problems[1]!.message,
    /licensed LicenseRef-Vendor-EULA, outside LicenseRef-Vendor-EULA 2024-01-01 to 2026-06-30 \(expired\) on 2026-11-25/,
  );

  // The same check through the CLI, the policy read from the target profile.
  const cli = await deliverCli([
    "--selection",
    selection,
    "--out",
    out,
    "--profile",
    await profile(f, { requireApproval: true }),
    "--json",
  ]);
  assert.equal(cli.code, 2);
  const doc = JSON.parse(cli.stdout);
  assert.deepEqual(
    doc.error.problems.map((p: { code: string }) => p.code),
    ["version_unapproved"],
  );
  assert.match(doc.error.problems[0].problem, /not approved \(state rejected\): reject by #/);

  // An approved version inside its window, or under a licence no window names, passes.
  await lantern(f, [["reject", "approve"], []]);
  const inside: ReleasePolicy = {
    requireApproval: true,
    licenseWindows: [{ license: "LicenseRef-Vendor-EULA", until: "2026-11-25" }],
  };
  const passed = await planDelivery({ selection, out, policy: inside, now: NOW });
  assert.deepEqual(passed.problems, []);
  assert.equal(passed.release, true);
  assert.deepEqual(
    passed.policy.map((p) => `${p.check}:${p.status}`),
    ["placeholder:passed", "approval:passed", "license-window:passed"],
  );
  await rm(out, { recursive: true });
  await lantern(f, [["approve"], []], "MIT");
  const other = await planDelivery({ selection, out, policy, now: NOW });
  assert.deepEqual(other.problems, []);
  assert.match(other.policy[2]!.message, /licensed MIT, which no licence window names/);
});

test("preview and draft report the same release findings without refusing or releasing", async () => {
  const f = await setup();
  await lantern(f, [["placeholder"], []]);
  const selection = await select(f, 1);
  const policy: ReleasePolicy = { requireApproval: true };
  const out = join(f.dir, "out");

  const release = await planDelivery({ selection, out, policy, now: NOW });
  assert.deepEqual(
    release.problems.map((p) => p.code),
    ["placeholder_selected", "version_unapproved"],
  );
  const preview = await planDelivery({ selection, out, policy, preview: true, now: NOW });
  assert.deepEqual(preview.problems, []);
  assert.deepEqual(preview.policy, release.policy);
  assert.equal(preview.release, false);
  assert.equal(preview.written, false);
  assert.equal(existsSync(out), false);

  const draft = await planDelivery({ selection, out, policy, draft: true, now: NOW });
  assert.deepEqual(draft.problems, []);
  assert.deepEqual(draft.policy, release.policy);
  assert.equal(draft.written, true);
  assert.equal(draft.release, false);
  const manifest = JSON.parse(await readFile(join(out, "delivery.json"), "utf8"));
  assert.equal(manifest.draft, true);

  // A clean preview is still not a release approval.
  const clean = await select(f, 2);
  const human = await deliverCli(["--selection", clean, "--out", join(f.dir, "o2"), "--preview"]);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /preview, not a release: every release check passed/);
  const flagged = await deliverCli([
    "--selection",
    selection,
    "--out",
    join(f.dir, "o3"),
    "--draft",
    "--json",
  ]);
  assert.equal(flagged.code, 0);
  const doc = JSON.parse(flagged.stdout);
  assert.equal(doc.draft, true);
  assert.equal(doc.release, false);
  assert.deepEqual(
    doc.policy.map((p: { check: string; status: string }) => `${p.check}:${p.status}`),
    ["placeholder:failed"],
  );
});

test("the profile's release policy is checked when the profile is read", () => {
  const ok = validateProfile(
    {
      ...syntheticProfile(),
      release: { requireApproval: true, licenseWindows: [{ license: "X", until: "2027-01-31" }] },
    },
    "p.json",
  );
  assert.equal(ok.release?.requireApproval, true);
  for (const release of [
    { licenseWindows: [{ license: "X", from: "2027-02-01", until: "2027-01-31" }] },
    { licenseWindows: [{ license: "X", until: "2027-02-30" }] },
    { licenseWindows: [{ license: "X", until: "31/01/2027" }] },
    { requireApproval: "yes" },
    { gate: true },
  ]) {
    assert.throws(() => validateProfile({ ...syntheticProfile(), release }, "p.json"));
  }
});
