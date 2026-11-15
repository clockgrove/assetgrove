/**
 * The asset tree as MCP resources on the official SDK (design section 2): `resources/list` (game
 * root, folder and card addresses, paginated by cursor), `resources/templates/list`,
 * `resources/read` through the same resolver as `ls` and `cat`, and `resources/subscribe`.
 *
 * Live: the server compares a fingerprint of the project's assets and run folders before and after
 * each of its own tool calls (and at each progress update of a long one) and sends
 * `resources/updated` for each changed asset or run folder, and `resources/list_changed` after a
 * pick or write it served, or when the listing changed. On a 2025-era connection only addresses
 * the client subscribed to are sent; on a 2026-era one the SDK's listen router filters. Other
 * changes show at the next read.
 */
import { ProtocolError } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { InputError } from "../errors.ts";
import { parseAddress, formatAddress } from "./address.ts";
import { changed, fingerprint, listTree } from "./list.ts";
import { openProject } from "./project.ts";
import type { Project } from "./project.ts";
import { canonicalAddress, readTree } from "./read.ts";

/** The most entries one `resources/list` page returns. */
export const LIST_PAGE = 200;

/** Tools whose success changes what the library lists. */
const LIBRARY_WRITERS: ReadonlySet<string> = new Set(["pick", "write_families"]);

/** The JSON-RPC error a refused read answers with: Invalid Params, carrying the CLI's code. */
function readError(error: unknown, uri: string): ProtocolError {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof InputError ? "invalid_input" : "internal_error";
  return new ProtocolError(-32602, message, {
    uri,
    code,
    exitCode: code === "invalid_input" ? 2 : 1,
  });
}

/** The asset file addresses a change to an asset folder also changes. */
const ASSET_FILES = ["card", "provenance", "review", "log", "image", "image/full"];

export class TreeServer {
  private readonly dir: string;
  private readonly stateDir: string;
  private readonly subscribed = new Set<string>();
  private server?: McpServer;
  private legacy = true;
  private last?: ReturnType<typeof fingerprint>;

  constructor(dir: string, stateDir: string) {
    this.dir = dir;
    this.stateDir = stateDir;
  }

  /** The project, opened fresh for each request, so a change on disk shows at the next read. */
  private project(): Promise<Project> {
    return openProject(this.dir, this.stateDir);
  }

  private async tryProject(): Promise<Project | undefined> {
    try {
      return await this.project();
    } catch {
      return undefined;
    }
  }

  /** Installs the resource handlers on `server`, for a connection of the given era. */
  attach(server: McpServer, era: "legacy" | "modern"): void {
    this.server = server;
    this.legacy = era !== "modern";
    const low = server.server;
    low.setRequestHandler("resources/list", async (request) => {
      const project = await this.tryProject();
      const all = project ? listTree(project) : [];
      const cursor = request.params?.cursor;
      const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
      if (!Number.isInteger(start) || start < 0 || start > all.length) {
        throw new ProtocolError(-32602, `invalid cursor "${String(cursor)}"`);
      }
      const end = start + LIST_PAGE;
      return {
        resources: all.slice(start, end),
        ...(end < all.length && { nextCursor: String(end) }),
      };
    });
    low.setRequestHandler("resources/templates/list", async () => {
      const project = await this.tryProject();
      if (!project) return { resourceTemplates: [] };
      const game = project.library.game;
      const base = `asset://${encodeURIComponent(game)}`;
      const template = (path: string, name: string, mimeType: string) => ({
        uriTemplate: `${base}/${path}`,
        name,
        mimeType,
      });
      return {
        resourceTemplates: [
          template("{asset}/", "an asset's folder", "application/json"),
          template("{asset}/card", "an asset's card", "text/markdown"),
          template("{asset}/provenance", "an asset's provenance", "application/json"),
          template("{asset}/review", "an asset's review record", "application/json"),
          template("{asset}/log", "an asset's log", "text/markdown"),
          template("{asset}/image", "an asset's thumbnail", "image/png"),
          template("{asset}/image/full", "an asset's file", "application/octet-stream"),
          template("{asset}/versions/{n}", "a version of an asset", "application/json"),
          template("by-kind/{kind}/", "the assets of a kind", "application/json"),
          template("by-subject/{subject}/", "the assets of a subject", "application/json"),
          template("by-tag/{tag}/", "the assets with a tag", "application/json"),
          template("runs/{run}/{candidate}", "a run's candidate", "application/json"),
        ],
      };
    });
    low.setRequestHandler("resources/read", async (request) => {
      const uri = request.params.uri;
      try {
        const result = await readTree(await this.project(), uri);
        return { contents: result.contents };
      } catch (error) {
        throw readError(error, uri);
      }
    });
    if (this.legacy) {
      low.setRequestHandler("resources/subscribe", async (request) => {
        this.subscribed.add(canonical(request.params.uri));
        return {};
      });
      low.setRequestHandler("resources/unsubscribe", async (request) => {
        this.subscribed.delete(canonical(request.params.uri));
        return {};
      });
    }
  }

  /** Takes the fingerprint a tool call's changes are compared with. */
  async before(): Promise<void> {
    const project = await this.tryProject();
    this.last = project ? fingerprint(project) : undefined;
  }

  /**
   * Sends `resources/updated` for each address that changed since the last fingerprint, and
   * `resources/list_changed` when the listing changed or `wrote` (a pick or write it served).
   */
  async after(wrote = false): Promise<void> {
    const project = await this.tryProject();
    const now = project ? fingerprint(project) : undefined;
    const was = this.last;
    this.last = now;
    if (!now || !this.server) return;
    const before = was?.addresses ?? new Map<string, string>();
    for (const address of changed(before, now.addresses)) this.updated(address);
    if (wrote || (was !== undefined && was.listing !== now.listing)) {
      this.notify(() => this.server!.server.sendResourceListChanged());
    }
  }

  /** Runs `call` between `before` and `after`; `tool` names it. */
  async around<T>(tool: string, call: (progress: () => void) => Promise<T>, ok: (r: T) => boolean) {
    await this.before();
    let pending: Promise<void> = Promise.resolve();
    const progress = () => {
      pending = pending.then(() => this.after());
    };
    const result = await call(progress);
    await pending;
    await this.after(LIBRARY_WRITERS.has(tool) && ok(result));
    return result;
  }

  private updated(address: string): void {
    const at = parseAddress(address);
    const addresses = [address];
    if (at.segments.length === 1) {
      for (const file of ASSET_FILES) {
        addresses.push(formatAddress(at.game, [at.segments[0]!, ...file.split("/")]));
      }
      addresses.push(formatAddress(at.game, [at.segments[0]!, "versions"], true));
    }
    for (const uri of addresses) {
      if (this.legacy && !this.subscribed.has(uri)) continue;
      this.notify(() => this.server!.server.sendResourceUpdated({ uri }));
    }
  }

  private notify(send: () => Promise<void>): void {
    try {
      send().catch(() => {});
    } catch {
      // The client is gone; the server goes on without it.
    }
  }
}

/** The canonical form of an address a client subscribed to; anything else is kept as sent. */
function canonical(uri: string): string {
  try {
    return canonicalAddress(uri);
  } catch {
    return uri;
  }
}
