import { describe, expect, it } from "vitest";
import { isMcpPath, isUploadPath } from "../src/server-body-parsing.js";

describe("isMcpPath", () => {
  it("matches the lowercase path and its subpaths", () => {
    expect(isMcpPath("/mcp")).toBe(true);
    expect(isMcpPath("/mcp/")).toBe(true);
    expect(isMcpPath("/mcp/some/nested/path")).toBe(true);
  });

  it("matches any casing, because Express routes case-insensitively by default", () => {
    // Regression: an earlier version compared case-sensitively, so an uppercase
    // request WAS routed to the real /mcp handler (Express's own default) but
    // NOT recognized here — the global JSON parser stayed in front of it,
    // silently truncating the raised /mcp body limit for that spelling.
    expect(isMcpPath("/MCP")).toBe(true);
    expect(isMcpPath("/Mcp/tools")).toBe(true);
    expect(isMcpPath("/mCp")).toBe(true);
  });

  it("does not match an unrelated path, including one that merely starts with the same letters", () => {
    expect(isMcpPath("/mcpx")).toBe(false);
    expect(isMcpPath("/status")).toBe(false);
    expect(isMcpPath("/")).toBe(false);
  });
});

describe("isUploadPath", () => {
  it("matches the lowercase path and its subpaths", () => {
    expect(isUploadPath("/upload")).toBe(true);
    expect(isUploadPath("/upload/")).toBe(true);
    expect(isUploadPath("/upload/abc123")).toBe(true);
  });

  it("matches any casing, because Express routes case-insensitively by default", () => {
    // Regression (Fix-Runde 2, "Minor"): POST /UPLOAD/<ticket> WAS routed to the
    // real upload handler by Express, but this predicate said "not an upload
    // path" and let the global ~100 KB JSON parser run first instead of being
    // skipped — reopening a bounded slice of the Critical-2 gzip-amplification
    // path up to that parser's own limit.
    expect(isUploadPath("/UPLOAD/abc123")).toBe(true);
    expect(isUploadPath("/Upload/abc123")).toBe(true);
    expect(isUploadPath("/UPLOAD")).toBe(true);
  });

  it("does not match an unrelated path, including one that merely starts with the same letters", () => {
    expect(isUploadPath("/uploads")).toBe(false);
    expect(isUploadPath("/status")).toBe(false);
    expect(isUploadPath("/")).toBe(false);
  });
});
