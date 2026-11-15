import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireApproval, scriptIdentity } from "../approvals.ts";
import type { ApprovalGate } from "../approvals.ts";
import { InputError } from "../errors.ts";
import type { Script } from "../gateway/scripted.ts";

/**
 * Loads a --provider-script module, whose default export must be { image, vision } functions. The
 * module is code a developer wrote, so it loads only with an approval tied to its hash
 * (src/approvals.ts, kind `provider-script`); otherwise this exits 8 before importing it.
 */
export async function loadScript(path: string, gate: ApprovalGate): Promise<Script> {
  await requireApproval(scriptIdentity(path), gate);
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
