import "./fixtures/env.ts";
import { approve, ledgerPath, useAttended, useHeadless } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cardAcceptCommand } from "../src/commands/card.ts";
import { confirmCommand } from "../src/commands/confirm.ts";
import { runCommand } from "../src/commands/runner.ts";
import type { ConfirmRequest } from "../src/confirm/prompt.ts";
import { parseCard } from "../src/library/card.ts";
import { canonicalJson, sha256Hex } from "../src/library/canonical.ts";
import { readProposal } from "../src/library/suggestions.ts";
import { loadSettings } from "../src/settings.ts";
import { SUMMARY } from "./fixtures/describe-script.ts";
import { fixtureLibrary } from "./fixtures/library.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./fixtures/describe-script.ts", import.meta.url));
approve(script);
const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
async function cli(...args: string[]): Promise<Doc> {
  const env = { ...process.env };
  delete env["AI_GATEWAY_API_KEY"];
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", ...args, "--json"],
      { cwd: root, env },
      (_error, stdout, stderr) => {
        try {
          resolve(JSON.parse(stdout) as Doc);
        } catch {
          reject(new Error(stdout + stderr));
        }
      },
    );
    child.stdin?.end();
  });
}
const calls = () =>
  existsSync(ledgerPath)
    ? readFileSync(ledgerPath, "utf8")
        .split("\n")
        .filter((line) => line.includes(":vision:") && line.includes('"reserve"')).length
    : 0;
function library(vocabulary = true) {
  const lib = fixtureLibrary();
  dirs.push(lib.dir);
  unlinkSync(join(lib.root, "escape.md"));
  unlinkSync(join(lib.root, "escape.review.json"));
  writeFileSync(
    join(lib.dir, ".gitattributes"),
    "*.png filter=lfs diff=lfs merge=lfs -text\n*.glb filter=lfs diff=lfs merge=lfs -text\n",
  );
  if (vocabulary)
    writeFileSync(
      join(lib.dir, ".assetgrove", "labels.json"),
      JSON.stringify({
        format: "assetgrove-labels/1",
        labels: [{ name: "lantern" }, { name: "brass" }],
      }),
    );
  const card = join(lib.root, "rock.md");
  const text = () => readFileSync(card, "utf8");
  const data = () => parseCard(text(), card).data;
  const describe = (...args: string[]) =>
    cli("card", "describe", card, "--runs", lib.runsDir, "--provider-script", script, ...args);
  const propose = async () => {
    useHeadless();
    const result = await describe("--propose");
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.proposals.length, 1);
    return result.proposals[0].proposal as string;
  };
  const accept = (
    proposal: string,
    field: string[],
    confirm?: (request: ConfirmRequest) => Promise<boolean>,
  ) =>
    runCommand(
      cardAcceptCommand,
      { proposal, field },
      {
        settings: loadSettings(),
        log: () => {},
        ...(confirm && { prompt: { method: "tty" as const, confirm } }),
      },
    );
  const rebuild = async () => {
    const result = await cli("library", "rebuild", "--target", lib.dir);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
  };
  return { lib, card, text, data, describe, propose, accept, rebuild };
}

test("scripted proposal records source, fields and model without changing card; confirmed fields apply independently", async () => {
  const fixture = library();
  const { card, text, data, propose, accept, rebuild } = fixture;
  const before = text();
  const proposal = await propose();
  const saved = readProposal(proposal);
  assert.equal(text(), before);
  assert.equal(saved.source.version, fixture.lib.versions["rock"]!.at(-1));
  assert.equal(saved.source.media, sha256Hex(readFileSync(join(fixture.lib.root, "rock.png"))));
  assert.equal(saved.model, "google/gemini-3-flash");
  assert.deepEqual(saved.fields, { description: SUMMARY.description, labels: SUMMARY.tags });
  const callCount = calls();
  useAttended();
  const declined = await accept(proposal, ["description"], async () => false);
  assert.equal(declined.error?.code, "confirmation_declined");
  assert.equal(text(), before);
  const result = await accept(proposal, ["description"], async (request) => {
    assert.deepEqual(request.details["fields"], ["description"]);
    assert.deepEqual(request.details["proposed"], { description: SUMMARY.description });
    return true;
  });
  assert.equal(result.exitCode, 0, result.error?.message);
  assert.equal(data()["description"], SUMMARY.description);
  assert.deepEqual(data()["tags"], []);
  // A title edit and a full rebuild retain the accepted field's process attribution.
  assert.equal((await cli("card", "edit", card, "--title", "My title")).exitCode, 0);
  await rebuild();
  const entries = data()["verified"] as Doc[];
  assert.equal(
    entries.filter((entry) => entry.by.startsWith("process:assetgrove-suggestion:")).length,
    1,
  );
  assert.equal(entries.at(-1)!.field, "description");
  assert.equal(entries.at(-1)!.sourceVersion, saved.source.version);
  assert.equal((await accept(proposal, ["labels"], async () => true)).exitCode, 0);
  assert.deepEqual(data()["tags"], SUMMARY.tags);
  assert.equal(data()["description"], SUMMARY.description);
  await rebuild();
  assert.deepEqual(
    (data()["verified"] as Doc[])
      .filter((entry) => entry.field)
      .map((entry) => entry.field)
      .sort(),
    ["description", "tags"],
  );
  assert.equal(calls(), callCount, "acceptance never calls the provider");
});

test("selected-field conflicts and source mutations refuse, while an unselected human edit is retained", async () => {
  const { card, lib, text, data, propose, accept } = library();
  const proposal = await propose();
  useAttended();
  assert.equal(
    (await cli("card", "edit", card, "--description", "A human description.")).exitCode,
    0,
  );
  const before = text();
  const conflict = await accept(proposal, ["description"], async () => true);
  assert.equal(conflict.error?.code, "plan_changed");
  assert.equal(text(), before);
  assert.equal((await accept(proposal, ["labels"], async () => true)).exitCode, 0);
  assert.equal(data()["description"], "A human description.");
  assert.deepEqual(data()["tags"], SUMMARY.tags);
  const next = await propose();
  const media = join(lib.root, "rock.png");
  writeFileSync(media, Buffer.concat([readFileSync(media), Buffer.from("changed")]));
  const sourceChanged = await accept(next, ["description"], async () => true);
  assert.equal(sourceChanged.error?.code, "plan_changed");
});

test("edits and proposal replacement during confirmation are rechecked under the library lock", async () => {
  const { card, text, propose, accept } = library();
  const proposal = await propose();
  useAttended();
  let changed = "";
  const conflict = await accept(proposal, ["description"], async () => {
    assert.equal(
      (await cli("card", "edit", card, "--description", "Written during confirmation.")).exitCode,
      0,
    );
    changed = text();
    return true;
  });
  assert.equal(conflict.error?.code, "plan_changed");
  assert.equal(text(), changed);
  const fresh = await propose();
  const tampered = await accept(fresh, ["description"], async () => {
    const value = readProposal(fresh);
    value.fields.description = "Different proposed description.";
    writeFileSync(fresh, JSON.stringify(value));
    return true;
  });
  assert.equal(tampered.error?.code, "plan_changed");
  assert.equal(text(), changed);
});

test("acceptance revalidates current vocabulary; missing vocabulary offers no labels", async () => {
  const { lib, text, propose, accept } = library();
  const proposal = await propose();
  const before = text();
  useAttended();
  writeFileSync(
    join(lib.dir, ".assetgrove", "labels.json"),
    JSON.stringify({ format: "assetgrove-labels/1", labels: [{ name: "wood" }] }),
  );
  const invalid = await accept(proposal, ["labels"], async () => true);
  assert.equal(invalid.error?.code, "invalid_input");
  assert.match(invalid.error!.message, /unknown.*proposed label/);
  assert.equal(text(), before);
  assert.equal((await accept(proposal, ["description"], async () => true)).exitCode, 0);
  const missing = library(false);
  const noLabels = await missing.propose();
  assert.deepEqual(Object.keys(readProposal(noLabels).fields), ["description"]);
  const absent = await missing.accept(noLabels, ["labels"], async () => true);
  assert.equal(absent.error?.code, "invalid_input");
});

test("pending card acceptance is rebuilt by terminal confirm and exact selected fields are applied on retry", async () => {
  const { text, data, propose, accept } = library();
  const proposal = await propose();
  const before = text();
  // Headless settings cannot automatically accept a suggestion.
  const pending = await accept(proposal, ["description"]);
  assert.equal(pending.error?.code, "confirmation_required");
  assert.equal(text(), before);
  const id = pending.error!.confirmation!.id;
  useAttended();
  const confirmed = await runCommand(
    confirmCommand,
    { id },
    {
      settings: loadSettings(),
      log: () => {},
      prompt: {
        method: "tty",
        confirm: async (request) => {
          assert.deepEqual(request.details["proposed"], { description: SUMMARY.description });
          return true;
        },
      },
    },
  );
  assert.equal(confirmed.exitCode, 0, confirmed.error?.message);
  assert.equal(text(), before);
  assert.equal((await accept(proposal, ["description"])).exitCode, 0);
  assert.equal(data()["description"], SUMMARY.description);
  assert.deepEqual(data()["tags"], []);
});

test("legacy #432 description and provenance survive card edit and library rebuild", async () => {
  const { card, data, describe, propose, accept, rebuild } = library();
  assert.equal((await describe()).exitCode, 0);
  const entry = (data()["verified"] as Doc[]).find((value) =>
    value.by.startsWith("process:assetgrove-summary:"),
  );
  assert.ok(entry);
  await rebuild();
  assert.equal(data()["description"], SUMMARY.description);
  assert.deepEqual(data()["tags"], SUMMARY.tags);
  assert.deepEqual(
    (data()["verified"] as Doc[]).find((value) =>
      value.by.startsWith("process:assetgrove-summary:"),
    ),
    entry,
  );
  assert.equal((await cli("card", "edit", card, "--body", "Human notes.")).exitCode, 0);
  assert.deepEqual(
    (data()["verified"] as Doc[]).find((value) =>
      value.by.startsWith("process:assetgrove-summary:"),
    ),
    entry,
  );
  const proposal = await propose();
  useAttended();
  assert.equal((await accept(proposal, ["labels"], async () => true)).exitCode, 0);
  await rebuild();
  const retained = (data()["verified"] as Doc[]).find((value) => value.field === "description");
  assert.deepEqual(retained, {
    by: entry.by.replace("assetgrove-summary:", "assetgrove-suggestion:"),
    at: entry.at,
    field: "description",
    value: sha256Hex(canonicalJson(SUMMARY.description)),
    sourceVersion: readProposal(proposal).source.version,
  });
  assert.equal(
    (await cli("card", "edit", card, "--description", "A human replacement.")).exitCode,
    0,
  );
  await rebuild();
  assert.equal(data()["description"], "A human replacement.");
  assert.equal(
    (data()["verified"] as Doc[]).some((value) => value.field === "description"),
    false,
  );
  assert.equal(
    (data()["verified"] as Doc[]).some((value) =>
      value.by.startsWith("process:assetgrove-summary:"),
    ),
    false,
  );
});
