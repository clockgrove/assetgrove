/**
 * Shared files (the target profile, a style bible's front matter, a spec) travel between
 * developers, so they never carry what only the developer settings may: a pack's settings
 * (`extensionSettings`) or provider settings (`providers`). A file holding either as a top-level
 * field, where the developer settings keep them, is refused (exit 2 `invalid_input`), naming it.
 * Nested data is left to the kind schemas, which may not declare either field
 * (`checkKindSchemas`), as for endpoints and models.
 */
import { InputError } from "./errors.ts";

/** Field names (lower-cased, without `-` and `_`) only the developer settings carry. */
const SETTINGS_ONLY_FIELDS: readonly string[] = ["extensionsettings", "providers"];

/** The first top-level settings-only field of `value`, or undefined when it has none. */
export function settingsBlockIn(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.keys(value).find((field) =>
    SETTINGS_ONLY_FIELDS.includes(field.toLowerCase().replace(/[-_]/g, "")),
  );
}

/** Throws `InputError` when `value`, the shared file `what`, holds a settings-only field. */
export function refuseSettingsBlocks(value: unknown, what: string): void {
  const found = settingsBlockIn(value);
  if (found === undefined) return;
  throw new InputError(
    `${what} holds "${found}": extension settings and provider settings live only in the developer settings (docs/settings.md)`,
  );
}
