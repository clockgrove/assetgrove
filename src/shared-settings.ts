/**
 * Shared files (the target profile, a style bible's front matter, a spec) travel between
 * developers, so they never carry what only the developer settings may: a pack's settings
 * (`extensionSettings`) or provider settings (`providers`). A file holding either, at any depth,
 * is refused (exit 2 `invalid_input`), naming where.
 */
import { InputError } from "./errors.ts";

/** Field names (lower-cased, without `-` and `_`) only the developer settings carry. */
const SETTINGS_ONLY_FIELDS: readonly string[] = ["extensionsettings", "providers"];

/** The dotted path of the first settings-only field in `value`, or undefined when it has none. */
export function settingsBlockIn(value: unknown, at: string[] = []): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = settingsBlockIn(item, [...at, String(index)]);
      if (found !== undefined) return found;
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [field, item] of Object.entries(value)) {
      if (SETTINGS_ONLY_FIELDS.includes(field.toLowerCase().replace(/[-_]/g, "")))
        return [...at, field].join(".");
      const found = settingsBlockIn(item, [...at, field]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Throws `InputError` when `value`, the shared file `what`, holds a settings-only field. */
export function refuseSettingsBlocks(value: unknown, what: string): void {
  const found = settingsBlockIn(value);
  if (found === undefined) return;
  throw new InputError(
    `${what} holds "${found}": extension settings and provider settings live only in the developer settings (docs/settings.md)`,
  );
}
