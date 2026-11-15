import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { providerScriptCommand, requireApproval } from "../approvals.ts";
import type { ApprovalContext, ApprovedCommand } from "../approvals.ts";
import { InputError } from "../errors.ts";
import type { Script } from "../gateway/scripted.ts";

/**
 * Refuses a --provider-script module that is not approved (design section 8, kind
 * `provider-script`): exit 8 unless its hash is in settings or an approval file, or a person on a
 * TTY approves it now. Runs before any command given one loads it.
 */
export async function approveProviderScript(
  path: string,
  ctx: ApprovalContext,
): Promise<ApprovedCommand> {
  let isFile = false;
  try {
    isFile = statSync(resolve(path)).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new InputError(`cannot load provider script ${path}: no such file`);
  return requireApproval(providerScriptCommand(path), ctx);
}

/** Loads a --provider-script module, whose default export must be { image, vision } functions. */
export async function loadScript(path: string): Promise<Script> {
  let mod: { default?: Partial<Script> };
  try {
    mod = (await import(pathToFileURL(resolve(path)).href)) as typeof mod;
  } catch (error) {
    throw new InputError(`cannot load provider script ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const script = mod.default;
  if (typeof script?.image !== "function" || typeof script.vision !== "function") {
    throw new InputError(`provider script ${path} must default-export { image, vision } functions`);
  }
  return script as Script;
}
