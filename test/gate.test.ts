import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  gateSkills,
  KINDS,
  readEntries,
  requiredJobs,
  runGate,
  type GateEntry,
  type Runner,
} from "../scripts/gate.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const COMMIT = "0".repeat(40);

const dataIds = (
  JSON.parse(readFileSync(join(root, "scripts/gate-entries.json"), "utf8")) as {
    entries: { id: string }[];
  }
).entries.map((entry) => entry.id);

const BARS_AT = "2026-11-01T10:00:00Z";
const BENCH_AT = "2026-11-02T10:00:00Z";
const BARS = readFileSync(join(root, "docs/decisions.md"), "utf8");
const passedBar = (bar: string, reference?: boolean) => ({
  bar,
  measured: 0.9,
  target: ">= 0.85",
  pass: true,
  unit: "",
  n: 300,
  ...(reference === undefined ? {} : { reference }),
});
const GOOD_REPORT = [passedBar("look-category"), passedBar("words-shipped-p5")];

interface BenchWorld {
  /** The bars' commit time; its parent has no bars table. */
  barsAt?: string;
  /** The bench run's creation time. */
  benchAt?: string;
  /** Whether the bench run's head commit holds the bars' commit (default true). */
  barsInHead?: boolean;
  /** The bench run's head commit (default `c` x 40); `null` lists the run with no head_sha. */
  headSha?: string | null;
  /** The exit status `git merge-base` gives for the expected argv, overriding `barsInHead`. */
  ancestryStatus?: number;
  /** The bench report's lines. */
  report?: object[];
  /** The runs search-bench.yml lists, newest first, and which uploaded the bench report. */
  runs?: { id: number; report: boolean }[];
}

/**
 * Answers every command as passing and every API read with a successful run; nothing runs. The
 * search bench's reads answer from `world`: the git history of the bars, the bench runs and
 * their artifacts, and the downloaded report.
 */
function passingWith(world: BenchWorld = {}): Runner {
  const runs = world.runs ?? [{ id: 1, report: true }];
  const headSha = world.headSha === undefined ? "c".repeat(40) : world.headSha;
  return (argv) => {
    if (argv[0] === "git" && argv[1] === "log")
      return {
        status: 0,
        stdout: `${"b".repeat(40)} 2026-11-05T00:00:00Z\n${"a".repeat(40)} ${world.barsAt ?? BARS_AT}\n`,
        stderr: "",
      };
    if (argv[0] === "git" && argv[1] === "show") {
      // The newest commit and the bars' commit both hold the bars; the bars' parent has none.
      const rev = argv[2] ?? "";
      return rev.startsWith("a".repeat(40) + "^")
        ? { status: 128, stdout: "", stderr: "no such path" }
        : { status: 0, stdout: BARS, stderr: "" };
    }
    if (argv[0] === "git" && argv[1] === "merge-base") {
      // Only the ancestry question "is the bars' commit in the run's head?" is answered; any other
      // argv (another order, another commit) is an unknown revision, as Git reports it.
      const expected = ["git", "merge-base", "--is-ancestor", "a".repeat(40), headSha];
      if (JSON.stringify(argv) !== JSON.stringify(expected))
        return { status: 128, stdout: "", stderr: `fatal: unexpected ${argv.join(" ")}` };
      const status = world.ancestryStatus ?? (world.barsInHead === false ? 1 : 0);
      const stderr = status > 1 ? `fatal: Not a valid commit name ${headSha}` : "";
      return { status, stdout: "", stderr };
    }
    if (argv[0] === "gh" && argv[1] === "run" && argv[2] === "download") {
      const dir = argv[argv.indexOf("-D") + 1]!;
      writeFileSync(
        join(dir, "search-bench.txt"),
        [...(world.report ?? GOOD_REPORT), { dropped: [] }]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
      );
      return { status: 0, stdout: "", stderr: "" };
    }
    const path = argv[0] === "gh" ? (argv[2] ?? "") : "";
    if (path.includes("/jobs")) {
      const names = readEntries().flatMap((entry) => requiredJobs(root, entry));
      return {
        status: 0,
        stdout: JSON.stringify({ jobs: names.map((name) => ({ name, conclusion: "success" })) }),
        stderr: "",
      };
    }
    const artifacts = /\/runs\/(\d+)\/artifacts$/.exec(path);
    if (artifacts) {
      const has = runs.find((r) => r.id === Number(artifacts[1]))?.report;
      const names = has ? ["search-bench-report"] : ["search-bench-manifest"];
      return {
        status: 0,
        stdout: JSON.stringify({ artifacts: names.map((name) => ({ name })) }),
        stderr: "",
      };
    }
    if (path.includes("search-bench.yml/runs")) {
      const listed = runs.map((r) => ({
        id: r.id,
        status: "completed",
        conclusion: "success",
        html_url: `https://example.test/run/${r.id}`,
        created_at: world.benchAt ?? BENCH_AT,
        ...(headSha === null ? {} : { head_sha: headSha }),
      }));
      return { status: 0, stdout: JSON.stringify({ workflow_runs: listed }), stderr: "" };
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
}

const passing = passingWith();

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

test("an uncommitted change fails every entry run against the working tree, not the commit's CI entry", () => {
  const dirty: Runner = (argv, cwd) =>
    argv[0] === "git" && argv[1] === "status"
      ? { status: 0, stdout: " M src/cli.ts\n?? scratch.txt\n", stderr: "" }
      : passing(argv, cwd);
  const entries = readEntries().filter(
    (e) => e.kind !== "automated" || e.command || e.check === "ci-main",
  );
  const report = runGate({ entries, run: dirty, commit: COMMIT, requireClean: true });
  assert.equal(report.ok, false);
  for (const e of report.entries) {
    const tree = e.kind === "automated" && e.id !== "ci-main";
    assert.equal(e.status === "fail", tree, `${e.id}: ${e.status}`);
    if (tree) assert.match(e.detail, /differs from 0{40}.*2 uncommitted/);
  }
  assert.equal(runGate({ entries, run: passing, commit: COMMIT, requireClean: true }).ok, true);
});

const PHASE_2 = [
  "library-roundtrip",
  "core-without-search",
  "search-bars",
  "search-speed-bars",
  "r2-roundtrip",
  "real-checks",
  "release-verify",
  "host-confirmations",
  "publish",
  "invitations",
];

test("the gate lists every Phase 2 entry, and each non-automated entry names the evidence it needs", () => {
  const entries = readEntries();
  for (const id of PHASE_2)
    assert.ok(
      entries.some((e) => e.id === id),
      `${id} is listed`,
    );
  for (const entry of entries.filter((e) => e.kind !== "automated"))
    assert.ok(entry.evidence && entry.evidence.length > 20, `${entry.id} names its evidence`);
  const report = runGate({
    run: passing,
    commit: COMMIT,
    entries: entries.filter((e) => e.kind !== "automated"),
  });
  for (const entry of report.entries) assert.ok(entry.evidence, `${entry.id} reports its evidence`);
  const ci = entries.find((e) => e.id === "ci-main")!;
  // No pack is named in the entries: every pack's legs come from the list (scripts/packs.ts).
  assert.ok(!JSON.stringify(entries).includes("packages/"));
  for (const os of ["ubuntu-26.04", "macos-26", "windows-2025"])
    assert.ok(
      requiredJobs(root, ci).includes(`pack (assetgrove-search, ${os})`),
      `ci-main requires pack (assetgrove-search, ${os})`,
    );
});

const bench = () => readEntries().find((e) => e.id === "search-bars")!;

test("the search bars entry passes on a bench run made after the bars' commit, and reads its report", () => {
  const report = runGate({ entries: [bench()], run: passing, commit: COMMIT });
  assert.equal(report.entries[0]!.status, "pass", report.entries[0]!.detail);
  assert.match(report.entries[0]!.detail, /2 bars met; bars set in aaaaaaaaaaaa/);
  assert.equal(report.ok, true);
});

test("the search bars entry fails when the bars' commit is not older than the bench run it reads", () => {
  for (const barsAt of [BENCH_AT, "2026-11-03T10:00:00Z"]) {
    const report = runGate({
      entries: [bench()],
      run: passingWith({ barsAt }),
      commit: COMMIT,
    });
    assert.equal(report.entries[0]!.status, "fail");
    assert.match(report.entries[0]!.detail, /is not older than the bench run/);
    assert.equal(report.ok, false);
  }
});

test("the search bars entry fails when the bench run is later in time but its head lacks the bars' commit", () => {
  const report = runGate({
    entries: [bench()],
    run: passingWith({ barsInHead: false }),
    commit: COMMIT,
  });
  assert.equal(report.entries[0]!.status, "fail");
  assert.match(report.entries[0]!.detail, /does not hold the bars' commit a{40}/);
  assert.equal(report.ok, false);
});

test("the search bars entry fails when the bench run names no head commit", () => {
  const report = runGate({
    entries: [bench()],
    run: passingWith({ headSha: null }),
    commit: COMMIT,
  });
  assert.equal(report.entries[0]!.status, "fail");
  assert.match(report.entries[0]!.detail, /names no head commit/);
  assert.equal(report.ok, false);
});

test("the search bars entry fails, naming the Git error, when the ancestry check cannot run", () => {
  const report = runGate({
    entries: [bench()],
    run: passingWith({ ancestryStatus: 128 }),
    commit: COMMIT,
  });
  assert.equal(report.entries[0]!.status, "fail");
  assert.match(
    report.entries[0]!.detail,
    /failed \(fetch main's history\): fatal: Not a valid commit name c{40}/,
  );
  assert.equal(report.ok, false);
});

test("the search bars entry reads the newest run with a bench report and fails on a missed bar, not on an off-box speed bar", () => {
  const offBox = { ...passedBar("text-query-p95"), pass: false, reference: false };
  const skipsManifest = runGate({
    entries: [bench()],
    run: passingWith({
      runs: [
        { id: 7, report: false },
        { id: 5, report: true },
      ],
      report: [...GOOD_REPORT, offBox],
    }),
    commit: COMMIT,
  });
  assert.equal(skipsManifest.entries[0]!.status, "pass", skipsManifest.entries[0]!.detail);
  assert.equal(skipsManifest.entries[0]!.run, "https://example.test/run/5");

  const missed = runGate({
    entries: [bench()],
    run: passingWith({ report: [...GOOD_REPORT, { ...passedBar("look-recall10"), pass: false }] }),
    commit: COMMIT,
  });
  assert.equal(missed.entries[0]!.status, "fail");
  assert.match(missed.entries[0]!.detail, /bars missed: look-recall10/);

  const none = runGate({
    entries: [bench()],
    run: passingWith({ runs: [{ id: 7, report: false }] }),
    commit: COMMIT,
  });
  assert.equal(none.entries[0]!.status, "missing");
  assert.equal(none.ok, false);
});

test("the skills step installs assetgrove and every pack's skill from the repository into a temporary folder", () => {
  const skills = readEntries().find((e) => e.check === "skill-install")!;
  const calls: { argv: string[]; cwd: string }[] = [];
  const sources = Object.fromEntries(
    gateSkills(root).map((skill) => [skill.name, join(root, skill.dir)]),
  );
  // Stands in for `npx skills add`: copies the named skill where Claude Code's skills live.
  const installing =
    (only?: string): Runner =>
    (argv, cwd) => {
      calls.push({ argv, cwd });
      const name = argv[argv.indexOf("--skill") + 1]!;
      if (name !== only && only !== undefined) return { status: 0, stdout: "", stderr: "" };
      cpSync(sources[name]!, join(cwd, ".claude/skills", name), { recursive: true });
      return { status: 0, stdout: "", stderr: "" };
    };
  const report = runGate({ entries: [skills], run: installing(), commit: COMMIT });
  assert.equal(report.entries[0]!.status, "pass", report.entries[0]!.detail);
  assert.deepEqual(
    calls.map((c) => c.argv.slice(0, 5).concat(c.argv[c.argv.indexOf("--skill") + 1]!)),
    [
      ["npx", "-y", "skills@1.8.1", "add", root, "assetgrove"],
      ["npx", "-y", "skills@1.8.1", "add", root, "assetgrove-godot"],
      ["npx", "-y", "skills@1.8.1", "add", root, "assetgrove-icons"],
      ["npx", "-y", "skills@1.8.1", "add", root, "assetgrove-search"],
    ],
  );
  for (const call of calls) assert.equal(call.cwd, calls[0]!.cwd);
  assert.ok(!calls[0]!.cwd.startsWith(root), "installs into a temporary folder");

  const half = runGate({ entries: [skills], run: installing("assetgrove"), commit: COMMIT });
  assert.equal(half.entries[0]!.status, "fail");
  // The first pack skill not installed is named.
  assert.match(half.entries[0]!.detail, /assetgrove-godot: missing or changed after install/);
});

const temporary: string[] = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** A repository with core's skill and two packs, each with its own skill, at the release version. */
function twoPackTree(): string {
  const tree = realpathSync(mkdtempSync(join(tmpdir(), "assetgrove-gate-packs-")));
  temporary.push(tree);
  cpSync(join(root, "skills/assetgrove"), join(tree, "skills/assetgrove"), { recursive: true });
  writeFileSync(
    join(tree, "package.json"),
    JSON.stringify({
      name: "@clockgrove/assetgrove",
      version: "0.2.0",
      files: ["skills", "dist", "policy"],
    }),
  );
  for (const [dir, skill] of [
    ["fixture-tiles", "fixture-tiles-skill"],
    ["fixture-voice", "fixture-voice-skill"],
  ] as const) {
    mkdirSync(join(tree, "packages", dir, "skills", skill), { recursive: true });
    writeFileSync(
      join(tree, "packages", dir, "package.json"),
      JSON.stringify({
        name: `@clockgrove/${dir}`,
        version: "0.2.0",
        files: ["dist", "skills"],
        assetgrove: { api: 2, entry: "./dist/extension.js" },
      }),
    );
    writeFileSync(
      join(tree, "packages", dir, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: Load for the ${dir} fixture pack.\n---\n# ${skill}\n`,
    );
  }
  return tree;
}

test("a second pack's skill is in the gate's list, read from its package, with no gate edit", () => {
  const tree = twoPackTree();
  assert.deepEqual(gateSkills(tree), [
    { name: "assetgrove", dir: "skills/assetgrove" },
    { name: "fixture-tiles-skill", dir: "packages/fixture-tiles/skills/fixture-tiles-skill" },
    { name: "fixture-voice-skill", dir: "packages/fixture-voice/skills/fixture-voice-skill" },
  ]);

  const installed: string[] = [];
  const installing: Runner = (argv, cwd) => {
    if (argv[0] !== "npx") return { status: 0, stdout: "", stderr: "" };
    const name = argv[argv.indexOf("--skill") + 1]!;
    installed.push(name);
    const source = gateSkills(tree).find((skill) => skill.name === name)!;
    cpSync(join(tree, source.dir), join(cwd, ".claude/skills", name), { recursive: true });
    return { status: 0, stdout: "", stderr: "" };
  };
  const entries = readEntries().filter((e) => e.check === "skill-install" || e.check === "package");
  const report = runGate({ entries, root: tree, run: installing, commit: COMMIT });
  for (const entry of report.entries) assert.equal(entry.status, "pass", entry.detail);
  assert.deepEqual(installed, ["assetgrove", "fixture-tiles-skill", "fixture-voice-skill"]);
  assert.match(
    report.entries.find((e) => e.id === "package")!.detail,
    /@clockgrove\/fixture-voice 0.2.0/,
  );

  const ci = readEntries().find((e) => e.check === "ci-main")!;
  const legs = requiredJobs(tree, ci).filter((job) => job.startsWith("pack ("));
  assert.deepEqual(legs, [
    "pack (fixture-tiles, ubuntu-26.04)",
    "pack (fixture-tiles, macos-26)",
    "pack (fixture-tiles, windows-2025)",
    "pack (fixture-voice, ubuntu-26.04)",
    "pack (fixture-voice, macos-26)",
    "pack (fixture-voice, windows-2025)",
  ]);
});
