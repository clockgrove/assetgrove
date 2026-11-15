import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KINDS, readEntries, runGate, type GateEntry, type Runner } from "../scripts/gate.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const COMMIT = "0".repeat(40);

const dataIds = (
  JSON.parse(readFileSync(join(root, "scripts/gate-entries.json"), "utf8")) as {
    entries: { id: string }[];
  }
).entries.map((entry) => entry.id);

/** Answers every command as passing and every API read with a successful run; nothing runs. */
const passing: Runner = (argv) => {
  const path = argv[0] === "gh" ? (argv[2] ?? "") : "";
  if (path.includes("/jobs")) {
    const names = readEntries().flatMap((entry) => entry.jobs ?? []);
    return {
      status: 0,
      stdout: JSON.stringify({ jobs: names.map((name) => ({ name, conclusion: "success" })) }),
      stderr: "",
    };
  }
  if (path.includes("/runs")) {
    const run = {
      id: 1,
      status: "completed",
      conclusion: "success",
      html_url: "https://example.test/run/1",
    };
    return { status: 0, stdout: JSON.stringify({ workflow_runs: [run] }), stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};

test("the gate's entry ids equal the gate ids in its data file, and each has a kind", () => {
  const report = runGate({ run: passing, commit: COMMIT });
  assert.deepEqual(
    report.entries.map((entry) => entry.id),
    dataIds,
  );
  assert.equal(new Set(dataIds).size, dataIds.length, "gate ids are unique");
  for (const entry of report.entries)
    assert.ok(KINDS.includes(entry.kind), `${entry.id} has a kind`);
  for (const kind of KINDS)
    assert.ok(
      report.entries.some((entry) => entry.kind === kind),
      `some entry is ${kind}`,
    );
  assert.equal(report.commit, COMMIT);
});

test("every manual-owner entry lists its evidence and is owed; automated and dispatch entries have a way to check", () => {
  for (const entry of readEntries()) {
    if (entry.kind === "manual-owner") assert.ok(entry.evidence, `${entry.id} names its evidence`);
    if (entry.kind === "dispatch") assert.ok(entry.workflow, `${entry.id} names its workflow`);
    if (entry.kind === "automated")
      assert.ok(entry.command ?? entry.check, `${entry.id} names a command or check`);
  }
  const report = runGate({
    run: passing,
    commit: COMMIT,
    entries: readEntries().filter((e) => e.kind !== "automated" || e.command),
  });
  for (const entry of report.entries.filter((e) => e.kind === "manual-owner")) {
    assert.equal(entry.status, "owed");
    assert.ok(entry.evidence);
  }
  assert.equal(report.ok, true, "owed manual entries do not fail the gate");
});

const entry = (id: string, command: string[]): GateEntry => ({
  id,
  kind: "automated",
  title: id,
  command,
});

test("an automated entry whose command fails makes ok false", () => {
  const entries = [
    entry("passes", ["node", "-e", "process.exit(0)"]),
    entry("fails", ["node", "-e", "process.exit(3)"]),
  ];
  const report = runGate({ entries, commit: COMMIT });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.entries.map((e) => [e.id, e.status]),
    [
      ["passes", "pass"],
      ["fails", "fail"],
    ],
  );
  assert.match(report.entries[1]!.detail, /exited 3/);

  assert.equal(runGate({ entries: [entries[0]!], commit: COMMIT }).ok, true);
});

test("a dispatch entry with no run on the commit, or one still running, makes ok false", () => {
  const dispatch: GateEntry = { id: "d", kind: "dispatch", title: "d", workflow: "w.yml" };
  const none: Runner = () => ({
    status: 0,
    stdout: JSON.stringify({ workflow_runs: [] }),
    stderr: "",
  });
  const missing = runGate({ entries: [dispatch], run: none, commit: COMMIT });
  assert.equal(missing.ok, false);
  assert.equal(missing.entries[0]!.status, "missing");

  const running: Runner = () => ({
    status: 0,
    stdout: JSON.stringify({
      workflow_runs: [{ id: 2, status: "in_progress", conclusion: null, html_url: "u" }],
    }),
    stderr: "",
  });
  assert.equal(
    runGate({ entries: [dispatch], run: running, commit: COMMIT }).entries[0]!.status,
    "pending",
  );

  const unreadable: Runner = () => ({ status: 1, stdout: "", stderr: "no token" });
  const report = runGate({ entries: [dispatch], run: unreadable, commit: COMMIT });
  assert.equal(report.entries[0]!.status, "fail");
  assert.equal(report.ok, false);
});

test("the CI entry fails when a required job is not green", () => {
  const ci = readEntries().find((e) => e.check === "ci-main")!;
  const windowsRed: Runner = (argv) => {
    const out = passing(argv, root);
    if (!(argv[2] ?? "").includes("/jobs")) return out;
    const { jobs } = JSON.parse(out.stdout) as { jobs: { name: string; conclusion: string }[] };
    for (const job of jobs) if (job.name.includes("windows")) job.conclusion = "failure";
    return { ...out, stdout: JSON.stringify({ jobs }) };
  };
  const report = runGate({ entries: [ci], run: windowsRed, commit: COMMIT });
  assert.equal(report.ok, false);
  assert.match(report.entries[0]!.detail, /windows/);
});

test("the package entry checks the release candidate's manifest", () => {
  const pkg = readEntries().find((e) => e.check === "package")!;
  const report = runGate({ entries: [pkg], run: passing, commit: COMMIT });
  assert.equal(report.entries[0]!.status, "pass", report.entries[0]!.detail);
});
