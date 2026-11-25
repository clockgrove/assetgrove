import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseOrigin } from "../src/origin.ts";
import { libraryProfile } from "./fixtures/library.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repo, "src", "cli.ts");
const guidePath = join(repo, "docs", "launch-guide.md");
const exampleDir = join(repo, "docs", "examples", "launch");
const exampleReadme = join(exampleDir, "README.md");

const read = async (path: string): Promise<string> =>
  (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await read(path)) as Record<string, unknown>;

const NAMESPACES = new Set(["library", "extensions"]);

/** The `assetgrove ...` commands of the guide's sh blocks, as command words and flags. */
function guideCommands(guide: string): Array<{ words: string[]; flags: string[] }> {
  const found: Array<{ words: string[]; flags: string[] }> = [];
  for (const block of guide.matchAll(/```sh\n([\s\S]*?)```/g)) {
    const lines = block[1]!.replace(/\\\n/g, " ").split("\n");
    for (const line of lines) {
      const match = /^assetgrove\s+(.*)$/.exec(line.trim());
      if (!match) continue;
      const tokens = match[1]!.split(/\s+/);
      const words = [tokens[0]!];
      if (NAMESPACES.has(tokens[0]!)) words.push(tokens[1]!);
      const flags = tokens.filter((token) => /^--[a-z][a-z-]*$/.test(token));
      found.push({ words, flags });
    }
  }
  return found;
}

test("every command and flag in the guide's shell blocks is in the command's usage", async () => {
  const commands = guideCommands(await read(guidePath));
  const names = new Set(commands.map((command) => command.words.join(" ")));
  for (const name of [
    "init",
    "plan",
    "apply",
    "pick",
    "stage-source",
    "import",
    "write-families",
    "review",
    "library worklist",
    "approve",
    "library adopt",
    "extensions setup",
    "doctor",
    "disclosure",
  ])
    assert.ok(names.has(name), `the guide shows no \`assetgrove ${name}\` command`);
  const usage = new Map<string, string>();
  for (const name of names)
    usage.set(
      name,
      execFileSync(process.execPath, [cliPath, ...name.split(" "), "--help"], {
        cwd: repo,
        encoding: "utf8",
        timeout: 60000,
      }),
    );
  for (const { words, flags } of commands) {
    const name = words.join(" ");
    assert.match(usage.get(name)!, /Usage: assetgrove /, `${name} has no usage`);
    for (const flag of flags)
      assert.ok(usage.get(name)!.includes(flag), `\`assetgrove ${name}\` has no ${flag}`);
  }
});

const slug = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- _]/gu, "")
    .replace(/ /g, "-");

const anchorsOf = (markdown: string): Set<string> =>
  new Set(
    [...markdown.replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map((match) =>
      slug(match[1]!.replace(/`/g, "")),
    ),
  );

for (const path of [guidePath, exampleReadme]) {
  test(`every relative link in ${path.slice(repo.length).replaceAll("\\", "/")} resolves`, async () => {
    const text = (await read(path)).replace(/```[\s\S]*?```/g, "");
    const targets = [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]!);
    assert.ok(targets.length > 0);
    for (const target of targets) {
      if (/^https?:/.test(target)) continue;
      const [file = "", anchor] = target.split("#");
      const resolved = resolve(dirname(path), file);
      assert.ok(existsSync(resolved), `${target} does not exist`);
      if (anchor !== undefined && file.endsWith(".md"))
        assert.ok(anchorsOf(await read(resolved)).has(anchor), `${target} has no such heading`);
    }
  });
}

test("the example files parse as the guide says", async () => {
  const origin = parseOrigin(await readJson(join(exampleDir, "beetle.origin.json")));
  assert.equal(origin.kind, "third-party");
  assert.equal(origin.license, "CC-BY-4.0");
  const profile = (await readJson(join(exampleDir, "profile-fragment.json"))) as {
    handoff: Array<{ preset: string }>;
  };
  assert.deepEqual(
    profile.handoff.map((entry) => entry.preset),
    ["manifest", "godot:sprite-frames"],
  );
  const fern = await readJson(join(exampleDir, "fern.json"));
  assert.equal(fern["kind"], "still");
  assert.equal(typeof fern["animationFamily"], "string");
  const mole = await readJson(join(exampleDir, "mole-walk.json"));
  assert.equal(mole["kind"], "sprite-strip");
  assert.equal(typeof mole["animationFamily"], "string");
});

test("the CLI runs the guide's third-party import offline", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-launch-")));
  await writeFile(join(root, "sheet.png"), syntheticSheet().png);
  await writeFile(join(root, "profile.json"), JSON.stringify(libraryProfile()));
  const originPath = join(root, "beetle.origin.json");
  await copyFile(join(exampleDir, "beetle.origin.json"), originPath);
  const shown = (await read(guidePath))
    .replace(/\\\n\s*/g, "")
    .split("\n")
    .find((line) => line.startsWith("assetgrove import "));
  for (const part of [
    "--origin beetle.origin.json",
    "--digital-source-type digitalCreation",
    "--frames 16",
    "--no-propose",
  ])
    assert.ok(shown?.includes(part), `the guide's import does not pass ${part}`);
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        cliPath,
        "import",
        "--sheet",
        join(root, "sheet.png"),
        "--profile",
        join(root, "profile.json"),
        "--asset",
        "beetle",
        "--tool",
        "third-party pack",
        "--origin",
        originPath,
        "--digital-source-type",
        "digitalCreation",
        "--frames",
        "16",
        "--no-propose",
        "--imports",
        join(root, "imports"),
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 60000,
        env: { ...process.env, AI_GATEWAY_API_KEY: "" },
      },
    ),
  );
  assert.deepEqual(result.origin, await readJson(originPath));
  assert.equal(
    result.digitalSourceType,
    "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation",
  );
});

test("the guide has the walkthrough's sections, example labels and data destinations", async () => {
  const guide = await read(guidePath);
  const headings = [...guide.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1]!.toLowerCase());
  for (const part of [
    "versioned source",
    "review",
    "provenance",
    "licence records",
    "godot import",
    "routes",
    "where your data goes",
    "disclosure",
    "cannot promise",
  ])
    assert.ok(
      headings.some((heading) => heading.includes(part)),
      `no heading mentions "${part}"`,
    );
  const row = (asset: string): string =>
    guide.split("\n").find((line) => line.startsWith(`| \`${asset}\``)) ?? "";
  assert.match(row("fern"), /\*\*AI-generated\*\*.*hand edit/);
  assert.match(row("mole"), /\*\*Human-made\*\*/);
  assert.match(row("beetle"), /\*\*Third-party\*\*/);
  for (const host of [
    "ai-gateway.vercel.sh",
    "api.openai.com",
    "api.anthropic.com",
    "api.tripo3d.ai",
  ])
    assert.ok(guide.includes(host), `the guide does not name ${host}`);
  assert.match(guide, /loopback/);
  assert.match(guide, /Your own machine/);
});

test("the guide disclaims Godot endorsement and uses no endorsement wording elsewhere", async () => {
  const lines = (await read(guidePath)).split("\n");
  const disclaimers = lines.filter((line) => /not affiliated with/i.test(line));
  assert.equal(disclaimers.length, 1);
  assert.match(disclaimers[0]!, /endorsed by the Godot Engine project/);
  for (const line of lines) {
    if (line === disclaimers[0]) continue;
    assert.doesNotMatch(
      line,
      /official|endorsed|certified|partner|approved by godot/i,
      `endorsement wording: ${line}`,
    );
  }
});

test("the README, the Godot skill and the Godot pack's README link the guide", async () => {
  assert.match(await read(join(repo, "README.md")), /\]\(docs\/launch-guide\.md[)#]/);
  const pack = join(repo, "packages", "assetgrove-godot");
  assert.ok(
    (await read(join(pack, "skills", "assetgrove-godot", "SKILL.md"))).includes(
      "docs/launch-guide.md",
    ),
  );
  assert.match(await read(join(pack, "README.md")), /\]\(\.\.\/\.\.\/docs\/launch-guide\.md[)#]/);
});
