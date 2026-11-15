import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InputError } from "../src/errors.ts";
import {
  checkIndexPaths,
  escapeText,
  logEntriesFromReview,
  normalizeLog,
  parseIndex,
  renderIndex,
  renderLog,
  type IndexAsset,
  type LogEntry,
} from "../src/library/folder.ts";
import {
  appendAnnotation,
  appendVersion,
  emptyReview,
  type AnnotationInput,
} from "../src/library/review.ts";

const FOLDERS = ["props", "characters", "ui"];
const ASSETS: IndexAsset[] = [
  {
    id: "lantern-porch",
    title: "Porch lantern",
    description: "A brass lantern for the porch, lit.",
  },
  { id: "door", title: "Door" },
  { id: "key", title: "Key", description: "Old." },
  { id: "bench", title: "Bench" },
];

function orders<T>(items: T[]): T[][] {
  const rotations = items.map((_, i) => [...items.slice(i), ...items.slice(0, i)]);
  return [...rotations, [...items].reverse()];
}

test("an index renders identically from every input order", () => {
  for (const root of [undefined, { game: "my-game" }]) {
    const expected = renderIndex({
      name: "x",
      ...(root ? { root } : {}),
      folders: FOLDERS,
      assets: ASSETS,
    });
    for (const folders of orders(FOLDERS)) {
      for (const assets of orders(ASSETS)) {
        const input = { name: "x", ...(root ? { root } : {}), folders, assets };
        assert.equal(renderIndex(input), expected);
      }
    }
  }
  const text = renderIndex({
    name: "my game",
    root: { game: "my game" },
    folders: FOLDERS,
    assets: ASSETS,
  });
  assert.equal(
    text,
    [
      "---",
      "okf_version: 0.2",
      "type: Asset Library",
      'game: "my game"',
      "---",
      "",
      "# my game",
      "",
      "## Folders",
      "",
      "- [characters/](characters/index.md)",
      "- [props/](props/index.md)",
      "- [ui/](ui/index.md)",
      "",
      "## Assets",
      "",
      "- [Bench](bench.md)",
      "- [Door](door.md)",
      "- [Key](key.md): Old.",
      "- [Porch lantern](lantern-porch.md): A brass lantern for the porch, lit.",
      "",
    ].join("\n"),
  );
  assert.equal(renderIndex({ name: "props", folders: [], assets: [] }), "# props\n");
  assert.throws(
    () =>
      renderIndex({
        name: "p",
        folders: [],
        assets: [
          { id: "a", title: "A" },
          { id: "a", title: "B" },
        ],
      }),
    InputError,
  );
  assert.throws(() => renderIndex({ name: "p", folders: ["a/b"], assets: [] }), InputError);
  assert.throws(
    () => renderIndex({ name: "p", folders: [], assets: [{ id: "..", title: "A" }] }),
    InputError,
  );
});

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const ASSET = { id: "lantern-porch", title: "Porch lantern" };

const ENTRIES: LogEntry[] = [
  { at: "2026-11-22T09:00:00Z", action: "pick", asset: ASSET, detail: "version 2" },
  { at: "2026-11-22T08:10:00Z", action: "bible", from: "2", to: "3" },
  { at: "2026-11-22T08:10:00Z", action: "approve", asset: ASSET },
  { at: "2026-11-20T23:59:59Z", action: "reject", asset: ASSET, detail: "too dark" },
  { at: "2026-11-20T10:00:00Z", action: "adopt", asset: { id: "door", title: "Door" } },
];

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

test("a log renders newest first and identically from every order", () => {
  const expected = renderLog(ENTRIES);
  assert.equal(
    expected,
    [
      "# Log",
      "",
      "## 2026-11-22",
      "",
      "- 09:00:00Z pick [Porch lantern](lantern-porch.md): version 2",
      "- 08:10:00Z bible 2 → 3",
      "- 08:10:00Z approve [Porch lantern](lantern-porch.md)",
      "",
      "## 2026-11-20",
      "",
      "- 23:59:59Z reject [Porch lantern](lantern-porch.md): too dark",
      "- 10:00:00Z adopt [Door](door.md)",
      "",
    ].join("\n"),
  );
  for (const order of permutations(ENTRIES)) assert.equal(renderLog(order), expected);
  assert.equal(renderLog([]), "# Log\n");
  assert.throws(
    () => renderLog([{ at: "2026-11-22 09:00", action: "pick", asset: ASSET }]),
    InputError,
  );
});

test("log entries from a review record do not depend on append order", () => {
  const pick: AnnotationInput = {
    type: "Annotation",
    motivation: "moderating",
    created: "2026-11-22T09:00:00Z",
    target: { source: "lantern-porch.png", "ag:version": SHA_B },
    "ag:action": "pick",
  };
  const approve: AnnotationInput = {
    type: "Annotation",
    motivation: "assessing",
    created: "2026-11-22T09:30:00Z",
    body: { type: "TextualBody", value: "looks good" },
    target: { source: "lantern-porch.png", "ag:version": SHA_B },
    "ag:action": "approve",
  };
  const replace: AnnotationInput = {
    ...pick,
    created: "2026-11-22T09:10:00Z",
    body: [{ type: "TextualBody", value: "warmer" }],
    "ag:action": "replace",
  };
  const resolve: AnnotationInput = {
    type: "Annotation",
    motivation: "moderating",
    created: "2026-11-22T09:40:00Z",
    target: "lantern-porch.png",
    "ag:action": "resolve",
    "ag:resolves": "#0123456789abcdef",
  };
  const render = (order: AnnotationInput[]): string => {
    let record = emptyReview("asset://my-game/lantern-porch/review");
    record = appendVersion(record, { sha256: SHA_A, at: "2026-11-22T08:00:00Z" });
    record = appendVersion(record, { sha256: SHA_B, at: "2026-11-22T09:00:00Z" });
    for (const annotation of order) record = appendAnnotation(record, annotation);
    return renderLog(logEntriesFromReview(record, ASSET));
  };
  const expected = render([pick, replace, approve, resolve]);
  for (const order of permutations([pick, replace, approve, resolve])) {
    assert.equal(render(order), expected);
  }
  assert.match(
    expected,
    /- 09:10:00Z replace \[Porch lantern\]\(lantern-porch\.md\): version 2; warmer\n/,
  );
  assert.match(
    expected,
    /- 09:30:00Z approve \[Porch lantern\]\(lantern-porch\.md\): looks good\n/,
  );
  assert.doesNotMatch(expected, /resolve/);
});

test("hostile titles render escaped and forge no link", () => {
  const titles = ["Evil](http://x.example)[x", "a|b", "line1\nline2", "back\\slash"];
  const assets = titles.map((title, i) => ({ id: `asset-${i}`, title, description: title }));
  const text = renderIndex({ name: "props", folders: [], assets });
  const rows = text.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(rows.length, 4);
  for (const row of rows) {
    const links =
      row
        .split("\\\\")
        .join("")
        .match(/(?<!\\)\]\(/g) ?? [];
    assert.equal(links.length, 1, row);
  }
  const parsed = parseIndex(text, "index.md");
  assert.deepEqual(
    parsed.assets.map((a) => [a.id, a.target, a.title, a.description]),
    titles.map((title, i) => {
      const folded = title.replace(/\n/g, " ");
      return [`asset-${i}`, `asset-${i}.md`, folded, folded];
    }),
  );
  assert.equal(escapeText("a\r\nb\n\nc"), "a b c");
  const log = renderLog([
    {
      at: "2026-11-22T09:00:00Z",
      action: "pick",
      asset: { id: "x", title: titles[0]! },
      detail: titles[0]!,
    },
  ]);
  assert.equal(log.match(/(?<!\\)\]\(/g)?.length, 1);
});

test("union-merged indexes and logs collapse their duplicates", () => {
  const one = renderIndex({ name: "props", folders: ["a"], assets: [{ id: "x", title: "X" }] });
  const two = renderIndex({ name: "props", folders: ["b"], assets: [{ id: "y", title: "Y" }] });
  const merged = parseIndex(`${one}${two}${one}`, "index.md");
  assert.deepEqual(merged.folders, ["a", "b"]);
  assert.deepEqual(
    merged.assets.map((a) => a.id),
    ["x", "y"],
  );
  const root = parseIndex(
    renderIndex({ name: "g", root: { game: "g" }, folders: [], assets: [] }),
    "i",
  );
  assert.deepEqual(root.root, { okfVersion: "0.2", game: "g" });

  const a: LogEntry = { at: "2026-11-22T09:00:00Z", action: "pick", asset: ASSET };
  const b: LogEntry = { at: "2026-11-22T10:00:00Z", action: "approve", asset: ASSET };
  const c: LogEntry = { at: "2026-11-21T10:00:00Z", action: "reject", asset: ASSET };
  const left = renderLog([a, c]);
  const right = renderLog([a, b]);
  assert.equal(normalizeLog(`${left}${right}`), renderLog([a, b, c]));
});

test("an index row that leaves the library root is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "folder-"));
  try {
    await mkdir(join(root, "props"));
    const index = parseIndex(
      "# props\n\n## Assets\n\n- [Evil](../../outside.md)\n",
      "props/index.md",
    );
    assert.throws(
      () => checkIndexPaths(index, root, join(root, "props"), "props/index.md"),
      InputError,
    );
    const fine = parseIndex(
      renderIndex({ name: "props", folders: ["a"], assets: [{ id: "x", title: "X" }] }),
      "i",
    );
    checkIndexPaths(fine, root, join(root, "props"), "props/index.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
