/** A structured failure of the search package. `code` is stable; `hint` names the fix. */
export type SearchErrorCode =
  | "model_missing"
  | "model_unpinned"
  | "setup_failed"
  | "hash_mismatch"
  | "invalid_input"
  | "settings_invalid"
  | "extension_unavailable"
  | "store_locked";

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown>;
  constructor(
    code: SearchErrorCode,
    message: string,
    options: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SearchError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details ?? {};
  }
}
