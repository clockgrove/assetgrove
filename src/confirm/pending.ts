/**
 * Pending confirmation requests: what exit 8 `confirmation_required` saved under
 * `<stateDir>/pending/<id>.json`, for `assetgrove confirm <id>` to complete.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InputError } from "../errors.ts";

/** A saved request: its kind, id and the payload `confirm` shows and completes. */
export interface PendingRequest {
  kind: string;
  id: string;
  summary: string;
  createdAt: string;
  [field: string]: unknown;
}

const ID = /^[0-9a-f]{8,128}$/;

function pendingPath(stateDir: string, id: string): string {
  if (!ID.test(id)) throw new InputError(`"${id}" is not a confirmation id (lowercase hex)`);
  return join(stateDir, "pending", `${id}.json`);
}

/** Saves a request, replacing an earlier one with the same id. Returns its path. */
export function savePending(stateDir: string, request: PendingRequest): string {
  const path = pendingPath(stateDir, request.id);
  mkdirSync(join(stateDir, "pending"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return path;
}

/** The saved request with this id; exit 2 when there is none. */
export function readPending(stateDir: string, id: string): PendingRequest {
  const path = pendingPath(stateDir, id);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new InputError(`no pending confirmation ${id} (looked for ${path})`);
  }
  const request = raw as Partial<PendingRequest>;
  if (typeof request.kind !== "string" || request.id !== id) {
    throw new InputError(`${path} is not a pending confirmation request`);
  }
  return request as PendingRequest;
}

/** Removes a completed request. */
export function removePending(stateDir: string, id: string): void {
  rmSync(pendingPath(stateDir, id), { force: true });
}
