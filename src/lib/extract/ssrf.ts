import "server-only";

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { ExtractError } from "./errors";

/*
 * SSRF-safe HTTP GET for fetching user-supplied URLs.
 *
 * - Only http/https, only ports 80/443, no credentials in the URL.
 * - Hostnames like localhost / *.local / single-label names are refused.
 * - IP checks run inside the socket's own DNS `lookup` hook, so the address
 *   that is validated is exactly the address that is connected to (no DNS
 *   rebinding window between "check" and "connect"). Every resolved address
 *   must be public, not just the first.
 * - Redirects are followed manually (capped), and every hop is re-checked.
 * - One overall deadline for the whole chain, and a cap on bytes read
 *   (after decompression, so compressed bombs are bounded too).
 */

export type ResolvedAddress = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type SafeFetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Test seams — production code uses the defaults. */
  resolver?: Resolver;
  isAddressAllowed?: (ip: string) => boolean;
  allowedPorts?: number[];
};

export type SafeResponse = {
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
};

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const DEFAULTS = {
  timeoutMs: 10_000,
  maxBytes: 1_500_000,
  maxRedirects: 4,
  allowedPorts: [80, 443],
};

// --- address classification ----------------------------------------------

const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata 169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function v4ToInt(ip: string) {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}

function isBlockedV4(ip: string) {
  const n = v4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

function intToV4(hi: number, lo: number) {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

/** Expands an IPv6 address into its 8 16-bit groups. */
function parseV6(ip: string): number[] | null {
  let s = ip.split("%")[0]; // drop zone id
  const v4Tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail) {
    if (!net.isIPv4(v4Tail[2])) return null;
    const n = v4ToInt(v4Tail[2]);
    s = `${v4Tail[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isBlockedV6(ip: string) {
  const g = parseV6(ip);
  if (!g) return true;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);

  // ::ffff:a.b.c.d (IPv4-mapped) — judge by the embedded IPv4 address.
  if (zeros(0, 5) && g[5] === 0xffff) return isBlockedV4(intToV4(g[6], g[7]));
  // ::, ::1 and deprecated IPv4-compatible ::a.b.c.d
  if (zeros(0, 6)) return true;
  // 6to4 (2002::/16) embeds an IPv4 address.
  if (g[0] === 0x2002) return isBlockedV4(intToV4(g[1], g[2]));
  // NAT64 (64:ff9b::/32) — could translate to anything; refuse.
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;
  // 2001::/23 — Teredo, ORCHID, benchmarking and other IETF special-use.
  if (g[0] === 0x2001 && g[1] < 0x200) return true;
  // 2001:db8::/32 documentation.
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  // Anything outside global unicast 2000::/3 (covers fc00::/7 ULA,
  // fe80::/10 link-local, ff00::/8 multicast, 100::/64 discard, etc.).
  return (g[0] & 0xe000) !== 0x2000;
}

/** True if `ip` is not a publicly routable unicast address. Non-IPs are blocked. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  if (net.isIPv4(bare)) return isBlockedV4(bare);
  if (net.isIPv6(bare)) return isBlockedV6(bare);
  return true;
}

// --- URL checks -----------------------------------------------------------

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".home.arpa", ".lan", ".intranet"];

type UrlCheckOptions = Pick<Required<SafeFetchOptions>, "isAddressAllowed" | "allowedPorts">;

/** Validates scheme, credentials, port and host; returns the parsed URL. */
export function assertSafeUrl(input: string | URL, opts?: Partial<UrlCheckOptions>): URL {
  const isAddressAllowed = opts?.isAddressAllowed ?? ((ip: string) => !isBlockedAddress(ip));
  const allowedPorts = opts?.allowedPorts ?? DEFAULTS.allowedPorts;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ExtractError("invalid_input", "unparseable URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExtractError("blocked_address", `scheme ${url.protocol} not allowed`);
  }
  if (url.username || url.password) {
    throw new ExtractError("blocked_address", "credentials in URL");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!allowedPorts.includes(port)) {
    throw new ExtractError("blocked_address", `port ${port} not allowed`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (net.isIP(host)) {
    if (!isAddressAllowed(host)) throw new ExtractError("blocked_address", `address ${host}`);
    return url;
  }
  if (
    host === "localhost" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    !host.includes(".")
  ) {
    throw new ExtractError("blocked_address", `host ${host}`);
  }
  return url;
}

// --- fetching -------------------------------------------------------------

const defaultResolver: Resolver = async (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

function guardedLookup(resolver: Resolver, isAddressAllowed: (ip: string) => boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname)
      .then((addresses) => {
        if (addresses.length === 0) {
          throw Object.assign(new Error(`no addresses for ${hostname}`), { code: "ENOTFOUND" });
        }
        const bad = addresses.find((a) => !isAddressAllowed(a.address));
        if (bad) {
          throw new ExtractError("blocked_address", `${hostname} resolved to ${bad.address}`);
        }
        if (options.all) {
          callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      })
      .catch((err) => callback(err, "", 0));
  };
}

type RawResponse = {
  status: number;
  contentType: string;
  location?: string;
  body?: Buffer;
  truncated?: boolean;
};

function requestOnce(
  url: URL,
  { signal, lookup, maxBytes }: { signal: AbortSignal; lookup: net.LookupFunction; maxBytes: number },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: "GET",
        signal,
        lookup,
        agent: false,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-language": "en-US,en;q=0.9",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "");

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, contentType, location: res.headers.location });
          return;
        }

        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream: NodeJS.ReadableStream =
          encoding === "gzip" || encoding === "x-gzip" || encoding === "deflate"
            ? res.pipe(zlib.createUnzip())
            : encoding === "br"
              ? res.pipe(zlib.createBrotliDecompress())
              : res;

        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          if (size + chunk.length > maxBytes) {
            chunks.push(chunk.subarray(0, maxBytes - size));
            resolve({ status, contentType, body: Buffer.concat(chunks), truncated: true });
            req.destroy();
            return;
          }
          size += chunk.length;
          chunks.push(chunk);
        });
        stream.on("end", () => resolve({ status, contentType, body: Buffer.concat(chunks) }));
        stream.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function decode(body: Buffer, contentType: string) {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

const UNREACHABLE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPROTO",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
]);

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const isAddressAllowed = options.isAddressAllowed ?? ((ip: string) => !isBlockedAddress(ip));
  const allowedPorts = options.allowedPorts ?? DEFAULTS.allowedPorts;
  const lookup = guardedLookup(options.resolver ?? defaultResolver, isAddressAllowed);
  const signal = AbortSignal.timeout(timeoutMs);

  let url = assertSafeUrl(rawUrl, { isAddressAllowed, allowedPorts });

  try {
    for (let hop = 0; ; hop++) {
      const res = await requestOnce(url, { signal, lookup, maxBytes });

      if (res.location !== undefined) {
        if (hop >= maxRedirects) {
          throw new ExtractError("site_unreachable", `more than ${maxRedirects} redirects`);
        }
        let next: URL;
        try {
          next = new URL(res.location, url);
        } catch {
          throw new ExtractError("site_unreachable", `bad redirect location ${res.location}`);
        }
        url = assertSafeUrl(next, { isAddressAllowed, allowedPorts });
        continue;
      }

      return {
        url: url.href,
        status: res.status,
        contentType: res.contentType,
        body: decode(res.body ?? Buffer.alloc(0), res.contentType),
        truncated: res.truncated ?? false,
      };
    }
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    if (signal.aborted) throw new ExtractError("fetch_timeout", `${url.host} after ${timeoutMs}ms`);
    const code = (err as NodeJS.ErrnoException).code;
    if (code && UNREACHABLE_CODES.has(code)) {
      throw new ExtractError("site_unreachable", `${code} for ${url.host}`);
    }
    throw new ExtractError("site_unreachable", (err as Error).message);
  }
}
