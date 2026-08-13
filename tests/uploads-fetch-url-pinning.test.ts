import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wiring test for the third SSRF layer: proves `fetchRemoteFile` hands the addresses
 * it just vetted to the connection, instead of letting the HTTP client resolve the host
 * a second time.
 *
 * In its own file because it mocks the transport module, and the rest of the fetch-url
 * suite deliberately exercises the real guards. The guarantee inside the transport is
 * tested for real in `uploads-pinned-fetch.test.ts`; what is checked here is only that
 * the two halves are connected — the exact seam a refactor could quietly unhook,
 * restoring the DNS-rebinding TOCTOU with every other test still green.
 */
const createPinnedFetch = vi.hoisted(() => vi.fn());

vi.mock("../src/uploads/pinned-fetch.js", () => ({ createPinnedFetch }));

const { fetchRemoteFile } = await import("../src/uploads/fetch-url.js");

/** A body-less 200 the fetcher will accept. */
function okResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "application/pdf", "content-length": "3" },
  });
}

describe("fetchRemoteFile connection pinning", () => {
  beforeEach(() => {
    createPinnedFetch.mockReset();
    createPinnedFetch.mockReturnValue(async () => okResponse());
  });

  it("builds the connection from the SAME lookup result the address check approved", async () => {
    const lookup = vi.fn(async () => ["203.0.113.7", "2001:db8::1"]);

    await fetchRemoteFile("https://acme.sharepoint.com/x.pdf", { lookup });

    // One lookup for the hop, and its result — not the hostname alone — is what the
    // transport is built from. A second resolution is what this design removes.
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(createPinnedFetch).toHaveBeenCalledTimes(1);
    expect(createPinnedFetch).toHaveBeenCalledWith("acme.sharepoint.com", [
      "203.0.113.7",
      "2001:db8::1",
    ]);
  });

  it("re-pins on a redirect, to the new host's own vetted addresses", async () => {
    const lookup = vi.fn(async (host: string) =>
      host === "acme.sharepoint.com" ? ["203.0.113.7"] : ["198.51.100.9"],
    );
    createPinnedFetch
      .mockReturnValueOnce(async () => new Response(null, { status: 302, headers: { location: "https://acme-my.sharepoint.com/y.pdf" } }))
      .mockReturnValueOnce(async () => okResponse());

    await fetchRemoteFile("https://acme.sharepoint.com/x.pdf", { lookup });

    expect(createPinnedFetch.mock.calls).toEqual([
      ["acme.sharepoint.com", ["203.0.113.7"]],
      ["acme-my.sharepoint.com", ["198.51.100.9"]],
    ]);
  });

  it("never reaches the transport when an address fails the range check", async () => {
    const lookup = vi.fn(async () => ["203.0.113.7", "169.254.169.254"]);

    await expect(fetchRemoteFile("https://acme.sharepoint.com/x.pdf", { lookup })).rejects.toThrow(
      /Target address is not allowed/,
    );
    expect(createPinnedFetch).not.toHaveBeenCalled();
  });

  it("never reaches the transport when the host is off the allowlist", async () => {
    const lookup = vi.fn(async () => ["203.0.113.7"]);

    await expect(fetchRemoteFile("https://evil.example.com/x.pdf", { lookup })).rejects.toThrow(
      /is not allowed/,
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(createPinnedFetch).not.toHaveBeenCalled();
  });
});
