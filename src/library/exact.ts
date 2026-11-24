import { libraryPath } from "./paths.ts";
import { libraryConfig, readOwnCard, readOwnReview, scanCards } from "./write.ts";
import type { TargetProfile } from "../types.ts";

export interface ExactMatch {
  assetId: string;
  version: number;
  sha256: string;
  /** Present when the bytes matched are those a signed version was signed over, not its file. */
  contentSha256?: string;
  card: string;
}

/**
 * Version hashes name the entire media bytes, including credentials, rather than decoded pixels.
 * A signed version also matches the exact bytes it was signed over (its `contentSha256`), as
 * `olderVersionCheck` treats them as that version: a staged candidate is compared unsigned.
 */
export async function exactMatches(
  profile: TargetProfile,
  target: string,
  hashes: readonly string[],
): Promise<ExactMatch[]> {
  const { root } = libraryConfig(profile, target);
  const wanted = new Set(hashes);
  const matches: ExactMatch[] = [];
  for (const found of scanCards(root)) {
    try {
      const cardPath = libraryPath(root, found.dir, `${found.id}.md`, "exact match card");
      const card = await readOwnCard(cardPath, root, found.dir);
      if (card === undefined) continue;
      const data = card.data as {
        resource: string;
        version?: number;
        sources?: { id: string; resource: string }[];
      };
      const reviewPath = libraryPath(
        root,
        found.dir,
        data.sources?.find((source) => source.id === "review")?.resource ??
          `${found.id}.review.json`,
        cardPath,
      );
      const record = await readOwnReview(reviewPath, root, found.dir, undefined);
      const versions =
        record?.versions.map((v, i) => ({
          sha256: v.sha256,
          contentSha256: v.contentSha256,
          version: i + 1,
        })) ??
        (found.sha256 === undefined
          ? []
          : [{ sha256: found.sha256, contentSha256: undefined, version: data.version ?? 1 }]);
      for (const { contentSha256, ...version } of versions) {
        const byContent =
          !wanted.has(version.sha256) && contentSha256 !== undefined && wanted.has(contentSha256);
        if (!wanted.has(version.sha256) && !byContent) continue;
        matches.push({
          assetId: found.id,
          ...version,
          ...(byContent && { contentSha256 }),
          card: cardPath,
        });
      }
    } catch {
      // As with library writes, an unrelated unreadable record cannot block another asset.
    }
  }
  return matches.sort((a, b) => a.card.localeCompare(b.card) || a.version - b.version);
}
