import "./fixtures/env.ts";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { importSheet, readImport, writeFamilies } from "../src/sheet/import.ts";
import { parseCard, rewriteMachineFields, writeCard } from "../src/library/card.ts";
import { readLibrary, rebuildLibrary } from "../src/library/maintain.ts";
import { DIGITAL_SOURCE_TYPES, embedDigitalSourceType } from "../src/metadata.ts";
import { originOf, parseOrigin } from "../src/origin.ts";
import type { OriginRecord } from "../src/origin.ts";
import { libraryProfile } from "./fixtures/library.ts";
import { syntheticSheet } from "./fixtures/sheet.ts";

for (const kind of ["human-made", "third-party", "unknown", "ai-generated"] as const) {
  test(
    kind === "unknown"
      ? "real unclassified intake stays unknown"
      : `real import, family handoff and rebuild retain ${kind} origin evidence`,
    async () => {
      const root = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-origin-")));
      const profile = libraryProfile();
      profile.layout.media =
        "assets/{{spec.assetId}}-{{spec.animationFamily}}.{{output.extension}}";
      profile.layout.manifest = "manifests/{{spec.assetId}}-{{spec.animationFamily}}.json";
      const origin: OriginRecord | undefined =
        kind === "unknown"
          ? undefined
          : {
              kind: kind === "third-party" ? "third-party" : "human-made",
              evidence: "  Synthetic artist's supplied declaration, kept verbatim.\n",
              source: "https://example.test/art/fern",
              license: "Synthetic licence: credit the original artist.",
            };
      const plain = syntheticSheet().png;
      const sheet =
        kind === "ai-generated"
          ? embedDigitalSourceType(plain, "image/png", DIGITAL_SOURCE_TYPES.composite)
          : plain;
      const { record, importDir, grouping } = await importSheet({
        sheet,
        sheetPath: "synthetic.png",
        tool: "synthetic-editor",
        assetId: "fern",
        importsDir: join(root, "imports"),
        profile,
        ...(origin && { origin }),
        ...(kind === "third-party" && {
          digitalSourceType:
            "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture" as const,
        }),
      });
      assert.deepEqual(record.origin, origin);
      assert.deepEqual((await readImport(importDir)).origin, origin);
      assert.equal(originOf(record).kind, kind);
      if (kind === "unknown") {
        assert.equal(record.digitalSourceType, "undeclared");
        return;
      }
      const family = await writeFamilies({
        importDir,
        targetDir: root,
        grouping: {
          ...grouping,
          status: "confirmed",
          families: [{ name: "idle", frames: [1, 2, 3, 4], reason: "synthetic idle" }],
          unassigned: [],
        },
      });
      assert.equal(family.families.length, 1);
      const state = await readLibrary(profile, root);
      assert.equal(state.assets.length, 1);
      const cardPath = state.assets[0]!.cardPath;
      const before = parseCard(await readFile(cardPath, "utf8"), cardPath);
      const expected = {
        ...origin,
        declaredKind: origin?.kind,
        kind,
        digitalSourceType: record.digitalSourceType,
      };
      assert.deepEqual(before.data["origin"], expected);
      await writeFile(
        cardPath,
        writeCard({ ...before, entries: before.entries.filter((entry) => entry.key !== "origin") }),
      );
      const legacy = await readLibrary(profile, root);
      assert.deepEqual(legacy.problems, []);
      assert.deepEqual(legacy.needsRebuild, [
        relative(legacy.config.root, cardPath).split(sep).join("/"),
      ]);
      await rebuildLibrary(legacy);
      assert.deepEqual(
        parseCard(await readFile(cardPath, "utf8"), cardPath).data["origin"],
        expected,
      );
      await writeFile(
        cardPath,
        writeCard(
          rewriteMachineFields(before, { ...before.data, origin: { kind: "unknown" } }, cardPath),
        ),
      );
      await rebuildLibrary(await readLibrary(profile, root));
      const rebuilt = parseCard(await readFile(cardPath, "utf8"), cardPath);
      assert.deepEqual(rebuilt.data["origin"], expected);
      assert.deepEqual((await readLibrary(profile, root)).needsRebuild, []);
    },
  );
}

test("origin input rejects empty evidence and third-party records without their source", () => {
  assert.throws(() => parseOrigin({ kind: "human-made", evidence: " " }), /invalid origin/);
  assert.throws(() => parseOrigin({ kind: "third-party", evidence: "artist grant" }), /source/);
  assert.deepEqual(originOf({}), { kind: "unknown" });
});

test("import CLI reads origin evidence and binds the file bytes into its plan", async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "assetgrove-origin-cli-")));
  await writeFile(join(root, "sheet.png"), syntheticSheet().png);
  await writeFile(join(root, "profile.json"), JSON.stringify(libraryProfile()));
  const record = {
    kind: "third-party",
    evidence: "Original grant text.",
    source: "https://example.test/asset",
    license: "CC-BY-4.0",
  };
  const originPath = join(root, "origin.json");
  await writeFile(originPath, JSON.stringify(record));
  const flags = [
    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
    "import",
    "--sheet",
    join(root, "sheet.png"),
    "--profile",
    join(root, "profile.json"),
    "--asset",
    "fern",
    "--tool",
    "synthetic",
    "--no-propose",
    "--origin",
    originPath,
    "--imports",
    join(root, "imports"),
    "--json",
  ];
  const cli = (extra: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [...flags, ...extra], {
        cwd: root,
        encoding: "utf8",
        timeout: 60000,
        env: { ...process.env, AI_GATEWAY_API_KEY: "" },
      }),
    );
  const first = cli(["--dry-run"]);
  assert.ok(first.inputs.origin);
  await writeFile(originPath, JSON.stringify({ ...record, evidence: "Revised grant text." }));
  const second = cli(["--dry-run"]);
  assert.notEqual(second.inputs.origin, first.inputs.origin);
  assert.notEqual(second.digest, first.digest);
  const imported = cli([]);
  assert.deepEqual(imported.origin, { ...record, evidence: "Revised grant text." });
});
