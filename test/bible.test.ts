import "./fixtures/env.ts";
import { approve } from "./fixtures/env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BIBLE_PRESETS,
  biblePalette,
  describeBible,
  doDontSection,
  loadBible,
  loadDesignColors,
  parseBible,
  projectRoot,
  requireInsideProject,
  serializeBible,
  validateBible,
  validateTokens,
  useBiblePreset,
} from "../src/bible.ts";
import { writeProjectFiles, type InitFile } from "../src/init.ts";
import { imageGenerators } from "../src/generators/image.ts";
import { stage } from "../src/loop.ts";
import { defaultRoutes } from "../src/routes.ts";
import type { AssetSpec, StyleBible } from "../src/types.ts";
import { scriptedProvider, shelterSpec, syntheticWorld } from "./fixtures/synthetic.ts";

function base() {
  const data = structuredClone(BIBLE_PRESETS["cozy-storybook"]!);
  data.referenceLicense = "NOASSERTION";
  return data;
}

function initFiles(options: { directory: string; world: string; stylePreset: string }) {
  return writeProjectFiles({ ...options, profilePreset: "sprite-32" });
}

function pathsOf(files: InitFile[]) {
  const of = (role: InitFile["role"]) => files.filter((f) => f.role === role).map((f) => f.path);
  return {
    biblePath: of("bible")[0] as string,
    templatePath: of("template")[0] as string,
    skillPaths: of("skill"),
  };
}

test("bible initializes all three repository-owned preset constitutions and skill links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bible-"));
  try {
    const renderings = new Set<string>();
    for (const preset of Object.keys(BIBLE_PRESETS)) {
      const root = join(directory, preset);
      const files = await initFiles({
        directory: root,
        world: "Synthetic world",
        stylePreset: preset,
      });
      const paths = pathsOf(files);
      const document = await loadBible(paths.biblePath);
      renderings.add(document.data.axes.rendering);
      assert.equal(document.data.preset, preset);
      assert.equal(document.data.world, "Synthetic world");
      assert.equal(document.hash.length, 64);
      assert.deepEqual(biblePalette(document.data), ["#292433", "#c49b70", "#7c93a8"]);
      assert.deepEqual(
        paths.skillPaths.map((p) => relative(root, p).split(sep).join("/")),
        [".claude/skills/art-direction/SKILL.md", ".agents/skills/art-direction/SKILL.md"],
      );
      for (const skillPath of paths.skillPaths)
        assert.match(
          await readFile(skillPath, "utf8"),
          /generating or reviewing art for Synthetic world/,
        );
      assert.match(await readFile(paths.templatePath, "utf8"), /\{\{constitution\}\}/);
      assert.match(
        await readFile(join(document.dir, "presets/flat-cartoon-kids.md"), "utf8"),
        /flat-cartoon/,
      );
      const described = await describeBible(paths.biblePath);
      assert.deepEqual(described.presets, Object.keys(BIBLE_PRESETS));
      assert.match(described.doDont, /positive anchors/);
      await assert.rejects(
        initFiles({ directory: root, world: "Other", stylePreset: preset }),
        /overwrite/,
      );
      assert.equal((await loadBible(paths.biblePath)).data.world, "Synthetic world");
    }
    assert.equal(renderings.size, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Markdown YAML retains unknown front matter and prose including Do's and Don'ts", () => {
  const data = base();
  data["future"] = { field: ["keep", "these"] };
  data.anchors.negative.push({ path: "anchors/avoid.png", role: "negative" });
  const prose =
    "# Rationale\n\nUnknown prose stays.\n\n## Do's and Don'ts\n\nDon't use [this image](anchors/avoid.png).\n\n## Future section\n\nKeep me.\n";
  const parsed = parseBible(serializeBible(data, prose));
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.prose, prose);
  assert.equal(doDontSection(prose), "Don't use [this image](anchors/avoid.png).");
  assert.throws(() => parseBible(serializeBible(data, "# No constraints")), /Do's and Don'ts/);
  assert.throws(() => parseBible("{}"), /YAML front matter/);
});

test("bible validates required axes, ordered bounds, audience, anchors and approved identity locks", () => {
  const invalid = [
    (b: ReturnType<typeof base>) => {
      b.axes.rendering = "oil" as never;
    },
    (b: ReturnType<typeof base>) => {
      b.tokens["saturation"] = {
        min: { $type: "number", $value: 0.8 },
        max: { $type: "number", $value: 0.2 },
      };
    },
    (b: ReturnType<typeof base>) => {
      b.tone.audience = "adult" as never;
    },
    (b: ReturnType<typeof base>) => {
      b.adjustable.mood = ["grim"];
    },
    (b: ReturnType<typeof base>) => {
      b.anchors.negative = [{ path: "", role: "negative" }];
    },
    (b: ReturnType<typeof base>) => {
      b.tokens["light"] = { $type: "duration", $value: { value: 1, unit: "s" } };
    },
    (b: ReturnType<typeof base>) => {
      b.tokens["fog"] = { colour: b.tokens["light"], density: { $type: "number", $value: 1.1 } };
    },
    (b: ReturnType<typeof base>) => {
      b.identities["synthetic"] = {
        version: "1",
        approved: false as never,
        turnaround: "approved.png",
        signatureFeatures: ["long ears"],
        proportions: "small body",
        palette: ["#292433"],
      };
    },
  ];
  for (const mutate of invalid) {
    const b = base();
    mutate(b);
    assert.throws(() => validateBible(b));
  }
  const valid = base();
  valid.identities["synthetic"] = {
    version: "2",
    approved: true,
    turnaround: "approved.png",
    signatureFeatures: ["long ears"],
    proportions: "small body",
    palette: ["#292433"],
  };
  assert.deepEqual(validateBible(valid).identities["synthetic"], valid.identities["synthetic"]);
});

test("DTCG checks typed values, inherited types and aliases, duration and easing", () => {
  validateTokens({
    group: { $type: "number", a: { $value: 1 }, b: { $value: "{group.a}" } },
    time: { $type: "duration", $value: { value: 250, unit: "ms" } },
    easing: { $type: "cubicBezier", $value: [0.2, -1, 0.8, 2] },
  });
  for (const input of [
    { a: { $type: "number", $value: "not a number" } },
    { a: { $type: "color", $value: "#ffffff" } },
    { a: { $type: "color", $value: { colorSpace: "srgb", components: [1, 0, 3] } } },
    { a: { $type: "number", $value: "{b}" }, b: { $type: "number", $value: "{a}" } },
    { a: { $type: "number", $value: "{missing}" } },
    { a: { $type: "cubicBezier", $value: [-1, 0, 0, 1] } },
    { a: { $type: "duration", $value: { value: 1, unit: "seconds" } } },
  ])
    assert.throws(() => validateTokens(input));
});

test("DESIGN.md colors load whatever the asset is, are UI context only and cannot mutate bible palette", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bible-design-"));
  try {
    await writeFile(
      join(directory, "DESIGN.md"),
      "---\ncolors:\n  accent: '#aabbcc'\n---\n# UI tokens\n",
    );
    assert.deepEqual(await loadDesignColors(directory), { accent: "#aabbcc" });
    await writeFile(
      join(directory, "DESIGN.md"),
      "# UI tokens\n\n```yaml\ncolors:\n  accent: oklch(60% 0.2 40)\n  subtle: '{colors.accent}'\ncomponents:\n  secret: ignored\n```\n",
    );
    assert.deepEqual(await loadDesignColors(directory), {
      accent: "oklch(60% 0.2 40)",
      subtle: "{colors.accent}",
    });
    assert.deepEqual(biblePalette(base()), ["#292433", "#c49b70", "#7c93a8"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DTCG aliases infer referenced type before enclosing group type", () => {
  validateTokens({
    base: { $type: "number", $value: 1 },
    alias: { $value: "{base}" },
    conflicting: { $type: "color", alias: { $value: "{base}" } },
  });
  const bible = base();
  bible.tokens["light"] = { $value: "{palette.warm}" };
  bible.tokens["palette"] = { $type: "number", ink: { $value: "{light}" } };
  bible.tokens["light"] = { $value: "{rim}" };
  assert.deepEqual(biblePalette(validateBible(bible)), ["#a6c4e8"]);
  assert.throws(
    () =>
      validateTokens({
        base: { $type: "number", $value: 1 },
        alias: { $type: "color", $value: "{base}" },
      }),
    /different type/,
  );
});

test("missing bible is invalid input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "missing-bible-"));
  try {
    await assert.rejects(loadBible(join(directory, "missing.md")), { name: "InputError" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("outline and ranges use DTCG tokens and brief bounds cannot exceed the constitution", () => {
  const bible = base();
  assert.equal(bible.axes.outline.colour, "{outline}");
  assert.deepEqual(bible.tokens["saturation"], {
    min: { $type: "number", $value: 0.2 },
    max: { $type: "number", $value: 0.8 },
  });
  const literal = base();
  literal.axes.outline.colour = "#ffffff";
  assert.throws(() => validateBible(literal), /reference a DTCG/);
  for (const key of [
    "audience",
    "tone",
    "palette",
    "colorRule",
    "identity",
    "identities",
    "contentLimits",
    "rendering",
    "proportions",
    "signatureFeatures",
    "turnaround",
  ]) {
    const invalid = base();
    invalid.adjustable[key] = ["override"];
    assert.throws(() => validateBible(invalid), /cannot override the constitution/);
  }
  const invalid = base();
  invalid.adjustable["saturation"] = { min: 0, max: 1 };
  assert.throws(() => validateBible(invalid), /exceeds constitutional/);
  const valid = base();
  valid.adjustable["saturation"] = { min: 0.3, max: 0.6 };
  assert.doesNotThrow(() => validateBible(valid));
});

test("switch target-owned presets preserves world palette, locks, anchors and unknown prose", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bible-switch-"));
  try {
    const paths = pathsOf(
      await initFiles({
        directory,
        world: "Synthetic world",
        stylePreset: "cozy-storybook",
      }),
    );
    const document = await loadBible(paths.biblePath);
    document.data.identities["synthetic"] = {
      version: "2",
      approved: true,
      turnaround: "identity.png",
      signatureFeatures: ["long ears"],
      proportions: "small body",
      palette: ["#292433"],
    };
    document.data.anchors.positive = [{ path: "positive.png", role: "style" }];
    document.data.anchors.negative = [{ path: "negative.png", role: "avoid" }];
    document.data["future"] = { keep: true };
    document.data.referenceLicense = "NOASSERTION";
    document.data.tokens["palette"] = {
      ink: { $type: "color", $value: { colorSpace: "srgb", components: [0, 0, 0] } },
    };
    document.data.colorRule = "palette";
    const prose = document.prose + "\n## Unknown future notes\n\nPreserve these notes.\n";
    await writeFile(paths.biblePath, serializeBible(document.data, prose));
    const previous = await loadBible(paths.biblePath);
    const described = await useBiblePreset({
      biblePath: paths.biblePath,
      preset: "flat-cartoon-kids",
    });
    const switched = await loadBible(paths.biblePath);
    assert.equal(described.preset, "flat-cartoon-kids");
    assert.equal(switched.data.axes.rendering, "flat-cartoon");
    assert.equal(switched.data.tone.audience, "young-kids");
    assert.notEqual(switched.hash, previous.hash);
    assert.deepEqual(switched.data.identities, previous.data.identities);
    assert.deepEqual(switched.data.anchors, previous.data.anchors);
    assert.deepEqual(switched.data.tokens["palette"], previous.data.tokens["palette"]);
    assert.deepEqual(switched.data["future"], { keep: true });
    assert.equal(switched.data.colorRule, "palette");
    assert.equal(switched.data.world, "Synthetic world");
    assert.equal(switched.prose, prose);
    assert.deepEqual(
      switched.data.tokens["light"],
      BIBLE_PRESETS["flat-cartoon-kids"]!.tokens["light"],
    );
    await assert.rejects(useBiblePreset({ biblePath: paths.biblePath, preset: "missing-preset" }), {
      name: "InputError",
    });
    await assert.rejects(useBiblePreset({ biblePath: paths.biblePath, preset: "../escape" }), {
      name: "InputError",
    });
    assert.equal((await loadBible(paths.biblePath)).hash, switched.hash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// --- Reference licences and the project root (issue #167) ---

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const exec = promisify(execFile);

async function cli(...args: string[]): Promise<{ code: number; doc: Record<string, unknown> }> {
  try {
    const { stdout } = await exec(process.execPath, [CLI, ...args, "--json"]);
    return { code: 0, doc: JSON.parse(stdout) };
  } catch (error) {
    const e = error as { code: number; stdout: string };
    return { code: e.code, doc: JSON.parse(e.stdout) };
  }
}

const errorOf = (run: { doc: Record<string, unknown> }) =>
  run.doc["error"] as { code: string; message: string };

/** A synthetic world written to disk: spec, JSON bible and profile beside it. */
async function worldFiles(bible: Partial<StyleBible> = {}) {
  const world = await syntheticWorld();
  const files = {
    spec: join(world.dir, "spec.json"),
    bible: join(world.bibleDir, "bible.json"),
    profile: join(world.dir, "profile.json"),
  };
  await writeFile(files.spec, JSON.stringify(shelterSpec));
  await writeFile(files.bible, JSON.stringify({ ...world.bible, ...bible }));
  await writeFile(files.profile, JSON.stringify(world.profile));
  return { world, files };
}

/** A provider script that records every call in `marker`, to prove none was made. */
async function recordingProvider(dir: string, marker: string): Promise<string> {
  const path = join(dir, "recording-provider.mjs");
  const record = `() => { appendFileSync(${JSON.stringify(marker)}, "call\\n"); throw new Error("called"); }`;
  await writeFile(
    path,
    `import { appendFileSync } from "node:fs";\nexport default { image: ${record}, vision: ${record} };\n`,
  );
  return path;
}

test("a bible with references and no referenceLicense exits 2", async (t) => {
  // The JSON bible a stage reads.
  const { world, files } = await worldFiles();
  t.after(() => rm(world.dir, { recursive: true, force: true }));
  const { referenceLicense: _dropped, ...unlicensed } = world.bible;
  void _dropped;
  await writeFile(files.bible, JSON.stringify(unlicensed));
  const stageArgs = ["--spec", files.spec, "--bible", files.bible, "--profile", files.profile];
  const run = await cli("stage", ...stageArgs, "--runs", world.runsDir, "--dry-run");
  assert.equal(run.code, 2);
  assert.equal(errorOf(run).code, "invalid_input");
  assert.match(errorOf(run).message, /referenceLicense/);
  // Without references, no licence is needed.
  await writeFile(
    files.bible,
    JSON.stringify({ ...unlicensed, references: [], perspective: "refs/perspective.png" }),
  );
  assert.equal((await cli("stage", ...stageArgs, "--runs", world.runsDir, "--dry-run")).code, 0);

  // BIBLE.md front matter: anchors are references.
  const data = base();
  data.anchors.positive.push({ path: "anchors/style.png", role: "style" });
  const biblePath = join(world.dir, "BIBLE.md");
  await writeFile(
    biblePath,
    serializeBible(data, "## Do's and Don'ts\n\nDo.\n").replace(/^referenceLicense: .*\n/m, ""),
  );
  const described = await cli("bible", "describe", "--bible", biblePath);
  assert.equal(described.code, 2);
  assert.equal(errorOf(described).code, "invalid_input");
  assert.match(errorOf(described).message, /referenceLicense/);
});

test("a per-reference license is recorded in provenance, the others under referenceLicense", async (t) => {
  const world = await syntheticWorld();
  t.after(() => rm(world.dir, { recursive: true, force: true }));
  const bible: StyleBible = {
    ...world.bible,
    referenceLicense: "LicenseRef-synthetic-studio",
    references: world.bible.references.map((reference) =>
      reference.path === "refs/fern-sheet.png" ? { ...reference, license: "CC-BY-4.0" } : reference,
    ),
  };
  const spec: AssetSpec = {
    kind: "still",
    assetId: "fern",
    animationFamily: "shelter",
    frames: { width: 96, height: 96 },
  };
  const { run } = await stage({
    spec,
    specDir: world.dir,
    bible,
    bibleDir: world.bibleDir,
    profile: world.profile,
    routes: defaultRoutes,
    provider: scriptedProvider(),
    providerName: "scripted",
    generators: imageGenerators,
    runsDir: world.runsDir,
    candidates: 1,
  });
  const provenance = run.candidates[0]!.provenance;
  assert.deepEqual(
    provenance.referenceLicenses,
    bible.references.map((reference) => ({
      path: reference.path,
      role: reference.role,
      license:
        reference.path === "refs/fern-sheet.png" ? "CC-BY-4.0" : "LicenseRef-synthetic-studio",
    })),
  );
});

test("a spec's key pose outside the project root exits 2 invalid_input before any provider call", async (t) => {
  const { world, files } = await worldFiles();
  t.after(() => rm(world.dir, { recursive: true, force: true }));
  await mkdir(join(world.dir, ".git"));
  const outside = await mkdtemp(join(tmpdir(), "assetgrove-private-pose-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const secret = join(outside, "private.png");
  await writeFile(secret, await readFile(join(world.dir, "key-pose.png")));
  const marker = join(world.dir, "provider-calls.log");
  const provider = await recordingProvider(world.dir, marker);
  approve(provider);
  for (const keyPose of [secret, relative(world.dir, secret)]) {
    await writeFile(files.spec, JSON.stringify({ ...shelterSpec, keyPose }));
    const run = await cli(
      "stage",
      ...["--spec", files.spec, "--bible", files.bible, "--profile", files.profile],
      ...["--runs", world.runsDir, "--provider-script", provider],
    );
    assert.equal(run.code, 2, `${keyPose}: ${JSON.stringify(run.doc)}`);
    assert.equal(errorOf(run).code, "invalid_input");
    assert.match(errorOf(run).message, /keyPose: reference .* resolves outside the project root/);
  }
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("a reference path outside the project root exits 2 invalid_input before any provider call", async (t) => {
  const { world, files } = await worldFiles();
  t.after(() => rm(world.dir, { recursive: true, force: true }));
  // The project is the world directory (it holds .git); a private file sits outside it.
  await mkdir(join(world.dir, ".git"));
  const outside = await mkdtemp(join(tmpdir(), "assetgrove-private-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const secret = join(outside, "secret.png");
  await writeFile(secret, await readFile(join(world.bibleDir, "refs/den.png")));
  const marker = join(world.dir, "provider-calls.log");
  const provider = await recordingProvider(world.dir, marker);
  const stageArgs = ["--spec", files.spec, "--bible", files.bible, "--profile", files.profile];
  const escapes = [
    relative(world.bibleDir, secret),
    secret,
    "refs/link.png", // a link inside the project that points outside it
  ];
  await symlink(secret, join(world.bibleDir, "refs/link.png"));
  for (const path of escapes) {
    await writeFile(
      files.bible,
      JSON.stringify({
        ...world.bible,
        references: [...world.bible.references, { path, role: "prop", subject: "fern" }],
      }),
    );
    const run = await cli(
      "stage",
      ...stageArgs,
      "--runs",
      world.runsDir,
      "--provider-script",
      provider,
    );
    assert.equal(run.code, 2, `${path}: ${JSON.stringify(run.doc)}`);
    assert.equal(errorOf(run).code, "invalid_input");
    assert.match(errorOf(run).message, /outside the project root/);
  }
  await assert.rejects(readFile(marker), { code: "ENOENT" });

  // A BIBLE.md anchor that leaves the project is refused the same way.
  const data = base();
  data.anchors.positive.push({ path: relative(world.dir, secret), role: "style" });
  const biblePath = join(world.dir, "BIBLE.md");
  await writeFile(biblePath, serializeBible(data, "## Do's and Don'ts\n\nDo.\n"));
  const described = await cli("bible", "describe", "--bible", biblePath);
  assert.equal(described.code, 2);
  assert.equal(errorOf(described).code, "invalid_input");
  assert.match(errorOf(described).message, /outside the project root/);
  // Inside the project it loads.
  data.anchors.positive = [{ path: "bible/refs/den.png", role: "style" }];
  await writeFile(biblePath, serializeBible(data, "## Do's and Don'ts\n\nDo.\n"));
  assert.equal((await cli("bible", "describe", "--bible", biblePath)).code, 0);
});

test("the project root stops below the home directory and falls back to the shared file's directory", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "assetgrove-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  // A dotfiles repository at the home directory does not make the home directory the project.
  await mkdir(join(home, ".git"));
  const art = join(home, "work", "art");
  await mkdir(join(home, "work", "refs"), { recursive: true });
  await mkdir(art, { recursive: true });
  // No marker below the home directory: the root is the bible's own directory.
  assert.equal(projectRoot(art, home), await realpath(art));
  assert.throws(
    () => requireInsideProject(["../refs/x.png"], art, "bible.json", home),
    /outside the project root/,
  );
  assert.throws(
    () => requireInsideProject([join(home, ".ssh", "id.png")], art, "bible.json", home),
    /outside the project root/,
  );
  // With a project marker above the bible, a sibling reference inside the project loads.
  await mkdir(join(home, "work", ".assetgrove"));
  assert.doesNotThrow(() => requireInsideProject(["../refs/x.png"], art, "bible.json", home));
  assert.match(projectRoot(art, home), /work$/);
});
