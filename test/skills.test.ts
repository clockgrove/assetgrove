import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { commandNames, commands } from "../src/commands/registry.ts";
import { cliFlags, toolInputSchema } from "../src/commands/runner.ts";
import type { CommandSpec } from "../src/commands/types.ts";
import { writeProjectFiles } from "../src/init.ts";

/** The Agent Skills rules every SKILL.md must meet, so each harness loads it. */
async function checkSkill(path: string): Promise<void> {
  const text = await readFile(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, `${path}: front matter`);
  const doc = parseDocument(match[1]!, { strict: true, uniqueKeys: true });
  assert.deepEqual(doc.errors, [], `${path}: strict YAML`);
  const data = doc.toJS() as { name?: unknown; description?: unknown };
  assert.equal(data.name, basename(dirname(path)), `${path}: name matches its folder`);
  assert.match(String(data.name), /^[a-z0-9-]{1,64}$/, `${path}: name characters`);
  assert.equal(typeof data.description, "string", `${path}: description`);
  assert.ok((data.description as string).length <= 1024, `${path}: description length`);
  assert.ok(text.split("\n").length < 500, `${path}: under 500 lines`);
}

test("every skill the package ships meets the Agent Skills rules", async () => {
  const root = fileURLToPath(new URL("../skills/", import.meta.url));
  const folders = await readdir(root);
  assert.ok(folders.length > 0);
  for (const folder of folders) await checkSkill(join(root, folder, "SKILL.md"));
});

test("the skill init writes meets the rules, where every harness reads skills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assetgrove-skills-"));
  try {
    const files = await writeProjectFiles({
      directory: dir,
      profilePreset: "sprite-32",
      stylePreset: "cozy-storybook",
      world: "Synthetic world",
    });
    const skillPaths = files.filter((f) => f.role === "skill").map((f) => f.path);
    const biblePath = files.find((f) => f.role === "bible")!.path;
    assert.equal(skillPaths.length, 2);
    for (const path of skillPaths) await checkSkill(path);
    const [claude, agents] = await Promise.all(skillPaths.map((p) => readFile(p, "utf8")));
    assert.equal(claude, agents);
    // The skill's links resolve from its folder to the bible init wrote.
    const link = /\]\(([^)]*BIBLE\.md)\)/.exec(claude!)![1]!;
    assert.equal(join(dirname(skillPaths[0]!), link), biblePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const skillDir = fileURLToPath(new URL("../skills/assetgrove/", import.meta.url));
/** The search package's skill: the reference of the commands that need the search slot. */
const searchSkillDir = fileURLToPath(
  new URL("../packages/assetgrove-search/skills/assetgrove-search/", import.meta.url),
);

/** Core's commands, which core's skill describes; the search-only ones are the package's. */
const coreCommands = commands.filter((c) => c.requires === undefined);
const searchCommands = commands.filter((c) => c.requires === "search");

/** The `--flag` names a text mentions. */
function flags(text: string): Set<string> {
  return new Set(text.match(/(?<![\w-])--[a-z][a-z0-9-]*/g) ?? []);
}

/** SKILL.md and every Markdown file of its folder it links, by path relative to the folder. */
async function shippedSkill(dir = skillDir): Promise<Map<string, string>> {
  const entry = await readFile(join(dir, "SKILL.md"), "utf8");
  const files = new Map([["SKILL.md", entry]]);
  for (const m of entry.matchAll(/\]\(((?:[\w-]+\/)*[\w-]+\.md)(?:#[^)]*)?\)/g))
    files.set(m[1]!, await readFile(join(dir, m[1]!), "utf8"));
  return files;
}

/**
 * What the skill gets wrong about the registry: a command with no `### <name>` section, a section
 * for no command, a section that lacks one of its command's flags or names a flag the command
 * lacks, a section that does not name its command's MCP tool, and, outside the sections, a flag
 * no command takes.
 */
function referenceProblems(
  texts: Iterable<string>,
  described: readonly CommandSpec[] = coreCommands,
): string[] {
  const problems: string[] = [];
  const sections = new Map<string, string>();
  const rest: string[] = [];
  for (const text of texts) {
    let current: string | undefined;
    for (const line of text.split("\n")) {
      if (/^#{1,6} /.test(line)) {
        current = /^### `?([a-z0-9-]+(?: [a-z0-9-]+)?)`?$/.exec(line)?.[1];
        if (current !== undefined) {
          if (sections.has(current)) problems.push(`the skill describes ${current} twice`);
          sections.set(current, "");
        }
      }
      if (current === undefined) rest.push(line);
      else sections.set(current, `${sections.get(current)!}${line}\n`);
    }
  }
  for (const spec of described) {
    const section = sections.get(spec.name);
    if (section === undefined) {
      problems.push(`no section for ${spec.name}`);
      continue;
    }
    const accepted = new Set(cliFlags(spec).map((f) => `--${f}`));
    const mentioned = flags(section);
    for (const flag of accepted)
      if (flag !== "--help" && !mentioned.has(flag))
        problems.push(`the ${spec.name} section lacks ${flag}`);
    for (const flag of mentioned)
      if (!accepted.has(flag))
        problems.push(`the ${spec.name} section names ${flag}, not a flag of it`);
    const toolLines = section.split("\n").filter((l) => l.startsWith("MCP tool:"));
    if (spec.tool === null) {
      if (toolLines.length > 0) problems.push(`the ${spec.name} section names a tool, it has none`);
    } else if (toolLines.length === 0) {
      problems.push(`the ${spec.name} section does not name its tool`);
    } else {
      const properties = Object.keys(
        (toolInputSchema(spec) as { properties: Record<string, unknown> }).properties,
      );
      for (const line of toolLines) {
        const names = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
        const [tool, ...args] = names;
        if (tool !== spec.tool)
          problems.push(`the ${spec.name} section names tool ${tool}, not ${spec.tool}`);
        for (const arg of args)
          if (!properties.includes(arg))
            problems.push(
              `the ${spec.name} section names argument ${arg}, not an argument of tool ${spec.tool}`,
            );
        for (const arg of properties)
          if (!args.includes(arg)) problems.push(`the ${spec.name} section lacks argument ${arg}`);
      }
    }
  }
  const names = described.map((c) => c.name);
  for (const name of sections.keys()) {
    const other = commands.find((c) => c.name === name);
    if (other !== undefined && !names.includes(name))
      problems.push(
        other.requires !== undefined
          ? `the skill describes ${name}, which needs the ${other.requires} package; its reference describes it`
          : `the skill describes ${name}, a core command; core's reference describes it`,
      );
    else if (!commandNames.includes(name)) problems.push(`a section for ${name}, not a command`);
  }
  const known = new Set([
    "--json",
    "--help",
    "--version",
    ...commands.flatMap((c) => cliFlags(c).map((f) => `--${f}`)),
  ]);
  for (const flag of flags(rest.join("\n")))
    if (!known.has(flag)) problems.push(`the skill names unknown ${flag}`);
  return problems;
}

test("the shipped skill describes every registry command with exactly its flags", async () => {
  const skill = await shippedSkill();
  assert.ok(skill.has("references/commands.md"), "SKILL.md links the command reference");
  assert.deepEqual(referenceProblems(skill.values()), []);
});

test("the reference check fails when a command has no section or a section lacks a flag", async () => {
  const skill = await shippedSkill();
  const reference = skill.get("references/commands.md")!;
  const withOut = (text: string) => referenceProblems([skill.get("SKILL.md")!, text]);
  const noSection = reference.replace(/^### `ops`$/m, "#### ops");
  assert.notEqual(noSection, reference);
  assert.ok(withOut(noSection).includes("no section for ops"));
  const noFlag = reference.replaceAll("[--dry-run] ", "").replace(/`--dry-run`/g, "dry run");
  assert.notEqual(noFlag, reference);
  assert.ok(withOut(noFlag).includes("the stage section lacks --dry-run"));
  const extraFlag = reference.replace("ops [--json]", "ops [--json] [--bogus]");
  assert.ok(withOut(extraFlag).includes("the ops section names --bogus, not a flag of it"));
  const wrongTool = reference.replace("MCP tool: `look_dev`", "MCP tool: `look_devs`");
  assert.notEqual(wrongTool, reference);
  assert.ok(withOut(wrongTool).includes("the look-dev section names tool look_devs, not look_dev"));
  const wrongArg = reference.replace("`jitterBound`", "`jitterBounds`");
  assert.notEqual(wrongArg, reference);
  assert.ok(
    withOut(wrongArg).includes(
      "the write-families section names argument jitterBounds, not an argument of tool write_families",
    ),
  );
  assert.ok(withOut(wrongArg).includes("the write-families section lacks argument jitterBound"));
  const noArg = reference.replace(", `jitterBound`.", ".");
  assert.notEqual(noArg, reference);
  assert.ok(withOut(noArg).includes("the write-families section lacks argument jitterBound"));
  const noLine = reference.replace(/^MCP tool: `ops`.*\n/m, "");
  assert.notEqual(noLine, reference);
  assert.ok(withOut(noLine).includes("the ops section does not name its tool"));
});

test("the search package's skill describes every search-only command with exactly its flags", async () => {
  assert.deepEqual(
    searchCommands.map((c) => c.name),
    ["find", "search index", "search status"],
  );
  await checkSkill(join(searchSkillDir, "SKILL.md"));
  const skill = await shippedSkill(searchSkillDir);
  assert.ok(skill.has("references/commands.md"), "SKILL.md links the command reference");
  assert.deepEqual(referenceProblems(skill.values(), searchCommands), []);
});

test("core's skill describes no search-only command, and the check refuses one there", async () => {
  const core = await shippedSkill();
  for (const text of core.values())
    for (const spec of searchCommands)
      assert.ok(!text.includes(`### \`${spec.name}\``), `core's skill describes ${spec.name}`);
  const search = (await shippedSkill(searchSkillDir)).get("references/commands.md")!;
  const findSection = /### `find`[\s\S]*?(?=\n### )/.exec(search)![0];
  const problems = referenceProblems([...core.values(), findSection]);
  assert.ok(
    problems.some((p) => p.includes("find, which needs the search package")),
    problems.join("; "),
  );
});
