import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExtractError } from "@/lib/extract/errors";
import { assertSafeUrl, isBlockedAddress, safeFetch, type Resolver } from "@/lib/extract/ssrf";

async function reasonOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ExtractError) return { reason: err.reason, detail: err.detail ?? "" };
    throw err;
  }
  throw new Error("expected rejection");
}

function reasonOfSync(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    if (err instanceof ExtractError) return err.reason;
    throw err;
  }
  return "allowed";
}

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "198.18.0.1",
    "::1",
    "::",
    "fe80::1",
    "fe80::1%eth0",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "::127.0.0.1",
    "2002:7f00:1::1", // 6to4 wrapping 127.0.0.1
    "2002:a9fe:a9fe::1", // 6to4 wrapping 169.254.169.254
    "64:ff9b::a00:1", // NAT64
    "2001:db8::1",
    "2001::1", // Teredo
    "not-an-ip",
    "",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows public %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
});

describe("assertSafeUrl", () => {
  it.each([
    ["http://localhost/", "localhost"],
    ["http://LOCALHOST./", "localhost with trailing dot"],
    ["http://app.localhost/", "*.localhost"],
    ["http://printer.local/", "mDNS .local"],
    ["http://metadata.google.internal/", ".internal"],
    ["http://intranet/", "single-label host"],
    ["http://127.0.0.1/", "loopback literal"],
    ["http://2130706433/", "decimal-encoded 127.0.0.1"],
    ["http://0x7f.0.0.1/", "hex-encoded 127.0.0.1"],
    ["http://127.1/", "short-form 127.0.0.1"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"],
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://10.0.0.1/", "private 10/8"],
    ["http://192.168.0.1/", "private 192.168/16"],
    ["http://172.20.1.1/", "private 172.16/12"],
    ["http://0.0.0.0/", "0.0.0.0"],
    ["file:///etc/passwd", "file scheme"],
    ["ftp://example.com/", "ftp scheme"],
    ["gopher://example.com/", "gopher scheme"],
    ["javascript:alert(1)", "javascript scheme"],
    ["data:text/html,hi", "data scheme"],
    ["http://user:pass@example.com/", "credentials"],
    ["http://example.com:8080/", "non-standard port"],
    ["https://example.com:22/", "ssh port"],
  ])("rejects %s (%s)", (url) => {
    expect(reasonOfSync(() => assertSafeUrl(url))).toBe("blocked_address");
  });

  it.each(["https://example.com/", "http://example.com/", "https://shop.example.co.uk/about", "https://8.8.8.8/"])(
    "accepts %s",
    (url) => {
      expect(reasonOfSync(() => assertSafeUrl(url))).toBe("allowed");
    },
  );
});

describe("safeFetch DNS checks", () => {
  const resolver =
    (map: Record<string, string[]>): Resolver =>
    async (host) =>
      (map[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it("rejects a hostname that resolves to a private IP", async () => {
    const r = await reasonOf(safeFetch("http://evil.test/", { resolver: resolver({ "evil.test": ["10.0.0.5"] }) }));
    expect(r.reason).toBe("blocked_address");
    expect(r.detail).toContain("10.0.0.5");
  });

  it("rejects a hostname that resolves to the metadata IP", async () => {
    const r = await reasonOf(
      safeFetch("http://meta.test/", { resolver: resolver({ "meta.test": ["169.254.169.254"] }) }),
    );
    expect(r.reason).toBe("blocked_address");
  });

  it("rejects when ANY resolved address is private (mixed public + private)", async () => {
    const r = await reasonOf(
      safeFetch("http://mixed.test/", { resolver: resolver({ "mixed.test": ["93.184.216.34", "127.0.0.1"] }) }),
    );
    expect(r.reason).toBe("blocked_address");
  });

  it("rejects a hostname that resolves to IPv6 loopback", async () => {
    const r = await reasonOf(safeFetch("http://v6.test/", { resolver: resolver({ "v6.test": ["::1"] }) }));
    expect(r.reason).toBe("blocked_address");
  });

  it("reports an unresolvable host as unreachable, not blocked", async () => {
    const r = await reasonOf(safeFetch("http://nothing.test/", { resolver: resolver({}) }));
    expect(r.reason).toBe("site_unreachable");
  });

  // Uses real DNS: localtest.me is a public domain pointing at loopback (127.0.0.1 / ::1).
  it.runIf(process.env.NETWORK_TESTS)("rejects a real public domain that resolves to loopback", async () => {
    const r = await reasonOf(safeFetch("http://localtest.me/"));
    expect(r.reason).toBe("blocked_address");
    expect(r.detail).toMatch(/resolved to (127.0.0.1|::1)/);
  });
});

describe("safeFetch against a local server", () => {
  let server: http.Server;
  let port: number;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      const redirect = (to: string) => res.writeHead(302, { location: to }).end();
      switch (req.url) {
        case "/ok":
          return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h1>Hello</h1>");
        case "/to-private-ip":
          return redirect("http://10.0.0.1/");
        case "/to-metadata-host":
          return redirect("http://metadata.test/latest/meta-data/");
        case "/to-localhost":
          return redirect(`http://localhost:${port}/ok`);
        case "/to-file":
          return redirect("file:///etc/passwd");
        case "/to-relative":
          return redirect("/ok");
        case "/loop":
          return redirect("/loop");
        case "/slow":
          return; // never respond
        case "/big":
          res.writeHead(200, { "content-type": "text/html" });
          return res.end("x".repeat(3_000_000));
        case "/gzip":
          res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
          return res.end(zlib.gzipSync("<p>compressed</p>"));
        default:
          return res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  // "public.test" stands in for a real public site. Only 127.0.0.1 is exempted
  // from the private-range check (so we can reach the test server); every
  // other private address is still blocked.
  const opts = () => ({
    resolver: async (host: string) =>
      host === "public.test"
        ? [{ address: "127.0.0.1", family: 4 }]
        : host === "metadata.test"
          ? [{ address: "169.254.169.254", family: 4 }]
          : [],
    isAddressAllowed: (ip: string) => ip === "127.0.0.1" || !isBlockedAddress(ip),
    allowedPorts: [80, 443, port],
  });
  const url = (path: string) => `http://public.test:${port}${path}`;

  it("fetches a normal page", async () => {
    const res = await safeFetch(url("/ok"), opts());
    expect(res.status).toBe(200);
    expect(res.body).toContain("Hello");
  });

  it("follows a same-host relative redirect and reports the final URL", async () => {
    const res = await safeFetch(url("/to-relative"), opts());
    expect(res.url).toBe(url("/ok"));
  });

  it("blocks a redirect to a private IP literal", async () => {
    expect((await reasonOf(safeFetch(url("/to-private-ip"), opts()))).reason).toBe("blocked_address");
  });

  it("blocks a redirect to a hostname that resolves to the metadata IP", async () => {
    const r = await reasonOf(safeFetch(url("/to-metadata-host"), opts()));
    expect(r.reason).toBe("blocked_address");
    expect(r.detail).toContain("169.254.169.254");
  });

  it("blocks a redirect to localhost", async () => {
    expect((await reasonOf(safeFetch(url("/to-localhost"), opts()))).reason).toBe("blocked_address");
  });

  it("blocks a redirect to a file:// URL", async () => {
    expect((await reasonOf(safeFetch(url("/to-file"), opts()))).reason).toBe("blocked_address");
  });

  it("caps the number of redirects", async () => {
    hits.length = 0;
    const r = await reasonOf(safeFetch(url("/loop"), { ...opts(), maxRedirects: 3 }));
    expect(r.reason).toBe("site_unreachable");
    expect(r.detail).toContain("redirects");
    expect(hits.filter((h) => h === "/loop")).toHaveLength(4); // first request + 3 redirects
  });

  it("times out a server that never responds", async () => {
    const started = Date.now();
    const r = await reasonOf(safeFetch(url("/slow"), { ...opts(), timeoutMs: 300 }));
    expect(r.reason).toBe("fetch_timeout");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("stops reading at maxBytes", async () => {
    const res = await safeFetch(url("/big"), { ...opts(), maxBytes: 1_500_000 });
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(1_500_000);
  });

  it("decompresses gzip bodies", async () => {
    const res = await safeFetch(url("/gzip"), opts());
    expect(res.body).toContain("compressed");
  });

  it("without the test exemption, the loopback test server itself is blocked", async () => {
    const r = await reasonOf(safeFetch(url("/ok"), { ...opts(), isAddressAllowed: undefined }));
    expect(r.reason).toBe("blocked_address");
  });
});
