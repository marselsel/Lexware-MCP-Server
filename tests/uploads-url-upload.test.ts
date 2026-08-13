import { describe, expect, it } from "vitest";
import { resolveContentType, resolveDownloadName } from "../src/tools/url-upload.js";

const URL_ = "https://acme.sharepoint.com/personal/beleg.pdf";

describe("resolveDownloadName", () => {
  it("prefers a sanitized model override over everything else", () => {
    expect(resolveDownloadName("Rechnung.pdf", "from-response.pdf", URL_)).toBe("Rechnung.pdf");
  });

  it("falls back to the response filename, then the URL basename, then a fixed default", () => {
    expect(resolveDownloadName(undefined, "from-response.pdf", URL_)).toBe("from-response.pdf");
    expect(resolveDownloadName(undefined, undefined, URL_)).toBe("beleg.pdf");
    // No name anywhere resolvable → the fixed default, never an empty string.
    expect(resolveDownloadName(undefined, undefined, "https://acme.sharepoint.com/")).toBe("download.bin");
  });

  // The bug this pins down (reintroduced from the #34 fetcher, fixed again here): a URL
  // whose path ends in "/" has basename "" — and "" ?? "download.bin" KEEPS the empty
  // string. sanitizeFilename maps "" to undefined, so the ?? chain lands on the default.
  it("never submits an empty filename for a trailing-slash URL", () => {
    for (const u of [
      "https://acme.sharepoint.com/personal/x/",
      "https://acme.sharepoint.com/",
      "https://acme.sharepoint.com",
    ]) {
      const name = resolveDownloadName(undefined, undefined, u);
      expect(name, u).not.toBe("");
      expect(name, u).toBe("download.bin");
    }
  });

  it("runs the model override through sanitizeFilename — path traversal, control chars, over-long", () => {
    // Not exploitable for multipart injection (undici escapes it), but the override must
    // be treated as the trust boundary the ticket flow already treats it as.
    expect(resolveDownloadName("../../../../etc/cron.d/evil.sh", undefined, URL_)).toBe("evil.sh");
    expect(resolveDownloadName("evil\r\ninjected.pdf", undefined, URL_)).toBe("evilinjected.pdf");
    const long = resolveDownloadName(`${"a".repeat(400)}.pdf`, undefined, URL_);
    expect(long.length).toBeLessThanOrEqual(255);
    // An override that sanitizes to nothing falls through to the next candidate.
    expect(resolveDownloadName("  ", "kept.pdf", URL_)).toBe("kept.pdf");
    expect(resolveDownloadName("   ", undefined, URL_)).toBe("beleg.pdf");
  });

  it("percent-decodes and sanitizes the URL basename", () => {
    expect(resolveDownloadName(undefined, undefined, "https://acme.sharepoint.com/Rechnung%20M%C3%BCller.pdf")).toBe(
      "Rechnung Müller.pdf",
    );
    // A path segment that is itself a traversal is reduced to its basename.
    expect(resolveDownloadName(undefined, undefined, "https://acme.sharepoint.com/a/b/..%2F..%2Fpasswd")).toBe("passwd");
    // A lone percent is not valid percent-encoding: degrade to the raw segment, don't throw.
    expect(resolveDownloadName(undefined, undefined, "https://acme.sharepoint.com/100%.pdf")).toBe("100%.pdf");
  });

  it("is total: a malformed URL falls through to the default instead of throwing", () => {
    // The exported contract is "always returns a string, never throws". urlBasename parses
    // the URL only as the last resort, so this can't fire from the tool (url is pre-validated),
    // but the helper must honour its contract for any direct caller.
    expect(() => resolveDownloadName(undefined, undefined, "not a valid url")).not.toThrow();
    expect(resolveDownloadName(undefined, undefined, "not a valid url")).toBe("download.bin");
    // An earlier candidate still wins without the URL being parsed at all.
    expect(resolveDownloadName("real.pdf", undefined, "not a valid url")).toBe("real.pdf");
    expect(resolveDownloadName(undefined, "fromresp.pdf", "://also-bad")).toBe("fromresp.pdf");
  });
});

describe("resolveContentType", () => {
  it("prefers a non-blank override, else the response type", () => {
    expect(resolveContentType("image/png", "application/pdf")).toBe("image/png");
    expect(resolveContentType(undefined, "application/pdf")).toBe("application/pdf");
  });

  it("treats an empty or whitespace override as absent (|| not ??)", () => {
    // The bug: `mimeType ?? fetched.contentType` kept an empty-string override, filing the
    // receipt with a blank content type instead of the response-derived one. `z.string()
    // .optional()` allows "", so this is reachable from the model.
    expect(resolveContentType("", "application/pdf")).toBe("application/pdf");
    expect(resolveContentType("   ", "application/pdf")).toBe("application/pdf");
  });
});
