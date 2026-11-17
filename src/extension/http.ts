/**
 * The pack's `http` (design section 11): a `fetch` that reaches only the hosts its adapter declares
 * (`fixedHosts`) and the endpoint its settings entry names (`baseURL`, when the adapter takes one).
 * It follows redirects itself and checks every hop's host before requesting it, so a URL the
 * provider steers (a download link in a result, a redirect) cannot send a request anywhere else.
 *
 * It guards provider-steered URLs, not pack code: a pack can still reach the global `fetch` or a
 * socket. A pack's SDK must take this `fetch` (docs/extensions.md#http).
 */
import { ProviderError } from "../errors.ts";

/** At most this many redirects are followed for one request, as the Fetch standard allows. */
const MAX_REDIRECTS = 20;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** The hosts one provider instance may reach: its adapter's fixed hosts and its settings endpoint. */
export function allowedHosts(
  adapter: { fixedHosts: readonly string[]; endpointFromSettings: boolean },
  baseURL?: string,
): string[] {
  const hosts = adapter.fixedHosts.map((h) => h.toLowerCase());
  if (adapter.endpointFromSettings && baseURL !== undefined) {
    try {
      hosts.push(new URL(baseURL).host.toLowerCase());
    } catch {
      // An endpoint that is not a URL admits nothing.
    }
  }
  return [...new Set(hosts)];
}

/** A request to a host the adapter did not declare: exit 4 `provider_error`, never sent. */
export class HostRefusedError extends ProviderError {
  readonly host: string;
  constructor(adapter: string, host: string, hosts: readonly string[], hop: number) {
    super(
      `${adapter} may not reach ${host}${hop > 0 ? ` (redirect ${hop})` : ""}: its declared hosts are ${hosts.join(", ") || "none"}`,
      { providerCode: "host_refused" },
    );
    this.name = "HostRefusedError";
    this.host = host;
  }
}

/**
 * A `fetch` for `adapter` that refuses any URL whose host is not in `hosts`, re-checking every
 * redirect hop. `base` is the fetch it sends through, read at each call (global `fetch` by default).
 */
export function guardedFetch(options: {
  adapter: string;
  hosts: readonly string[];
  base?: () => typeof fetch;
}): typeof fetch {
  const hosts = options.hosts.map((h) => h.toLowerCase());
  const base = options.base ?? (() => globalThis.fetch);
  const check = (url: URL, hop: number): void => {
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new HostRefusedError(options.adapter, url.href, hosts, hop);
    if (!hosts.includes(url.host.toLowerCase()))
      throw new HostRefusedError(options.adapter, url.host, hosts, hop);
  };
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const first = new Request(input, init);
    const mode = init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
    let url = new URL(first.url);
    check(url, 0);
    let method = first.method;
    const headers = new Headers(first.headers);
    let body: ArrayBuffer | undefined = first.body === null ? undefined : await first.arrayBuffer();
    for (let hop = 0; ; hop++) {
      const response = await base()(url, {
        method,
        headers,
        ...(body !== undefined && { body }),
        redirect: "manual",
        signal: first.signal,
      });
      const location = response.headers.get("location");
      if (!REDIRECT.has(response.status) || location === null || mode === "manual") return response;
      if (mode === "error") throw new TypeError(`redirect refused: ${url.href} redirects`);
      if (hop + 1 > MAX_REDIRECTS)
        throw new TypeError(`more than ${MAX_REDIRECTS} redirects from ${first.url}`);
      const next = new URL(location, url);
      check(next, hop + 1);
      await response.body?.cancel();
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        if (method !== "HEAD") method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      }
      // Credentials go no further than the host they were meant for.
      if (next.host !== url.host) {
        headers.delete("authorization");
        headers.delete("cookie");
      }
      url = next;
    }
  };
  return guarded as typeof fetch;
}
