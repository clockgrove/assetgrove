// The Phase 1 gate: `pnpm gate [--json]`. Reads scripts/gate-entries.json and reports one entry per
// gate id on the checked-out commit. Automated entries are checked here, by a command or a built-in
// check; dispatch entries are read from their workflow's latest run on the commit; manual-owner
// entries are listed with the evidence a person owes. GitHub is only read, through `gh api`.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
  const pkg = JSON.parse(readFileSync(join(ctx.root, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    files?: string[];
  };
  const faults: string[] = [];
  if (pkg.name !== "@clockgrove/assetgrove") faults.push(`name is ${pkg.name}`);
  if (pkg.version !== "0.1.0") faults.push(`version is ${pkg.version}, not 0.1.0`);
  const files = JSON.stringify([...(pkg.files ?? [])].sort());
  if (files !== JSON.stringify(["dist", "policy", "skills"])) faults.push(`files is ${files}`);
  return faults.length === 0
    ? { status: "pass", detail: "@clockgrove/assetgrove 0.1.0, files dist, skills, policy" }
    : { status: "fail", detail: faults.join("; ") };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => name.split("\\").join("/"))
    .sort();
}

function checkSkillInstall(ctx: Ctx): Outcome {
  const source = join(ctx.root, "skills/assetgrove");
  const target = mkdtempSync(join(tmpdir(), "assetgrove-gate-skill-"));
  try {
    const argv = ["npx", "-y", SKILLS_CLI, "add", ctx.root];
    argv.push("--skill", "assetgrove", "--agent", "claude-code", "--copy", "-y");
    const out = ctx.run(argv, target);
    if (out.status !== 0) {
      return { status: "fail", detail: `skills add exited ${out.status}: ${tail(out.stderr, 5)}` };
    }
    const installed = join(target, ".claude/skills/assetgrove");
    const missing = filesUnder(source).filter((name) => {
      try {
        return !readFileSync(join(installed, name)).equals(readFileSync(join(source, name)));
      } catch {
        return true;
      }
    });
    if (missing.length === 0) {
      const count = filesUnder(source).length;
      return {
        status: "pass",
        detail: `${count} files arrived intact in ${relative(target, installed)}`,
      };
    }
    return { status: "fail", detail: `missing or changed after install: ${missing.join(", ")}` };
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

const CHECKS: Record<string, (ctx: Ctx, entry: GateEntry) => Outcome> = {
  package: checkPackage,
  "skill-install": checkSkillInstall,
  "ci-main": checkCiMain,
};

function evaluate(ctx: Ctx, entry: GateEntry): Outcome {
  switch (entry.kind) {
    case "manual-owner":
      return { status: "owed", detail: "a person supplies the evidence" };
    case "dispatch":
      if (!entry.workflow) return { status: "fail", detail: "entry names no workflow" };
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

export function runGate(options: {
  entries?: GateEntry[];
  root?: string;
  run?: Runner;
  commit?: string;
}): GateReport {
  const root = options.root ?? ROOT;
  const run = options.run ?? defaultRunner;
  const commit = options.commit ?? run(["git", "rev-parse", "HEAD"], root).stdout.trim();
  const ctx: Ctx = { root, commit, run };
  const entries = (options.entries ?? readEntries()).map((entry): EntryResult => {
    let outcome: Outcome;
    try {
      outcome = evaluate(ctx, entry);
    } catch (error) {
      outcome = { status: "fail", detail: error instanceof Error ? error.message : String(error) };
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
