import "./fixtures/env.ts";
import { useAttended } from "./fixtures/env.ts";
import { cardAcceptCommand } from "../src/commands/card.ts";
import { runCommand } from "../src/commands/runner.ts";
import { loadSettings } from "../src/settings.ts";
import { metadataProposal } from "../src/library/suggestions.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureLibrary } from "./fixtures/library.ts";
import { PROFILE_PATH } from "../src/init.ts";
import { selectDescribed, writeDescribed } from "../src/library/describe.ts";

const roots: string[] = [];
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
function library(severity: "error" | "warning") {
  const lib = fixtureLibrary();
  roots.push(lib.dir);
  const path = join(lib.dir, PROFILE_PATH);
  const profile = JSON.parse(readFileSync(path, "utf8"));
  profile.format = "assetgrove-target-profile/2";
  profile.rules = [{ id: "project-label", kind: "labels", required: ["required-label"], severity }];
  writeFileSync(path, JSON.stringify(profile));
  return lib;
}
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(root, path)] = readFileSync(path).toString("base64");
  }
  return files;
}
function edit(address: string): { code: number; output: Record<string, unknown> } {
  const args = ["src/cli.ts", "card", "edit", address, "--title", "Updated title", "--json"];
  const options = {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8" as const,
    env: { ...process.env, AI_GATEWAY_API_KEY: "" },
  };
  try {
    return { code: 0, output: JSON.parse(execFileSync(process.execPath, args, options)) };
  } catch (error) {
    const result = error as { status: number; stdout: string };
    return { code: result.status, output: JSON.parse(result.stdout) };
  }
}

test("card edit enforces profile label errors before writes and reports nonblocking warnings", () => {
  const failed = library("error");
  const before = snapshot(failed.root);
  const result = edit(join(failed.root, "rock.md"));
  assert.equal(result.code, 2);
  assert.match(JSON.stringify(result.output), /project rule project-label: rock \(card\)/);
  assert.deepEqual(snapshot(failed.root), before);
  const warned = library("warning");
  const warning = edit(join(warned.root, "rock.md"));
  assert.equal(warning.code, 0);
  assert.deepEqual(warning.output["ruleFindings"], [
    {
      rule: "project-label",
      asset: "rock",
      severity: "warning",
      evidence: "card",
      status: "failed",
    },
  ]);
  assert.match(readFileSync(join(warned.root, "rock.md"), "utf8"), /Updated title/);
});

test("description write enforces profile label errors before writes and reports warnings", async () => {
  const failed = library("error");
  const selection = await selectDescribed({ address: join(failed.root, "rock.md") });
  assert.equal(selection.pending.length, 1);
  const before = snapshot(failed.root);
  const summary = { description: "Synthetic stone", tags: ["prop"] };
  await assert.rejects(
    writeDescribed(
      selection.pending[0]!,
      summary,
      "fixture-model",
      join(failed.dir, "state"),
      false,
    ),
    /project rule project-label: rock \(card\)/,
  );
  assert.deepEqual(snapshot(failed.root), before);
  const warned = library("warning");
  const pending = (await selectDescribed({ address: join(warned.root, "rock.md") })).pending[0]!;
  const written = await writeDescribed(
    pending,
    summary,
    "fixture-model",
    join(warned.dir, "state"),
    false,
  );
  assert.ok("ruleFindings" in written);
  assert.deepEqual(written.ruleFindings, [
    {
      rule: "project-label",
      asset: "rock",
      severity: "warning",
      evidence: "card",
      status: "failed",
    },
  ]);
});

test("card edits enforce measured media budgets with the same prewrite gate", () => {
  const lib = library("warning");
  const path = join(lib.dir, PROFILE_PATH);
  const profile = JSON.parse(readFileSync(path, "utf8"));
  profile.rules.push({ id: "media-bytes", kind: "media", metric: "bytes", max: 1 });
  writeFileSync(path, JSON.stringify(profile));
  const before = snapshot(lib.root);
  const failed = edit(join(lib.root, "rock.md"));
  assert.equal(failed.code, 2);
  assert.match(JSON.stringify(failed.output), /project rule media-bytes: rock \(media\)/);
  assert.deepEqual(snapshot(lib.root), before);
});

test("card accept rejects project errors without mutation and returns warning findings", async () => {
  useAttended();
  for (const severity of ["error", "warning"] as const) {
    const lib = library(severity);
    const subject = (await selectDescribed({ address: join(lib.root, "rock.md"), propose: true }))
      .pending[0]!;
    const proposal = join(lib.dir, "proposal.json");
    writeFileSync(
      proposal,
      JSON.stringify(
        metadataProposal(subject, { description: "Wrong text", tags: [] }, "fixture-model", false),
      ),
    );
    const before = snapshot(lib.root);
    const result = await runCommand(
      cardAcceptCommand,
      { proposal, field: ["description"] },
      {
        settings: loadSettings(),
        log: () => {},
        prompt: { method: "tty", confirm: async () => true },
      },
    );
    if (severity === "error") {
      assert.equal(result.exitCode, 2);
      assert.match(result.error!.message, /project rule project-label: rock \(card\)/);
      assert.deepEqual(snapshot(lib.root), before);
    } else {
      assert.equal(result.exitCode, 0, result.error?.message);
      assert.deepEqual(result.fields.ruleFindings, [
        {
          rule: "project-label",
          asset: "rock",
          severity: "warning",
          evidence: "card",
          status: "failed",
        },
      ]);
      assert.match(readFileSync(join(lib.root, "rock.md"), "utf8"), /Wrong text/);
    }
  }
});
