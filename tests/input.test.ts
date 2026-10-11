import { describe, expect, it } from "vitest";
import { classifyInput } from "@/lib/extract/input";

describe("classifyInput", () => {
  it.each([
    ["example.com", "https://example.com/", true],
    ["www.example.com", "https://www.example.com/", true],
    ["  Example.com  ", "https://example.com/", true],
    ["http://example.com", "http://example.com/", true],
    ["https://shop.example.com/products/dog-toy", "https://shop.example.com/products/dog-toy", false],
    ["example.com/?ref=ig", "https://example.com/?ref=ig", false],
  ])("treats %j as a website", (input, href, bare) => {
    const r = classifyInput(input);
    expect(r.kind).toBe("website");
    if (r.kind === "website") {
      expect(r.url.href).toBe(href);
      expect(r.isBareDomain).toBe(bare);
    }
  });

  it.each([
    ["@pawsco", "pawsco", ["instagram", "tiktok"]],
    ["@paws.co_1", "paws.co_1", ["instagram", "tiktok"]],
    ["instagram.com/pawsco", "pawsco", ["instagram"]],
    ["https://www.instagram.com/pawsco/?hl=en", "pawsco", ["instagram"]],
    ["https://tiktok.com/@pawsco", "pawsco", ["tiktok"]],
    ["www.tiktok.com/@pawsco/video/123", "pawsco", ["tiktok"]],
  ])("treats %j as a social profile", (input, handle, platforms) => {
    expect(classifyInput(input)).toEqual({ kind: "social", handle, platforms });
  });

  it.each([
    "",
    "   ",
    "my store",
    "mystore",
    "@",
    "@bad handle",
    "@way_too_long_handle_for_instagram_x",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://example.com",
    "gopher://example.com",
    "https://instagram.com/",
    "https://instagram.com/p/abc123",
    "https://www.tiktok.com/foryou",
    "x".repeat(2049),
  ])("rejects %j", (input) => {
    expect(classifyInput(input).kind).toBe("invalid");
  });

  // Address safety is the SSRF guard's job; classification passes these
  // through as websites so the guard can reject them with blocked_address.
  it.each(["localhost.localdomain", "127.0.0.1", "169.254.169.254"])("defers %j to the SSRF guard", (input) => {
    expect(classifyInput(input).kind).toBe("website");
  });
});
