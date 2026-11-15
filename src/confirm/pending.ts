/**
 * Pending confirmation requests: a request no channel could ask is saved to
 * `<stateDir>/pending/<id>.json`, and `assetgrove confirm <id>` reads it back.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InputError } from "../errors.ts";
import type { ConfirmRequest } from "./prompt.ts";

/** A pending request as saved: the request and when it was saved. */
export interface PendingRequest extends ConfirmRequest {
  at: string;
}

const ID = /^[0-9a-f]{64}$/;

function pendingPath(stateDir: string, id: string): string {
  if (!ID.test(id)) throw new InputError(`"${id}" is not a confirmation id (64 hex characters)`);
  return join(stateDir, "pending", `${id}.json`);
}

/** Saves a request no channel could ask. */
export async function savePending(stateDir: string, request: ConfirmRequest): Promise<string> {
  const path = pendingPath(stateDir, request.id);
  await mkdir(join(stateDir, "pending"), { recursive: true });
  const saved: PendingRequest = { ...request, at: new Date().toISOString() };
  await writeFile(path, `${JSON.stringify(saved, null, 2)}\n`);
  return path;
}

/** The saved request of an id; exit 2 when there is none. */
export async function readPending(stateDir: string, id: string): Promise<PendingRequest> {
  const path = pendingPath(stateDir, id);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new InputError(`no pending confirmation ${id} (looked for ${path})`);
  }
  const request = JSON.parse(text) as PendingRequest;
  if (request.id !== id) throw new InputError(`pending confirmation ${path} names another id`);
  return request;
}

/** Removes a pending request once it is answered. */
export async function removePending(stateDir: string, id: string): Promise<void> {
  await rm(pendingPath(stateDir, id), { force: true });
}
