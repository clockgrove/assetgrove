/**
 * Confirmation records (design section 7): `<configDir>/confirmations/<hex>.json`, one per
 * confirmed spend, pick or write request, named by the request's digest. Every method writes one.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { InputError } from "../errors.ts";
import { canonicalJson } from "../runs/plan.ts";
import type { ConfirmationRecord } from "../types.ts";

export type { ConfirmationMethod, ConfirmationRecord } from "../types.ts";

const HEX = /^[0-9a-f]{64}$/;

/** sha256 hex of a value's canonical JSON: the id of a pick or write request. */
export function digestOf(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

/** Where the record of a digest lives. */
export function confirmationPath(configDir: string, digest: string): string {
  if (!HEX.test(digest)) throw new InputError(`"${digest}" is not a request digest (64 hex)`);
  return join(configDir, "confirmations", `${digest}.json`);
}

/** Writes a record; returns its path. */
export async function writeConfirmation(
  configDir: string,
  record: ConfirmationRecord,
): Promise<string> {
  const path = confirmationPath(configDir, record.digest);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/** The record of a digest when one exists, names that digest and is of that kind. */
export async function readConfirmation(
  configDir: string,
  kind: ConfirmationRecord["kind"],
  digest: string,
): Promise<ConfirmationRecord | undefined> {
  let record: Partial<ConfirmationRecord>;
  try {
    record = JSON.parse(
      await readFile(confirmationPath(configDir, digest), "utf8"),
    ) as Partial<ConfirmationRecord>;
  } catch {
    return undefined;
  }
  if (record === null || typeof record !== "object") return undefined;
  if (record.digest !== digest || record.kind !== kind) return undefined;
  if (typeof record.forecastUsd !== "number" || typeof record.method !== "string") return undefined;
  return record as ConfirmationRecord;
}
