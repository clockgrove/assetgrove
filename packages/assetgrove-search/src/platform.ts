import { SearchError } from "./errors.ts";

export function assertSupportedPlatform(
  p: { platform: string; arch: string } = { platform: process.platform, arch: process.arch },
): void {
  if (p.platform === "darwin" && p.arch === "x64") {
    throw new SearchError(
      "extension_unavailable",
      "Search is unavailable on Intel Macs: neither LanceDB (since 0.23) nor onnxruntime-node builds for darwin-x64.",
      { details: { reason: "platform", platform: p.platform, arch: p.arch } },
    );
  }
}
