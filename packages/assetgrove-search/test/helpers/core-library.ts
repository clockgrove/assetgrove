/**
 * A small synthetic asset library for the tests that run core's commands over this package: a
 * profile with a library block and a few cards with drawn images. Nothing here is private.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extensionContext, sampleProfile } from "@clockgrove/assetgrove/testing";

export const GAME = "test-grove";
const LIBRARY_ROOT = "assets";

const { raster } = extensionContext("search-test");

/** A grey blob on a plain background, offset by `dx`. */
export function drawSubject(size: number, dx = 0): ReturnType<typeof raster.create> {
  const r = raster.create(size, size);
  const cx = size / 2 + dx;
  const cy = size * 0.6;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const nx = (x - cx) / (size * 0.3);
      const ny = (y - cy) / (size * 0.22);
      let colour: [number, number, number] = [245, 243, 238];
      if (nx * nx + ny * ny <= 1) colour = ny < -0.4 ? [40, 36, 44] : [96, 100, 110];
      raster.setPixel(r, x, y, [...colour, 255]);
    }
  return r;
}

interface Card {
  id: string;
  folder?: string;
  kind: string;
  subject: string;
  tags: string[];
  title: string;
  description: string;
  size: number;
}

const CARDS: Card[] = [
  {
    id: "lantern",
    kind: "still",
    subject: "lantern",
    tags: ["prop", "light"],
    title: "Porch lantern",
    description: "A brass lantern for the porch, lit.",
    size: 48,
  },
  {
    id: "fern",
    folder: "props",
    kind: "still",
    subject: "fern",
    tags: ["plant"],
    title: "Fern",
    description: "A fern by the path.",
    size: 32,
  },
  {
    id: "walk",
    kind: "sprite-strip",
    subject: "fox",
    tags: ["character"],
    title: "Fox walk",
    description: "A fox walking.",
    size: 40,
  },
];

/** Writes the library into `dir`, a Git project, and commits it. */
export function writeLibrary(dir: string): void {
  const write = (path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const profile = sampleProfile({
    layout: {
      media: `${LIBRARY_ROOT}/{{spec.assetId}}.{{output.extension}}`,
      manifest: "manifests/{{spec.assetId}}.json",
    },
    library: { root: LIBRARY_ROOT, game: GAME },
  });
  write(join(dir, ".assetgrove", "profile.json"), `${JSON.stringify(profile, null, 2)}\n`);
  CARDS.forEach((c, i) => {
    const folder = join(dir, LIBRARY_ROOT, c.folder ?? "");
    write(join(folder, `${c.id}.png`), raster.encodePng(drawSubject(c.size, i)));
    write(
      join(folder, `${c.id}.md`),
      [
        "---",
        "type: Game Asset",
        "format: assetgrove-card/1",
        `title: ${c.title}`,
        `description: ${c.description}`,
        `resource: ${c.id}.png`,
        "tags:",
        ...c.tags.map((t) => `  - ${t}`),
        `kind: ${c.kind}`,
        `subject: ${c.subject}`,
        "state: pending",
        "---",
        "",
      ].join("\n"),
    );
  });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("add", "-A");
  git("commit", "--quiet", "-m", "a synthetic library");
}
