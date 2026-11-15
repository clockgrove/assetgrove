/**
 * Loaded into a CLI child with `node --import`. Appends every outgoing socket connection, one JSON
 * line `{host, port}` or `{path}`, to the file named by ASSETGROVE_TEST_CONNECTIONS.
 */
import { appendFileSync } from "node:fs";
import net from "node:net";

const file = process.env["ASSETGROVE_TEST_CONNECTIONS"];
const original = net.Socket.prototype.connect;

function record(args: unknown[]): void {
  if (file === undefined) return;
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  let entry: { host?: string; port?: number; path?: string };
  if (typeof first === "object" && first !== null) {
    const o = first as { host?: string; port?: number | string; path?: string };
    entry =
      o.path !== undefined
        ? { path: o.path }
        : { host: o.host ?? "localhost", port: Number(o.port) };
  } else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    entry = { host: typeof args[1] === "string" ? args[1] : "localhost", port: Number(first) };
  } else {
    entry = { path: String(first) };
  }
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  record(args);
  return (original as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;
