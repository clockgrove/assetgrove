import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { InputError } from "../errors.ts";
import { parseCard } from "./card.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { parseLfsPointer } from "./lfs.ts";
import { parseReview } from "./review.ts";

function git(cwd: string, args: string[]): Buffer {
  try {
    return execFileSync("git", args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new InputError(`Cannot read Git revision (${args[0]}).`);
  }
}
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
interface Media {
  path: string;
  sha256: string;
  status: "available" | "missing_lfs_object" | "invalid_lfs_object";
  preview?: string;
}
interface Asset {
  version: unknown;
  labels: unknown;
  reviews: unknown;
  renditions: Media[];
  media?: Media;
}

export function libraryDiff(target: string, base: string, head: string) {
  const cwd = resolve(target);
  const revision = (ref: string) =>
    git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
      .toString()
      .trim();
  const before = revision(base),
    after = revision(head);
  const common = git(cwd, ["rev-parse", "--git-common-dir"]).toString().trim();
  const objects = resolve(cwd, common, "lfs/objects");
  let remote = "";
  try {
    remote = git(cwd, ["config", "--get", "remote.origin.url"]).toString().trim();
  } catch {
    /* A local repository need not have a remote. */
  }
  const github = /^(?:https:\/\/github\.com\/|git@github\.com:)([^\s?#]+?)(?:\.git)?$/.exec(
    remote,
  )?.[1];
  const snapshot = (commit: string) => {
    const files = new Map<string, string>();
    for (const line of git(cwd, ["ls-tree", "-rz", "--full-tree", commit]).toString().split("\0")) {
      if (!line) continue;
      const tab = line.indexOf("\t"),
        [mode, type, oid] = line.slice(0, tab).split(" ");
      if (type === "blob" && mode !== "120000") files.set(line.slice(tab + 1), oid!);
    }
    const bytes = (path: string) => git(cwd, ["cat-file", "blob", files.get(path)!]);
    const media = (path: string): Media => {
      const content = bytes(path),
        pointer = parseLfsPointer(content);
      if (!pointer && content.toString().startsWith("version https://git-lfs.github.com/spec/v1"))
        throw new InputError(`${path}: invalid LFS pointer`);
      const sha256 = pointer?.oid ?? sha256Hex(content);
      let status: Media["status"] = "available";
      if (pointer) {
        let local: Buffer | undefined;
        try {
          local = readFileSync(
            resolve(objects, pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid),
          );
        } catch {
          status = "missing_lfs_object";
        }
        if (local && (local.length !== pointer.size || sha256Hex(local) !== pointer.oid))
          status = "invalid_lfs_object";
      }
      const link = github
        ? `https://github.com/${github}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`
        : `git:${commit}:${encodeURIComponent(path)}`;
      return { path, sha256, status, ...(status === "available" ? { preview: link } : {}) };
    };
    const assets = new Map<string, Asset>();
    for (const path of [...files.keys()].sort(order)) {
      if (!path.endsWith(".md")) continue;
      const text = bytes(path).toString();
      if (!/^format:\s*['"]?assetgrove-card\/1['"]?\s*$/m.test(text)) continue;
      const card = parseCard(text, path).data;
      const resource = card.resource as string;
      if (
        resource.includes("\\") ||
        resource.includes(":") ||
        resource.startsWith("/") ||
        resource.includes("\0")
      )
        throw new InputError(`${path}: unsafe resource`);
      const resourcePath = posix.normalize(posix.join(posix.dirname(path), resource));
      if (resourcePath.startsWith("../"))
        throw new InputError(`${path}: resource escapes repository`);
      const id = path.slice(0, -3),
        reviewPath = `${id}.review.json`;
      const review = files.has(reviewPath)
        ? parseReview(bytes(reviewPath).toString(), reviewPath)
        : undefined;
      const renditionPaths = [...files.keys()]
        .filter(
          (p) =>
            p.startsWith(`${id}.`) &&
            p !== path &&
            p !== reviewPath &&
            p !== resourcePath &&
            !p.endsWith(".json") &&
            !p.endsWith(".md"),
        )
        .sort(order);
      assets.set(id, {
        version: review?.versions ?? { version: card.version, lock: card.lock },
        labels: card.tags ?? [],
        reviews: review?.annotations ?? [],
        renditions: renditionPaths.map(media),
        ...(files.has(resourcePath) ? { media: media(resourcePath) } : {}),
      });
    }
    return assets;
  };
  const left = snapshot(before),
    right = snapshot(after);
  const changes = [...new Set([...left.keys(), ...right.keys()])].sort(order).flatMap((asset) => {
    const old = left.get(asset),
      next = right.get(asset);
    const categories = (["version", "labels", "reviews", "renditions", "media"] as const).filter(
      (key) => {
        const clean = (value: unknown): unknown =>
          Array.isArray(value)
            ? value.map(clean)
            : value && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value)
                    .filter(([k]) => k !== "preview")
                    .map(([k, v]) => [k, clean(v)]),
                )
              : value;
        return canonicalJson(clean(old?.[key])) !== canonicalJson(clean(next?.[key]));
      },
    );
    return categories.length
      ? [
          {
            asset,
            change: !old ? "added" : !next ? "removed" : "modified",
            categories,
            before: old,
            after: next,
          },
        ]
      : [];
  });
  return { base: before, head: after, changes };
}

export function formatLibraryDiff(report: ReturnType<typeof libraryDiff>): string {
  return [
    `# Library changes`,
    "",
    `Base: ${report.base}`,
    `Head: ${report.head}`,
    "",
    ...report.changes.flatMap((change) => [
      `## ${JSON.stringify(change.asset)} (${change.change})`,
      `Changed: ${change.categories.join(", ")}`,
      "",
      ...(["before", "after"] as const).flatMap((side) => {
        const asset = change[side];
        return asset
          ? [
              `${side}:`,
              "```json",
              JSON.stringify(
                { version: asset.version, labels: asset.labels, reviews: asset.reviews },
                null,
                2,
              ),
              "```",
              ...[...(asset.media ? [asset.media] : []), ...asset.renditions].map(
                (media) =>
                  `${JSON.stringify(media.path)}: ${media.status}; sha256 ${media.sha256}${media.preview ? ` [preview](${media.preview})` : ""}`,
              ),
              "",
            ]
          : [];
      }),
    ]),
    ...(report.changes.length ? [] : ["No library changes."]),
  ].join("\n");
}
