import { resolve } from "node:path";
import { InputError } from "../errors.ts";
import { PROFILE_PATH } from "../init.ts";
import { loadProfile } from "../inputs.ts";
import { exactMatches } from "../library/exact.ts";
import { readMedia } from "../library/lfs.ts";
import { defineCommand } from "./types.ts";

interface IntakeArgs {
  file: string;
  target: string;
  profile?: string;
}

export const intakeCommand = defineCommand<IntakeArgs>({
  name: "intake",
  tool: "intake",
  summary: "check incoming media for exact tracked asset versions without writing",
  details: `Hashes the complete media bytes and reports every matching asset and version in the
 target's library, including historical versions. Names and visual similarity are not identity.
 This check is read-only and free. An unfetched LFS input is refused rather than hashing pointer
 text. For a staged candidate, pick reports the same matches and requires an explicit
 --duplicate existing-version, keep-separate or exit decision before admission.`,
  input: {
    type: "object",
    properties: {
      file: { type: "string", description: "incoming media file", placeholder: "<file>" },
      target: { type: "string", description: "target project", placeholder: "<directory>" },
      profile: {
        type: "string",
        description: "target profile (defaults to the project's profile)",
      },
    },
    required: ["file", "target"],
    additionalProperties: false,
  },
  positionals: [{ name: "file" }],
  effect: { readOnly: true, spends: "never", writes: "none" },
  async run(args) {
    const target = resolve(args.target);
    const profile = (await loadProfile(args.profile ?? resolve(target, PROFILE_PATH))).value;
    const media = await readMedia(args.file);
    if (media.kind === "lfs-pointer")
      throw new InputError(
        "intake needs local media bytes; the input is an unfetched Git LFS pointer",
      );
    const matches = await exactMatches(profile, target, [media.sha256]);
    return {
      exitCode: 0,
      fields: {
        file: resolve(args.file),
        sha256: media.sha256,
        matches,
        outcome: matches.length > 0 ? "decision-required" : "distinct",
        ...(matches.length > 0 && { outcomes: ["existing-version", "keep-separate", "exit"] }),
      },
      human:
        matches.length === 0
          ? "no exact byte match; this input is distinct"
          : matches
              .map((m) => `exact match: ${m.assetId} version ${m.version} (${m.sha256})`)
              .join("\n") +
            "\nChoose existing-version, keep-separate or exit when picking a staged candidate.",
    };
  },
});
