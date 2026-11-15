/**
 * The one writer of the developer settings (design sections 2 and 7): `settings change` proposes
 * caps, a provider's limit and hold acknowledgements, a person confirms them, and
 * `applySettingsChange` edits the file in place with `jsonc-parser`, changing only those fields and
 * one `confirmedBy` entry per field path, so every other byte stays as it was. A limit for a core
 * adapter id with no provider entry creates the entry with only `limit`.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { applyEdits, findNodeAtLocation, format, modify, parse, parseTree } from "jsonc-parser";
import type { FormattingOptions } from "jsonc-parser";
import { digestOf } from "./confirm/records.ts";
import type { ConfirmRequest } from "./confirm/prompt.ts";
import { InputError } from "./errors.ts";
import { CORE_ADAPTERS } from "./providers/adapter.ts";
import { LIMIT_KINDS, loadSettings } from "./settings.ts";
import type { ProviderLimit, Settings } from "./settings.ts";
import { readHolds } from "./spend.ts";

const FORMAT = "assetgrove-settings/1";

export const CAP_FIELDS = ["runUsd", "dailyUsd", "workItemUsd"] as const;
export type CapField = (typeof CAP_FIELDS)[number];

/** What a person is asked to write: caps, one provider's limit and hold acknowledgements. */
export interface SettingsChange {
  caps?: Partial<Record<CapField, number>>;
  limit?: { provider: string; limit: ProviderLimit };
  acknowledgeHolds?: string[];
}

/** How a change was confirmed, as each `confirmedBy` entry records it. */
export interface ChangeConfirmation {
  method: "elicitation" | "terminal";
  client?: string;
}

/** A settings request: its body (the settings file and the change) hashes to its id. */
export interface SettingsRequest extends ConfirmRequest {
  kind: "settings";
  body: { command: "settings change"; settings: string; change: SettingsChange };
}

/** What writing a change did: the field paths written and the ones left out, with why. */
export interface ChangeResult {
  path: string;
  written: string[];
  notWritten: Array<{ field: string; reason: string }>;
}

const usd = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Refuses (exit 2 `invalid_input`) a change that proposes nothing, a negative cap, a limit kind
 * that is not one of `LIMIT_KINDS`, a provider id that is neither in the settings nor a core
 * adapter id, or a hold id `<stateDir>/holds.jsonl` does not list.
 */
export function checkChange(
  change: SettingsChange,
  settings: Pick<Settings, "providers" | "stateDir">,
): void {
  const caps = Object.entries(change.caps ?? {});
  const holds = change.acknowledgeHolds ?? [];
  if (caps.length === 0 && change.limit === undefined && holds.length === 0)
    throw new InputError(
      "settings change proposes nothing: give a cap, a provider limit or a hold to acknowledge",
    );
  for (const [field, value] of caps) {
    if (!(CAP_FIELDS as readonly string[]).includes(field) || !usd(value))
      throw new InputError(`caps.${field} must be a number of USD, 0 or more`);
  }
  if (change.limit !== undefined) {
    const { provider, limit } = change.limit;
    if (provider.trim() === "") throw new InputError("provider must name a provider id");
    if (!(LIMIT_KINDS as readonly string[]).includes(limit.kind))
      throw new InputError(`limit kind must be one of ${LIMIT_KINDS.join(", ")}`);
    if (limit.usd !== undefined && !usd(limit.usd))
      throw new InputError("limit usd must be a number of USD, 0 or more");
    if (limit.period !== undefined && limit.period.trim() === "")
      throw new InputError("limit period must not be empty");
    if (!Object.hasOwn(settings.providers, provider) && !isCoreAdapter(provider))
      throw new InputError(
        `provider "${provider}" is not in the settings' providers and is not a core adapter id (${CORE_ADAPTERS.map((a) => a.id).join(", ")}); add its entry by hand first`,
      );
  }
  if (holds.length > 0) {
    const known = new Set(readHolds(settings.stateDir).map((h) => h.id.toLowerCase()));
    for (const id of holds) {
      if (!known.has(id.toLowerCase()))
        throw new InputError(`no spend hold "${id}" in ${settings.stateDir}/holds.jsonl`);
    }
  }
}

function isCoreAdapter(id: string): boolean {
  return CORE_ADAPTERS.some((a) => a.id === id);
}

/** The change in a canonical shape: caps in field order, holds deduplicated in order. */
export function normalChange(change: SettingsChange): SettingsChange {
  const caps: Partial<Record<CapField, number>> = {};
  for (const field of CAP_FIELDS) {
    const value = change.caps?.[field];
    if (value !== undefined) caps[field] = value;
  }
  const holds = [...new Set(change.acknowledgeHolds ?? [])];
  return {
    ...(Object.keys(caps).length > 0 && { caps }),
    ...(change.limit !== undefined && {
      limit: {
        provider: change.limit.provider,
        limit: {
          kind: change.limit.limit.kind,
          ...(change.limit.limit.usd !== undefined && { usd: change.limit.limit.usd }),
          ...(change.limit.limit.period !== undefined && { period: change.limit.limit.period }),
          acceptUnlimited: change.limit.limit.acceptUnlimited === true,
        },
      },
    }),
    ...(holds.length > 0 && { acknowledgeHolds: holds }),
  };
}

/** The flat fields a person is shown for a change, in order. */
function changeDetails(change: SettingsChange): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(change.caps ?? {})) details[`caps.${field}`] = value;
  if (change.limit !== undefined) {
    const { provider, limit } = change.limit;
    details["provider"] = provider;
    details["limit.kind"] = limit.kind;
    if (limit.usd !== undefined) details["limit.usd"] = limit.usd;
    if (limit.period !== undefined) details["limit.period"] = limit.period;
    details["limit.acceptUnlimited"] = limit.acceptUnlimited === true;
  }
  if (change.acknowledgeHolds !== undefined)
    details["spend.acknowledgedHolds"] = change.acknowledgeHolds.join(", ");
  return details;
}

/** The request of a change to the settings file at `settingsPath`; its id is its body's digest. */
export function settingsRequest(settingsPath: string, change: SettingsChange): SettingsRequest {
  const normal = normalChange(change);
  const body = { command: "settings change" as const, settings: settingsPath, change: normal };
  const id = digestOf(body);
  const details = { settings: settingsPath, ...changeDetails(normal), digest: id };
  return {
    kind: "settings",
    id,
    summary: `change the developer settings ${settingsPath}`,
    details,
    body,
  };
}

/**
 * The pending settings request of `request`, rebuilt from its body and required to make the same
 * id; undefined when it does not.
 */
export function rebuiltSettingsRequest(request: ConfirmRequest): SettingsRequest | undefined {
  const body = request.body;
  if (request.kind !== "settings" || body === undefined || body === null) return undefined;
  const settings = body["settings"];
  const change = body["change"];
  if (typeof settings !== "string" || typeof change !== "object" || change === null)
    return undefined;
  try {
    const rebuilt = settingsRequest(settings, change as SettingsChange);
    return rebuilt.id === request.id && digestOf(body) === request.id ? rebuilt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The change a person accepted in the settings form: each proposed field takes the submitted
 * value when the form sent one. A field the change did not propose is never taken, and a hold
 * the change did not propose is dropped. Exit 2 when a submitted value is of the wrong type.
 */
export function editedChange(
  proposed: SettingsChange,
  content: Record<string, unknown>,
): SettingsChange {
  const number = (field: string, fallback: number | undefined): number | undefined => {
    const value = content[field];
    if (value === undefined) return fallback;
    if (!usd(value)) throw new InputError(`the form's ${field} must be a number of USD, 0 or more`);
    return value;
  };
  const caps: Partial<Record<CapField, number>> = {};
  for (const [field, value] of Object.entries(proposed.caps ?? {}))
    caps[field as CapField] = number(field, value)!;
  let limit: SettingsChange["limit"];
  if (proposed.limit !== undefined) {
    const was = proposed.limit.limit;
    const kind = content["limitKind"] ?? was.kind;
    if (typeof kind !== "string" || !(LIMIT_KINDS as readonly string[]).includes(kind))
      throw new InputError(`the form's limitKind must be one of ${LIMIT_KINDS.join(", ")}`);
    const period = content["limitPeriod"] ?? was.period;
    if (period !== undefined && typeof period !== "string")
      throw new InputError("the form's limitPeriod must be text");
    const accept = content["acceptUnlimited"] ?? was.acceptUnlimited;
    if (accept !== undefined && typeof accept !== "boolean")
      throw new InputError("the form's acceptUnlimited must be true or false");
    const usdValue = number("limitUsd", was.usd);
    limit = {
      provider: proposed.limit.provider,
      limit: {
        kind: kind as ProviderLimit["kind"],
        ...(usdValue !== undefined && { usd: usdValue }),
        ...(period !== undefined && period !== "" && { period }),
        acceptUnlimited: accept === true,
      },
    };
  }
  let holds = proposed.acknowledgeHolds;
  const listed = content["acknowledgeHolds"];
  if (holds !== undefined && listed !== undefined) {
    if (typeof listed !== "string")
      throw new InputError("the form's acknowledgeHolds must be text: hold ids, comma-separated");
    const kept = new Set(
      listed
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((id) => id.toLowerCase()),
    );
    holds = holds.filter((id) => kept.has(id.toLowerCase()));
  }
  return normalChange({
    ...(Object.keys(caps).length > 0 && { caps }),
    ...(limit !== undefined && { limit }),
    ...(holds !== undefined && holds.length > 0 && { acknowledgeHolds: holds }),
  });
}

/** The file's own indentation and line ending, so inserted fields look like their neighbours. */
function formattingOf(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indent?.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indent?.length ?? 2, eol };
}

/**
 * `text` with the value at `path` set, every byte outside the inserted or replaced span kept.
 * `jsonc-parser`'s own formatting of an edit re-lays out the whole line the edit starts on (a
 * one-line neighbour such as `"reconcile": { "marginUsd": 0.05 }` would be spread out), so the
 * edit is made unformatted and only the formatter's changes inside the new span are taken. The
 * new span is laid out on lines like its neighbours when the object it goes into spans lines, and
 * kept on one line when that object is on one line.
 */
export function setInPlace(text: string, path: string[], value: unknown): string {
  const options = formattingOf(text);
  const tree = parseTree(text);
  let container = tree;
  for (let depth = path.length - 1; depth > 0 && tree !== undefined; depth--) {
    const node = findNodeAtLocation(tree, path.slice(0, depth));
    if (node !== undefined) {
      container = node;
      break;
    }
  }
  const multiline =
    container !== undefined &&
    /\n/.test(text.slice(container.offset, container.offset + container.length));
  for (const made of modify(text, path, value, {})) {
    // An unformatted insert after a neighbour starts `,"key"`; on one line it reads `, "key"`.
    const edit =
      !multiline && /^,\S/.test(made.content)
        ? { ...made, content: `, ${made.content.slice(1)}` }
        : made;
    const next = applyEdits(text, [edit]);
    const start = edit.offset;
    const end = edit.offset + edit.content.length;
    if (!multiline) {
      text = next;
      continue;
    }
    const inside = format(next, { offset: start, length: end - start }, options).filter(
      (e) => e.offset >= start && e.offset + e.length <= end && e.offset < end,
    );
    text = applyEdits(next, inside);
  }
  return text;
}

/** The parts of the file being edited a change depends on, read from its text, not the context. */
function current(text: string): Pick<Settings, "providers"> & { acknowledgedHolds: string[] } {
  const doc = parse(text) as unknown;
  const object = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const holds = object(object(doc)["spend"])["acknowledgedHolds"];
  return {
    providers: object(object(doc)["providers"]) as Settings["providers"],
    acknowledgedHolds: Array.isArray(holds)
      ? holds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/**
 * Writes a confirmed change into the settings file: only the changed fields and one
 * `confirmedBy.<field path>` entry each. A limit of kind `unlimited` without `acceptUnlimited`
 * is not written. With no file, it creates one holding the format line and the change. Which
 * provider entries exist and which holds are acknowledged are read from the file as it is now,
 * not from `settings` (a server loads those once, and an earlier change may have written since).
 * The result is loaded as settings from a trial file beside it before it replaces the file; a
 * change the settings would refuse is not written (exit 2 `settings_invalid`).
 */
export async function applySettingsChange(
  settings: Settings,
  change: SettingsChange,
  confirmation: ChangeConfirmation,
): Promise<ChangeResult> {
  const path = settings.path;
  const exists = existsSync(path);
  let text = exists ? await readFile(path, "utf8") : `{\n  "format": "${FORMAT}"\n}\n`;
  const now = current(text);
  checkChange(change, { providers: now.providers, stateDir: settings.stateDir });
  const set = (at: string[], value: unknown) => {
    text = setInPlace(text, at, value);
  };
  const written: string[] = [];
  const notWritten: ChangeResult["notWritten"] = [];
  const at = new Date().toISOString();
  const confirmedBy = {
    method: confirmation.method,
    at,
    ...(confirmation.client !== undefined && { client: confirmation.client }),
  };

  for (const field of CAP_FIELDS) {
    const value = change.caps?.[field];
    if (value === undefined) continue;
    set(["caps", field], value);
    written.push(`caps.${field}`);
  }
  if (change.limit !== undefined) {
    const { provider, limit } = change.limit;
    const field = `providers.${provider}.limit`;
    if (limit.kind === "unlimited" && limit.acceptUnlimited !== true) {
      notWritten.push({
        field,
        reason: 'kind "unlimited" needs acceptUnlimited: true; the provider stays undeclared',
      });
    } else {
      const entry = {
        kind: limit.kind,
        ...(limit.usd !== undefined && { usd: limit.usd }),
        ...(limit.period !== undefined && { period: limit.period }),
        ...(limit.kind === "unlimited" && { acceptUnlimited: true }),
      };
      if (Object.hasOwn(now.providers, provider)) set(["providers", provider, "limit"], entry);
      else set(["providers", provider], { limit: entry });
      written.push(field);
    }
  }
  const holds = change.acknowledgeHolds ?? [];
  if (holds.length > 0) {
    const listed = now.acknowledgedHolds;
    const have = new Set(listed.map((id) => id.toLowerCase()));
    set(
      ["spend", "acknowledgedHolds"],
      [...listed, ...holds.filter((id) => !have.has(id.toLowerCase()))],
    );
    written.push("spend.acknowledgedHolds");
  }
  if (written.length === 0) return { path, written, notWritten };
  for (const field of written) set(["confirmedBy", field], confirmedBy);

  // Check the result as the settings would load it before it replaces the file.
  await mkdir(dirname(path), { recursive: true });
  const trial = `${path}.${process.pid}.tmp`;
  await writeFile(trial, text);
  try {
    loadSettings({ env: { ...process.env, ASSETGROVE_CONFIG: trial } });
  } finally {
    await rm(trial, { force: true });
  }
  await writeFile(path, text);
  return { path, written, notWritten };
}
