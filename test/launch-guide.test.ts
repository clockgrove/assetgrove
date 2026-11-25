import "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir as mkdirP, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseOrigin } from "../src/origin.ts";
import { createRaster, encodePng } from "../src/image/raster.ts";
import { asepriteFile } from "../src/testing/aseprite.ts";

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

/** The guide's shell lines, continuations joined, each split into words (double quotes kept together). */
function guideLines(guide: string): string[][] {
  const lines: string[][] = [];
  for (const block of guide.matchAll(/```sh\n([\s\S]*?)```/g))
    for (const line of block[1]!.replace(/\\\n\s*/g, " ").split("\n"))
      if (line.trim() !== "")
        lines.push([...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!));
  return lines;
}

/** The guide's one line that starts with these words. */
function guideLine(lines: string[][], ...words: string[]): string[] {
  const found = lines.filter((line) => words.every((word, i) => line[i] === word));
  assert.equal(found.length, 1, `the guide has ${found.length} \`${words.join(" ")}\` lines`);
  return found[0]!;
}

const flag = (line: string[], name: string): string => {
  const at = line.indexOf(name);
  assert.ok(at >= 0 && line[at + 1] !== undefined, `the guide's ${line[1]} passes no ${name}`);
  return line[at + 1]!;
};

/** A clean contact sheet: `count` separate figures on a plain background, nothing between them. */
function cleanSheet(count: number): Uint8Array {
  const raster = createRaster(64 * count, 64);
  for (let i = 0; i < raster.data.length; i += 4) raster.data.set([255, 255, 255, 255], i);
  for (let cell = 0; cell < count; cell++)
    for (let y = 30; y < 54; y++)
      for (let x = 22 + 64 * cell; x < 42 + 64 * cell; x++)
        raster.data.set([40, 50, 60, 255], (y * raster.width + x) * 4);
  return encodePng(raster);
}

/** A person's 32 x 32 Aseprite file with a `walk` tag over four frames, as the guide's mole. */
function moleAseprite(): Uint8Array {
  const frames = Array.from({ length: 4 }, (_, f) => {
    const rgba = new Uint8Array(32 * 32 * 4);
    for (let y = 8 + (f % 2); y < 28; y++)
      for (let x = 8 + f; x < 20 + f; x++) rgba.set([110, 80, 60, 255], (y * 32 + x) * 4);
    return { durationMs: 125, cels: [{ layer: 0, x: 0, y: 0, width: 32, height: 32, rgba }] };
  });
  return asepriteFile({
    width: 32,
    height: 32,
    layers: [{ name: "body" }],
    frames,
    tags: [{ name: "walk", from: 0, to: 3 }],
  });
}

test("the guide's own steps run offline: init, the fragment, the LFS step, stage-source, pick and import", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-launch-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet");
  const lines = guideLines(await read(guidePath));
  const cli = (line: string[], replace: Record<string, string> = {}) => {
    const args = line.slice(1).map((word) => replace[word] ?? word);
    const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
      env: { ...process.env, AI_GATEWAY_API_KEY: "" },
    });
    assert.equal(result.status, 0, `${line.join(" ")}\n${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };

  cli(guideLine(lines, "assetgrove", "init"));
  // The merge the guide describes: each top-level field of the fragment over init's profile.
  const profilePath = join(root, ".assetgrove", "profile.json");
  const fragment = await readJson(join(exampleDir, "profile-fragment.json"));
  const profile = { ...(await readJson(profilePath)), ...fragment } as Record<string, unknown> & {
    handoff: Array<{ preset: string }>;
  };
  // This repository's tests load no pack, so this follows the guide's run without it.
  profile.handoff = profile.handoff.filter((entry) => !entry.preset.startsWith("godot:"));
  await writeFile(profilePath, JSON.stringify(profile, null, 2));
  // The guide's LFS step, as its mkdir and mv lines say.
  const mkdir = guideLine(lines, "mkdir", "-p");
  await mkdirP(join(root, mkdir[2]!), { recursive: true });
  const mv = guideLine(lines, "mv");
  await rename(join(root, mv[1]!), join(root, mv[2]!));
  // The guide sets the pack up before the first pick, since the fragment's hand-off needs it.
  const guide = await read(guidePath);
  assert.ok(guide.indexOf("extensions setup godot") < guide.indexOf("assetgrove pick "));

  for (const file of ["mole-walk.json", "beetle.origin.json"])
    await copyFile(join(exampleDir, file), join(root, file));
  const stageLine = guideLine(lines, "assetgrove", "stage-source");
  const source = flag(stageLine, "--source");
  await mkdirP(dirname(join(root, source)), { recursive: true });
  await writeFile(join(root, source), moleAseprite());
  const staged = cli(stageLine);
  const run = relative(join(root, ".assetgrove", "runs"), String(staged["runDir"]));
  const picks = lines.filter((line) => line[1] === "pick");
  assert.ok(picks.length >= 1);
  cli(picks.at(-1)!, { ".assetgrove/runs/<run>": `.assetgrove/runs/${run}` });
  assert.equal(
    git("check-attr", "filter", "game/assets/mole/walk.png").trim().split(": ")[2],
    "lfs",
  );
  const card = guideLine(lines, "assetgrove", "approve")[2]!;
  assert.ok(existsSync(join(root, card)), `${card}, which the guide reviews, was not written`);
  const manifest = (await readJson(join(root, "assets", "manifests", "mole", "walk.json"))) as {
    source: Record<string, unknown>;
  };
  assert.equal(
    manifest.source["digitalSourceType"],
    "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation",
  );
  assert.equal(manifest.source["kind"], undefined);
  assert.doesNotMatch(JSON.stringify(manifest.source), /generated|assetgrove/);

  const importLine = guideLine(lines, "assetgrove", "import");
  const sheet = flag(importLine, "--sheet");
  await mkdirP(dirname(join(root, sheet)), { recursive: true });
  await writeFile(join(root, sheet), cleanSheet(Number(flag(importLine, "--frames"))));
  const imported = cli(importLine);
  assert.deepEqual(imported["origin"], await readJson(join(root, "beetle.origin.json")));
  assert.equal(
    imported["digitalSourceType"],
    "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation",
  );
  assert.deepEqual(imported["calls"], [], "a clean sheet with --no-propose made a call");
  // The grouping a person writes and confirms by hand, then the guide's write-families.
  const importDir = String(imported["importDir"]);
  await writeFile(
    join(importDir, "grouping.json"),
    JSON.stringify({
      status: "confirmed",
      families: [
        {
          name: "idle",
          frames: Array.from({ length: 16 }, (_, i) => i + 1),
          reason: "the supplier's idle loop",
          template: "none",
        },
      ],
    }),
  );
  cli(guideLine(lines, "assetgrove", "write-families"), {
    ".assetgrove/imports/<import>": relative(root, importDir),
  });
  const beetle = (await readJson(join(root, "assets", "manifests", "beetle", "idle.json"))) as {
    source: Record<string, unknown>;
  };
  assert.equal(
    beetle.source["digitalSourceType"],
    "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation",
  );
  assert.deepEqual(beetle.source["origin"], await readJson(join(root, "beetle.origin.json")));
  assert.doesNotMatch(JSON.stringify(beetle.source), /generated|"tool"/);
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
