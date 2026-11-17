/**
 * Which packs this build of Assetgrove loads (design section 11): a pack's package.json declares
 * the contract version it speaks (`assetgrove.api`) and the core versions it was built for (its
 * peer range on `@clockgrove/assetgrove`). Both are read before anything is imported; core loads a
 * pack only when it speaks that api and its version satisfies that range, pre-releases included.
 */
import { readFileSync } from "node:fs";
import semver from "semver";
import { EXTENSION_APIS } from "../extension/api.ts";

/** Core's package name, the peer a pack declares. */
export const CORE_PACKAGE = "@clockgrove/assetgrove";

/** This build's version, from its package.json; null when it cannot be read. */
export function coreVersion(): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function spoken(): string {
  const list = EXTENSION_APIS.join(", ");
  return EXTENSION_APIS.length === 1 ? `api ${list}` : `apis ${list}`;
}

/**
 * Why a pack whose package.json declares `api` and `peerDependencies` cannot load on core
 * `version`, or undefined when it can. Each refusal names the api versions core speaks.
 */
export function compatibilityProblem(
  api: unknown,
  peerDependencies: unknown,
  version: string | null,
): string | undefined {
  if (!(EXTENSION_APIS as readonly unknown[]).includes(api)) {
    const declared = JSON.stringify(api);
    const why =
      api === 1
        ? "api 1 is the pre-0.3 contract, which this Assetgrove no longer loads; rebuild the pack against api 2"
        : `this Assetgrove does not speak api ${declared ?? "(none)"}`;
    return `declares extension api ${declared ?? "(none)"}: ${why}; it speaks ${spoken()}`;
  }
  const peers =
    peerDependencies !== null && typeof peerDependencies === "object"
      ? (peerDependencies as Record<string, unknown>)
      : {};
  const range = peers[CORE_PACKAGE];
  if (typeof range !== "string" || range.trim() === "") {
    return `declares no peerDependencies["${CORE_PACKAGE}"] range; a pack names the core versions it was built for (this Assetgrove is ${version ?? "of unknown version"} and speaks ${spoken()})`;
  }
  if (semver.validRange(range) === null) {
    return `its peer range ${JSON.stringify(range)} on ${CORE_PACKAGE} is not a semver range`;
  }
  if (version === null || semver.valid(version) === null) {
    return `this Assetgrove's own version cannot be read, so its peer range ${JSON.stringify(range)} cannot be checked`;
  }
  if (!semver.satisfies(version, range, { includePrerelease: true })) {
    return `its peer range ${JSON.stringify(range)} on ${CORE_PACKAGE} excludes this Assetgrove ${version} (which speaks ${spoken()}); install a release of the pack built for it`;
  }
  return undefined;
}
