/**
 * The members of a set (design section 8): every asset and candidate a tree folder lists, over
 * every page, each with its image and subject. Reading only: nothing here writes or spends.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { InputError } from "../errors.ts";
import { readMedia } from "../library/lfs.ts";
import { sha256, sniffMediaType } from "../request.ts";
import { formatAddress, parseAddress } from "../tree/address.ts";
import { loadAssets, mediaPath } from "../tree/project.ts";
import type { Project } from "../tree/project.ts";
import { readTree, runCandidateFiles } from "../tree/read.ts";

/** One child of a folder that is a member of its set: its address as the search index names it. */
export interface MemberAddress {
  address: string;
  kind: "asset" | "candidate";
}

/**
 * The asset and candidate children of a tree folder, every page of it, as the search index names
 * them (no trailing slash). An address that is not a folder exits 2 `invalid_input`; `label` names
 * the argument in that message.
 */
export async function folderChildren(
  project: Project,
  set: string,
  label: string,
): Promise<MemberAddress[]> {
  const members: MemberAddress[] = [];
  let address: string | undefined = set;
  while (address !== undefined) {
    const read = await readTree(project, address);
    const document = read.document as
      { kind?: string; children?: { address: string; kind: string }[]; next?: string } | undefined;
    if (!read.folder || document?.kind !== "folder") {
      throw new InputError(`${label} ${set} is not a folder address of the asset tree`);
    }
    for (const child of document.children ?? []) {
      if (child.kind !== "asset" && child.kind !== "candidate") continue;
      const at = parseAddress(child.address);
      members.push({ address: formatAddress(at.game, at.segments), kind: child.kind });
    }
    address = document.next;
  }
  return members;
}

/** A member with what the audit needs of it. */
export interface Member {
  address: string;
  /** The bible subject it depicts, when its card or run names one. */
  subject?: string;
  /** Its media file, project-relative with `/`. */
  path?: string;
  /** The image, when the member's media is a local image. */
  image?: { path: string; mediaType: string; bytes: Uint8Array; sha256: string };
  /** Why the member is not scored. */
  skipped?: string;
}

function rel(project: Project, path: string): string {
  return relative(project.dir, path).split(sep).join("/");
}

function runSpec(project: Project, run: string): Record<string, unknown> {
  const file = join(project.runsDir, run, "run.json");
  if (!existsSync(file)) return {};
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as { spec?: Record<string, unknown> };
    return record.spec ?? {};
  } catch {
    return {};
  }
}

/** Reads each member's image and subject. */
export async function resolveMembers(
  project: Project,
  addresses: readonly MemberAddress[],
): Promise<Member[]> {
  const assets = loadAssets(project);
  const out: Member[] = [];
  for (const { address, kind } of addresses) {
    const [first, run, candidate] = parseAddress(address).segments;
    let subject: string | undefined;
    let file: string | undefined;
    let bytes: Uint8Array | undefined;
    let skipped: string | undefined;
    if (kind === "asset") {
      const asset = assets.get(first!);
      subject = asset?.subject;
      if (asset === undefined) skipped = "no card";
      else {
        file = mediaPath(project, asset);
        const media = await readMedia(file).catch(() => undefined);
        if (media === undefined) skipped = "its media cannot be read";
        else if (media.kind === "lfs-pointer") skipped = "its media is a Git LFS pointer";
        else bytes = media.bytes;
      }
    } else {
      const spec = runSpec(project, run!);
      const named = spec["subject"] ?? spec["assetId"];
      if (typeof named === "string" && named !== "") subject = named;
      file = runCandidateFiles(project, run!).find((c) => c.id === candidate)?.file;
      if (file === undefined) skipped = "no candidate file";
      else
        try {
          bytes = new Uint8Array(readFileSync(file));
        } catch {
          skipped = "its file cannot be read";
        }
    }
    const member: Member = {
      address,
      ...(subject !== undefined && { subject }),
      ...(file !== undefined && { path: rel(project, file) }),
    };
    if (bytes !== undefined) {
      const mediaType = sniffMediaType(bytes);
      if (mediaType.startsWith("image/"))
        member.image = { path: file!, mediaType, bytes, sha256: sha256(bytes) };
      else skipped = `${mediaType} is not an image`;
    }
    if (skipped !== undefined) member.skipped = skipped;
    out.push(member);
  }
  return out;
}
