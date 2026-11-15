import type { TargetProfile } from "../../src/types.ts";
import { approve } from "./env.ts";
import { VALIDATOR } from "./synthetic.ts";

/** Approves the profile's validator command, as pick and write-families will run it in `targetDir`. */
export function approveValidator(profile: TargetProfile, targetDir: string): void {
  if (profile.validator)
    approve({ kind: "validator", argv: profile.validator.command, cwd: targetDir });
}

/** Approves the synthetic profile's validator (test/fixtures/validator.ts) in `targetDir`. */
export function approveSyntheticValidator(targetDir: string): void {
  approve({
    kind: "validator",
    argv: [process.execPath, VALIDATOR, "{{manifest}}"],
    cwd: targetDir,
  });
}
