/**
 * The refusals of the extension contract (design section 11), each exit 2: `extension_unavailable`
 * (a listed package that does not resolve, or an `<ext>:<name>` id no loaded extension provides),
 * `extension_refused` (a package or entry core will not load) and `extension_conflict` (two
 * extensions with one name, or one id registered twice).
 */
import { InputError } from "../errors.ts";

export type ExtensionErrorCode =
  "extension_unavailable" | "extension_refused" | "extension_conflict";

export class ExtensionError extends InputError {
  readonly code: ExtensionErrorCode;
  constructor(code: ExtensionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExtensionError";
    this.code = code;
  }
}

/**
 * The extension an `<ext>:<name>` id belongs to, or undefined for a core id. Ids come from JSON
 * read without a runtime check, so a value that is not a string belongs to no extension.
 */
export function extensionOf(id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  const at = id.indexOf(":");
  return at > 0 ? id.slice(0, at) : undefined;
}

/**
 * The refusal of an `<ext>:<name>` id no loaded extension provides, naming the extension and the
 * settings line that would load it.
 */
export function unavailableId(id: string, what: string, settingsPath?: string): ExtensionError {
  const ext = extensionOf(id) ?? id;
  const where = settingsPath !== undefined ? ` in ${settingsPath}` : " in the developer settings";
  return new ExtensionError(
    "extension_unavailable",
    `${what} "${id}" comes from extension "${ext}", which is not loaded; list the package that provides it under extensions${where}`,
  );
}
