// The release gate (Phase 1, extended for Phase 2): `pnpm gate [--json]`. Reads
// scripts/gate-entries.json and reports one entry per gate id on the checked-out commit. Automated
// entries are checked here, by a command or a built-in check; dispatch entries are read from their
// workflow's latest run on the commit (or by a built-in check, for the search bench, which runs
// once); manual-owner entries are listed with the evidence a person owes. GitHub is only read,
// through `gh api` and `gh run download`.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBars } from "../bench/search/bars.ts";

export type Kind = "automated" | "dispatch" | "manual-owner";
export type Status = "pass" | "fail" | "missing" | "pending" | "owed";

export interface GateEntry {
  id: string;
  kind: Kind;
  title: string;
  command?: string[];
  check?: string;
  workflow?: string;
  jobs?: string[];
  evidence?: string;
}

export interface EntryResult {
  id: string;
  kind: Kind;
  title: string;
  status: Status;
  detail: string;
  evidence?: string;
  run?: string;
}

export interface GateReport {
  ok: boolean;
  commit: string;
  entries: EntryResult[];
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one argv; injected so tests make no network call and run no suite. */
export type Runner = (argv: string[], cwd: string) => RunResult;

export const KINDS: readonly Kind[] = ["automated", "dispatch", "manual-owner"];
export const SKILLS_CLI = "skills@1.8.1";
export const VERSION = "0.2.0";

/** The release candidate's packages: each manifest, its name and the files it ships. */
export const PACKAGES = [
  { dir: ".", name: "@clockgrove/assetgrove", files: ["dist", "policy", "skills"] },
  {
    dir: "packages/assetgrove-search",
    name: "@clockgrove/assetgrove-search",
    files: ["dist", "skills"],
  },
] as const;

/** The skills the gate installs with `npx skills add` from the repository, and where each lives. */
export const SKILLS = [
  { name: "assetgrove", dir: "skills/assetgrove" },
  { name: "assetgrove-search", dir: "packages/assetgrove-search/skills/assetgrove-search" },
] as const;

/** The bench report artifact the search bench's bench step uploads, and its file. */
export const BENCH_ARTIFACT = "search-bench-report";
export const BENCH_REPORT = "search-bench.txt";
/** Where the search bars are recorded. */
export const BARS_FILE = "docs/decisions.md";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const defaultRunner: Runner = (argv, cwd) => {
  const [file, ...args] = argv;
  if (!file) return { status: 1, stdout: "", stderr: "empty command" };
  const out = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    // pnpm, npx and gh are .cmd shims on Windows.
    shell: process.platform === "win32",
  });
  return {
    status: out.status,
    stdout: out.stdout ?? "",
    stderr: out.error ? String(out.error.message) : (out.stderr ?? ""),
  };
};

export function readEntries(path = join(ROOT, "scripts/gate-entries.json")): GateEntry[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as { format: string; entries: GateEntry[] };
  if (data.format !== "assetgrove-gate/1")
    throw new Error(`${path}: unknown format ${data.format}`);
  return data.entries;
}

function tail(text: string, lines = 20): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

function slugOf(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    repository?: { url?: string };
  };
  const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pkg.repository?.url ?? "");
  if (!match?.[1]) throw new Error("package.json repository.url names no repository");
  return match[1];
}

interface Ctx {
  root: string;
  commit: string;
  run: Runner;
}

type Outcome = Pick<EntryResult, "status" | "detail"> & { run?: string };

function ghJson<T>(ctx: Ctx, path: string): T {
  const out = ctx.run(["gh", "api", path], ctx.root);
  if (out.status !== 0) throw new Error(`gh api ${path} failed: ${tail(out.stderr, 3)}`);
  return JSON.parse(out.stdout) as T;
}

interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at?: string;
  head_sha?: string;
}

function latestRun(ctx: Ctx, workflow: string, query = ""): WorkflowRun | undefined {
  const slug = slugOf(ctx.root);
  const runs = ghJson<{ workflow_runs?: WorkflowRun[] }>(
    ctx,
    `repos/${slug}/actions/workflows/${workflow}/runs?head_sha=${ctx.commit}&per_page=1${query}`,
  );
  return runs.workflow_runs?.[0];
}

function runOutcome(run: WorkflowRun | undefined, workflow: string): Outcome {
  if (!run) return { status: "missing", detail: `no ${workflow} run on this commit` };
  if (run.status !== "completed") {
    return { status: "pending", detail: `${workflow} run is ${run.status}`, run: run.html_url };
  }
  return run.conclusion === "success"
    ? { status: "pass", detail: `${workflow} run succeeded`, run: run.html_url }
    : { status: "fail", detail: `${workflow} run concluded ${run.conclusion}`, run: run.html_url };
}

function checkPackage(ctx: Ctx): Outcome {
  const faults: string[] = [];
  for (const wanted of PACKAGES) {
    const pkg = JSON.parse(readFileSync(join(ctx.root, wanted.dir, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
      files?: string[];
    };
    const where = `${wanted.dir}/package.json`;
    if (pkg.name !== wanted.name) faults.push(`${where}: name is ${pkg.name}`);
    if (pkg.version !== VERSION) faults.push(`${where}: version is ${pkg.version}, not ${VERSION}`);
    const files = JSON.stringify([...(pkg.files ?? [])].sort());
    if (files !== JSON.stringify(wanted.files)) faults.push(`${where}: files is ${files}`);
  }
  return faults.length === 0
    ? {
        status: "pass",
        detail: PACKAGES.map((p) => `${p.name} ${VERSION}, files ${p.files.join(", ")}`).join("; "),
      }
    : { status: "fail", detail: faults.join("; ") };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => name.split("\\").join("/"))
    .sort();
}

function checkSkillInstall(ctx: Ctx): Outcome {
  const target = mkdtempSync(join(tmpdir(), "assetgrove-gate-skill-"));
  try {
    const arrived: string[] = [];
    for (const skill of SKILLS) {
      const source = join(ctx.root, skill.dir);
      const argv = ["npx", "-y", SKILLS_CLI, "add", ctx.root];
      argv.push("--skill", skill.name, "--agent", "claude-code", "--copy", "-y");
      const out = ctx.run(argv, target);
      if (out.status !== 0) {
        return {
          status: "fail",
          detail: `skills add ${skill.name} exited ${out.status}: ${tail(out.stderr, 5)}`,
        };
      }
      const installed = join(target, ".claude/skills", skill.name);
      const missing = filesUnder(source).filter((name) => {
        try {
          return !readFileSync(join(installed, name)).equals(readFileSync(join(source, name)));
        } catch {
          return true;
        }
      });
      if (missing.length > 0) {
        return {
          status: "fail",
          detail: `${skill.name}: missing or changed after install: ${missing.join(", ")}`,
        };
      }
      arrived.push(
        `${skill.name}: ${filesUnder(source).length} files intact in ${relative(target, installed)}`,
      );
    }
    return { status: "pass", detail: arrived.join("; ") };
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

function checkCiMain(ctx: Ctx, entry: GateEntry): Outcome {
  const workflow = entry.workflow ?? "ci.yml";
  const run = latestRun(ctx, workflow, "&event=push&branch=main");
  const outcome = runOutcome(run, `${workflow} push to main`);
  if (!run || outcome.status !== "pass") return { ...outcome, status: "fail" };
  const { jobs } = ghJson<{ jobs: { name: string; conclusion: string | null }[] }>(
    ctx,
    `repos/${slugOf(ctx.root)}/actions/runs/${run.id}/jobs?per_page=100`,
  );
  const failed = (entry.jobs ?? []).filter(
    (name) => jobs.find((job) => job.name === name)?.conclusion !== "success",
  );
  return failed.length === 0
    ? { ...outcome, detail: `jobs succeeded: ${(entry.jobs ?? []).join(", ")}` }
    : { status: "fail", detail: `jobs not green: ${failed.join(", ")}`, run: run.html_url };
}

interface BarsCommit {
  commit: string;
  at: string;
}

/** The newest commit whose search-bars table differs from its parent's: when the bars were set. */
export function barsCommit(ctx: { root: string; run: Runner }): BarsCommit {
  const log = ctx.run(["git", "log", "--format=%H %cI", "--", BARS_FILE], ctx.root);
  if (log.status !== 0) throw new Error(`git log ${BARS_FILE} failed: ${tail(log.stderr, 3)}`);
  const bars = (rev: string): string => {
    const out = ctx.run(["git", "show", `${rev}:${BARS_FILE}`], ctx.root);
    return out.status === 0 ? JSON.stringify(parseBars(out.stdout)) : "[]";
  };
  for (const line of log.stdout.split(/\r?\n/).filter((l) => l.trim() !== "")) {
    const [commit = "", at = ""] = line.trim().split(" ");
    const here = bars(commit);
    if (here !== "[]" && here !== bars(`${commit}^`)) return { commit, at };
  }
  throw new Error(`no commit sets the search bars in ${BARS_FILE}`);
}

interface BenchLine {
  bar?: string;
  pass?: boolean;
  measured?: number;
  target?: string;
  reference?: boolean;
}

/**
 * The search bench: the latest successful search-bench.yml run on main that uploaded a bench
 * report. The bars must be committed before that run, and every bar it counts must pass; a speed
 * bar measured off the reference box does not count here (a manual entry covers the reference box).
 */
function checkSearchBench(ctx: Ctx, entry: GateEntry): Outcome {
  const workflow = entry.workflow ?? "search-bench.yml";
  const slug = slugOf(ctx.root);
  const { workflow_runs: runs = [] } = ghJson<{ workflow_runs?: WorkflowRun[] }>(
    ctx,
    `repos/${slug}/actions/workflows/${workflow}/runs?branch=main&status=success&per_page=20`,
  );
  const run = runs.find((candidate) => {
    const { artifacts = [] } = ghJson<{ artifacts?: { name: string }[] }>(
      ctx,
      `repos/${slug}/actions/runs/${candidate.id}/artifacts`,
    );
    return artifacts.some((artifact) => artifact.name === BENCH_ARTIFACT);
  });
  if (!run) return { status: "missing", detail: `no successful ${workflow} bench run on main` };
  const set = barsCommit(ctx);
  if (!run.created_at || !(Date.parse(set.at) < Date.parse(run.created_at))) {
    return {
      status: "fail",
      detail: `the bars' commit ${set.commit} (${set.at}) is not older than the bench run it reads (${run.created_at ?? "no time"}); run the bench again after the bars are committed`,
      run: run.html_url,
    };
  }
  // A time comparison alone is not enough: a merge-queue commit's committer time is when it was
  // queued, so the run must also have checked out a commit that holds the bars.
  if (!run.head_sha) {
    return {
      status: "fail",
      detail: `the bench run ${run.id} names no head commit, so the gate cannot tell it measured the bars' commit ${set.commit}`,
      run: run.html_url,
    };
  }
  const held = ctx.run(["git", "merge-base", "--is-ancestor", set.commit, run.head_sha], ctx.root);
  if (held.status !== 0) {
    return {
      status: "fail",
      detail:
        held.status === 1
          ? `the bench run's commit ${run.head_sha} does not hold the bars' commit ${set.commit}; run the bench again on a main that holds the bars`
          : `git merge-base --is-ancestor ${set.commit} ${run.head_sha} failed (fetch main's history): ${tail(held.stderr, 3)}`,
      run: run.html_url,
    };
  }
  const dir = mkdtempSync(join(tmpdir(), "assetgrove-gate-bench-"));
  try {
    const download = ["gh", "run", "download", String(run.id), "--repo", slug];
    download.push("-n", BENCH_ARTIFACT, "-D", dir);
    const out = ctx.run(download, ctx.root);
    if (out.status !== 0) {
      return {
        status: "fail",
        detail: `gh run download ${run.id} failed: ${tail(out.stderr, 3)}`,
        run: run.html_url,
      };
    }
    let text: string;
    try {
      text = readFileSync(join(dir, BENCH_REPORT), "utf8");
    } catch {
      return {
        status: "fail",
        detail: `the run's report has no ${BENCH_REPORT}`,
        run: run.html_url,
      };
    }
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as BenchLine)
      .filter((line) => typeof line.bar === "string");
    if (lines.length === 0)
      return { status: "fail", detail: "the bench report lists no bar", run: run.html_url };
    const counted = lines.filter((line) => line.reference !== false);
    const missed = counted.filter((line) => line.pass !== true);
    const at = `bars set in ${set.commit.slice(0, 12)} (${set.at}), before the run (${run.created_at})`;
    return missed.length === 0
      ? { status: "pass", detail: `${counted.length} bars met; ${at}`, run: run.html_url }
      : {
          status: "fail",
          detail: `bars missed: ${missed.map((m) => `${m.bar} ${m.measured} (${m.target})`).join(", ")}; ${at}`,
          run: run.html_url,
        };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CHECKS: Record<string, (ctx: Ctx, entry: GateEntry) => Outcome> = {
  package: checkPackage,
  "skill-install": checkSkillInstall,
  "ci-main": checkCiMain,
  "search-bench": checkSearchBench,
};

function evaluate(ctx: Ctx, entry: GateEntry): Outcome {
  switch (entry.kind) {
    case "manual-owner":
      return { status: "owed", detail: "a person supplies the evidence" };
    case "dispatch":
      if (!entry.workflow) return { status: "fail", detail: "entry names no workflow" };
      if (entry.check) {
        const check = CHECKS[entry.check];
        if (!check) return { status: "fail", detail: `unknown check ${entry.check}` };
        return check(ctx, entry);
      }
      return runOutcome(latestRun(ctx, entry.workflow), entry.workflow);
    case "automated": {
      if (entry.command) {
        const out = ctx.run(entry.command, ctx.root);
        return out.status === 0
          ? { status: "pass", detail: `${entry.command.join(" ")} exited 0` }
          : {
              status: "fail",
              detail: `${entry.command.join(" ")} exited ${out.status}\n${tail(out.stderr || out.stdout)}`,
            };
      }
      const check = entry.check ? CHECKS[entry.check] : undefined;
      if (!check) return { status: "fail", detail: `unknown check ${entry.check}` };
      return check(ctx, entry);
    }
    default:
      return { status: "fail", detail: `unknown kind ${String(entry.kind)}` };
  }
}

/** Built-in checks that read GitHub for the commit rather than the working tree. */
const COMMIT_CHECKS = new Set(["ci-main"]);

/** True when the entry runs against the working tree, so a dirty tree is not the commit. */
function readsTree(entry: GateEntry): boolean {
  return entry.kind === "automated" && !(entry.check && COMMIT_CHECKS.has(entry.check));
}

/** `git status --porcelain` lines: tracked changes and untracked files; empty when clean. */
function treeChanges(run: Runner, root: string): string[] {
  const out = run(["git", "status", "--porcelain"], root);
  if (out.status !== 0) return [`git status failed: ${tail(out.stderr, 3)}`];
  return out.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
}

export function runGate(options: {
  entries?: GateEntry[];
  root?: string;
  run?: Runner;
  commit?: string;
  /** Require a clean working tree for entries run against it; defaults to true when `commit` is not given. */
  requireClean?: boolean;
}): GateReport {
  const root = options.root ?? ROOT;
  const run = options.run ?? defaultRunner;
  const commit = options.commit ?? run(["git", "rev-parse", "HEAD"], root).stdout.trim();
  const ctx: Ctx = { root, commit, run };
  const changes =
    (options.requireClean ?? options.commit === undefined) ? treeChanges(run, root) : [];
  const entries = (options.entries ?? readEntries()).map((entry): EntryResult => {
    let outcome: Outcome;
    try {
      outcome = evaluate(ctx, entry);
    } catch (error) {
      outcome = { status: "fail", detail: error instanceof Error ? error.message : String(error) };
    }
    if (changes.length > 0 && readsTree(entry)) {
      outcome = {
        status: "fail",
        detail: `ran on a working tree that differs from ${commit} (${changes.length} uncommitted changes: ${changes.slice(0, 5).join("; ")}); commit or stash them and run the gate again\n${outcome.status}: ${outcome.detail}`,
      };
    }
    return {
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      ...outcome,
      ...(entry.evidence ? { evidence: entry.evidence } : {}),
    };
  });
  const ok = entries.every((entry) => entry.kind === "manual-owner" || entry.status === "pass");
  return { ok, commit, entries };
}

if (import.meta.main) {
  const report = runGate({});
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const entry of report.entries) {
      process.stdout.write(
        `${entry.status.padEnd(7)} ${entry.kind.padEnd(12)} ${entry.id}: ${entry.title}\n`,
      );
      if (entry.status !== "pass")
        process.stdout.write(`        ${entry.evidence ?? entry.detail}\n`);
    }
    process.stdout.write(`${report.ok ? "ok" : "not ok"} ${report.commit}\n`);
  }
  process.exitCode = report.ok ? 0 : 1;
}
