/**
 * Preloaded with `--import` into a CLI child. Appends the remote host of every outgoing connection
 * to the file named by LOOPBACK_LOG, one per line, so a test can assert none left the machine.
 */
import { appendFileSync } from "node:fs";
import { subscribe } from "node:diagnostics_channel";

const log = process.env["LOOPBACK_LOG"];

function record(host: unknown): void {
  if (log !== undefined && typeof host === "string") appendFileSync(log, `${host}\n`);
}

subscribe("net.client.socket", (message) => {
  const { socket } = message as { socket?: { remoteAddress?: string } };
  // The address is known only once the socket tries it, so a refused or failed attempt counts too.
  const s = socket as import("node:net").Socket | undefined;
  s?.on("connectionAttempt", (ip: unknown) => record(ip));
  s?.once("connect", () => record(s.remoteAddress));
});
subscribe("undici:client:beforeConnect", (message) => {
  const { connectParams } = message as { connectParams?: { hostname?: string } };
  record(connectParams?.hostname);
});
