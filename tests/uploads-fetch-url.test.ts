import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOWED_HOSTS,
  fetchRemoteFile,
  isAllowedHost,
  isBlockedAddress,
} from "../src/uploads/fetch-url.js";

describe("isBlockedAddress", () => {
  it("blocks loopback, private and link-local ranges", () => {
    for (const ip of [
      "127.0.0.1", "127.53.1.9", "::1",
      "10.0.0.5", "172.16.4.2", "172.31.255.255", "192.168.1.1",
      "169.254.169.254", "fe80::1", "fc00::1", "fd12::9",
      "0.0.0.0",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700::1111"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  // Regression coverage for Critical review finding: isBlockedAddress previously failed
  // OPEN on anything it could not parse as a plain dotted-quad or a small set of string
  // prefixes. All of these are real, routable spellings of loopback/link-local addresses
  // that were measured as NOT blocked before this fix.
  it("blocks non-canonical IPv4-in-IPv6 spellings (hex-form mapped, expanded, deprecated-compatible) and fails closed on unparseable input", () => {
    for (const ip of [
      "::ffff:7f00:1", // 127.0.0.1, mapped, hex form (not dotted)
      "::FFFF:7F00:1", // same, uppercase
      "0:0:0:0:0:ffff:127.0.0.1", // 127.0.0.1, mapped, fully expanded + dotted tail
      "::ffff:a9fe:a9fe", // 169.254.169.254, mapped, hex form
      "::127.0.0.1", // 127.0.0.1, deprecated IPv4-compatible form
      "0:0:0:0:0:0:0:1", // ::1 fully expanded
      "", // empty string must fail closed, not fail open
    ]) {
      expect(isBlockedAddress(ip), JSON.stringify(ip)).toBe(true);
    }
  });

  it("blocks the additionally required ranges: CGNAT, IETF protocol assignment, benchmarking, multicast, reserved/broadcast, 6to4, NAT64 and deprecated site-local", () => {
    for (const ip of [
      "100.64.0.1", "100.127.255.255", // 100.64.0.0/10 (CGNAT)
      "192.0.0.5", // 192.0.0.0/24 (IETF protocol assignments)
      "198.18.0.1", "198.19.255.255", // 198.18.0.0/15 (benchmarking)
      "224.0.0.1", "239.255.255.255", // 224.0.0.0/4 (multicast)
      "240.0.0.1", "255.255.255.255", // 240.0.0.0/4 (reserved, incl. broadcast)
      "fec0::1", // fec0::/10 (deprecated site-local)
      "64:ff9b::808:808", // 64:ff9b::/96 (NAT64 well-known prefix)
      "2002:c000:0204::", // 2002::/16 (6to4)
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });
});

describe("isAllowedHost", () => {
  it("matches an exact configured host and a subdomain of it", () => {
    expect(isAllowedHost("sharepoint.com", DEFAULT_ALLOWED_HOSTS)).toBe(true);
    expect(isAllowedHost("foo.sharepoint.com", DEFAULT_ALLOWED_HOSTS)).toBe(true);
    expect(isAllowedHost("contoso.sharepoint.com", DEFAULT_ALLOWED_HOSTS)).toBe(true);
  });

  it("does not match a lookalike domain that merely shares a suffix without a dot boundary", () => {
    expect(isAllowedHost("evilsharepoint.com", DEFAULT_ALLOWED_HOSTS)).toBe(false);
    expect(isAllowedHost("sharepoint.com.evil.com", DEFAULT_ALLOWED_HOSTS)).toBe(false);
    expect(isAllowedHost("not-allowed.example.com", DEFAULT_ALLOWED_HOSTS)).toBe(false);
  });

  it("is case-insensitive and strips a trailing root-label dot", () => {
    expect(isAllowedHost("FOO.SharePoint.COM", DEFAULT_ALLOWED_HOSTS)).toBe(true);
    expect(isAllowedHost("sharepoint.com.", DEFAULT_ALLOWED_HOSTS)).toBe(true);
  });

  it("a configured list replaces the defaults instead of extending them", () => {
    // LEXWARE_UPLOAD_ALLOWED_HOSTS must be able to opt OUT of the built-in hosts,
    // otherwise a self-hosted server can never stop trusting Microsoft's domains.
    const custom = ["files.example.com"];
    expect(isAllowedHost("files.example.com", custom)).toBe(true);
    expect(isAllowedHost("sharepoint.com", custom)).toBe(false);
    expect(isAllowedHost("contoso.sharepoint.com", custom)).toBe(false);
  });

  it("an empty list blocks everything (fail closed, never allow-all)", () => {
    expect(isAllowedHost("sharepoint.com", [])).toBe(false);
    expect(isAllowedHost("files.example.com", [])).toBe(false);
    // A list of only blanks is the same as empty, not a wildcard.
    expect(isAllowedHost("sharepoint.com", ["", "  "])).toBe(false);
  });
});

describe("fetchRemoteFile", () => {
  const publicLookup = async () => ["93.184.216.34"];

  it("rejects non-https schemes", async () => {
    await expect(fetchRemoteFile("file:///etc/passwd", { lookup: publicLookup })).rejects.toThrow(/scheme/i);
  });

  it("rejects plain http, even on an allow-listed host", async () => {
    await expect(fetchRemoteFile("http://foo.sharepoint.com/x.pdf", { lookup: publicLookup })).rejects.toThrow(
      /scheme/i,
    );
  });

  it("rejects a redirect from https down to http", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response(null, { status: 302, headers: { location: "http://foo.sharepoint.com/downgraded.pdf" } });
    }) as unknown as typeof fetch;
    await expect(
      fetchRemoteFile("https://foo.sharepoint.com/start.pdf", { lookup: publicLookup, fetchImpl }),
    ).rejects.toThrow(/scheme/i);
    expect(seen).toHaveLength(1);
  });

  it("rejects a host that is not on the allowlist", async () => {
    await expect(
      fetchRemoteFile("https://not-allowed.example.com/x.pdf", { lookup: publicLookup }),
    ).rejects.toThrow(/not allowed/i);
  });

  it("allows a host on the default allowlist through", async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })) as unknown as typeof fetch;
    const out = await fetchRemoteFile("https://foo.sharepoint.com/x.pdf", { lookup: publicLookup, fetchImpl });
    expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
  });

  it("an explicitly empty allowlist blocks a default host (`??`, not `||`)", async () => {
    // Guards the operator's kill switch: `opts.allowedHosts || DEFAULT_ALLOWED_HOSTS`
    // would silently fall back to the Microsoft defaults for an empty array and quietly
    // re-enable a feature the operator disabled.
    await expect(
      fetchRemoteFile("https://foo.sharepoint.com/x.pdf", { lookup: publicLookup, allowedHosts: [] }),
    ).rejects.toThrow(/not allowed/i);
  });

  // Same scenario as the original brief test, adapted for the allowlist-first model:
  // the allowlist is now checked first, so a host must be explicitly permitted for this
  // test to actually exercise the IP layer (defense in depth) rather than being rejected
  // one layer earlier for an unrelated reason.
  it("rejects a host that resolves to a private address, even when it is allowlisted (defense in depth)", async () => {
    await expect(
      fetchRemoteFile("https://internal.example.com/x.pdf", {
        lookup: async () => ["10.1.2.3"],
        allowedHosts: ["internal.example.com"],
      }),
    ).rejects.toThrow(/not allowed/i);
  });

  // Same DNS-rebinding scenario as the original brief test. ok.example.com and the literal
  // metadata IP are explicitly allowlisted here so the test isolates the IP-layer re-check
  // (this is what stops the rebinding attack), rather than the redirect being rejected one
  // layer earlier by the host allowlist.
  // Both hops use https and both hosts are allowlisted, so neither the scheme check nor
  // the host allowlist can be what stops this — only the per-hop IP re-check can. The
  // assertion targets the IP layer's specific message (not the generic /not allowed/i,
  // which also matches the scheme-rejection and host-allowlist-rejection strings and so
  // would pass even with the IP check deleted — see the mutation note in the task report).
  it("re-checks the address after a redirect, even when the redirect target is https and allowlisted", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      seen.push(u);
      if (u.endsWith("/start.pdf")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://internal.example.com/latest/meta-data" },
        });
      }
      return new Response("should never be reached", { status: 200 });
    }) as unknown as typeof fetch;
    const lookup = async (host: string) =>
      host === "internal.example.com" ? ["169.254.169.254"] : ["93.184.216.34"];
    await expect(
      fetchRemoteFile("https://ok.example.com/start.pdf", {
        lookup,
        fetchImpl,
        allowedHosts: ["ok.example.com", "internal.example.com"],
      }),
    ).rejects.toThrow(/private, loopback or link-local/i);
    expect(seen).toHaveLength(1);
  });

  it("rejects a redirect from an allowlisted host to a host that is not allowlisted, before the second request goes out", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response(null, { status: 302, headers: { location: "https://evil.example.com/payload" } });
    }) as unknown as typeof fetch;
    await expect(
      fetchRemoteFile("https://foo.sharepoint.com/start.pdf", { lookup: publicLookup, fetchImpl }),
    ).rejects.toThrow(/not allowed/i);
    expect(seen).toHaveLength(1);
  });

  it("stops after the redirect limit", async () => {
    const fetchImpl = (async (url: string | URL) =>
      new Response(null, { status: 302, headers: { location: `https://ok.example.com/${Math.random()}` } })) as unknown as typeof fetch;
    await expect(
      fetchRemoteFile("https://ok.example.com/a", {
        lookup: publicLookup,
        fetchImpl,
        maxRedirects: 3,
        allowedHosts: ["ok.example.com"],
      }),
    ).rejects.toThrow(/redirect/i);
  });

  it("enforces the default redirect limit of 3 when maxRedirects is not given", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://ok.example.com/next" } });
    }) as unknown as typeof fetch;
    await expect(
      fetchRemoteFile("https://ok.example.com/a", {
        lookup: publicLookup,
        fetchImpl,
        allowedHosts: ["ok.example.com"],
      }),
    ).rejects.toThrow(/redirect/i);
    // hops 0..3 inclusive = DEFAULT_MAX_REDIRECTS (3) + 1 attempts.
    expect(calls).toBe(4);
  });

  it("rejects a body larger than maxBytes", async () => {
    const big = new Uint8Array(1024);
    const fetchImpl = (async () =>
      new Response(big, { status: 200, headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;
    await expect(
      fetchRemoteFile("https://ok.example.com/big.pdf", {
        lookup: publicLookup,
        fetchImpl,
        maxBytes: 100,
        allowedHosts: ["ok.example.com"],
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("enforces the default maxBytes of 20 MiB via content-length when maxBytes is not given", async () => {
    const tooLarge = 20 * 1024 * 1024 + 1;
    const fetchImpl = (async () =>
      new Response(new Uint8Array(0), {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": String(tooLarge) },
      })) as unknown as typeof fetch;
    await expect(
      fetchRemoteFile("https://ok.example.com/huge.pdf", {
        lookup: publicLookup,
        fetchImpl,
        allowedHosts: ["ok.example.com"],
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("aborts a streamed body without a truthful content-length once maxBytes is exceeded, without reading it fully", async () => {
    const chunkSize = 1024;
    const totalChunks = 100; // 100 * 1024 = 102400 bytes if the whole stream were drained
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= totalChunks) {
          controller.close();
          return;
        }
        pulled++;
        controller.enqueue(new Uint8Array(chunkSize));
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, { status: 200, headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;
    await expect(
      fetchRemoteFile("https://ok.example.com/big.pdf", {
        lookup: publicLookup,
        fetchImpl,
        maxBytes: 2048,
        allowedHosts: ["ok.example.com"],
      }),
    ).rejects.toThrow(/too large/i);
    // Proof it stopped streaming early rather than buffering the whole body first.
    expect(pulled).toBeLessThan(totalChunks);
  });

  it("applies the timeout globally across multiple redirects, not per hop", async () => {
    let hopCount = 0;
    const fetchImpl = ((_url: string | URL, init?: { signal?: AbortSignal }) => {
      hopCount++;
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        const t = setTimeout(() => {
          resolve(
            new Response(null, {
              status: 302,
              headers: { location: `https://ok.example.com/hop-${hopCount}` },
            }),
          );
        }, 8);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }) as unknown as typeof fetch;

    await expect(
      fetchRemoteFile("https://ok.example.com/start", {
        lookup: publicLookup,
        fetchImpl,
        allowedHosts: ["ok.example.com"],
        timeoutMs: 40,
        maxRedirects: 100,
      }),
    ).rejects.toThrow(/abort/i);
    // If the timeout were reset on every hop instead of being global, all 101 attempts
    // (maxRedirects=100 + 1) would run to completion and the call would fail with "too
    // many redirects" instead of aborting on elapsed time.
    expect(hopCount).toBeLessThan(100);
  });

  it("returns bytes, content type and filename from content-disposition", async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="beleg-2026.pdf"',
        },
      })) as unknown as typeof fetch;
    const out = await fetchRemoteFile("https://ok.example.com/x", {
      lookup: publicLookup,
      fetchImpl,
      allowedHosts: ["ok.example.com"],
    });
    expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
    expect(out.contentType).toBe("application/pdf");
    expect(out.filename).toBe("beleg-2026.pdf");
  });

  it("does not fail on a plain filename containing a literal percent sign", async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="100% Rabatt.pdf"',
        },
      })) as unknown as typeof fetch;
    const out = await fetchRemoteFile("https://ok.example.com/x", {
      lookup: publicLookup,
      fetchImpl,
      allowedHosts: ["ok.example.com"],
    });
    expect(out.filename).toBe("100% Rabatt.pdf");
  });

  it("prefers the RFC 5987 extended filename* over the plain filename and decodes it", async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''beleg%20zwei.pdf",
        },
      })) as unknown as typeof fetch;
    const out = await fetchRemoteFile("https://ok.example.com/x", {
      lookup: publicLookup,
      fetchImpl,
      allowedHosts: ["ok.example.com"],
    });
    expect(out.filename).toBe("beleg zwei.pdf");
  });

  it("strips the RFC 5987 language tag from filename* instead of gluing it onto the name", async () => {
    // The extended-value grammar is charset'language'value, and the language
    // part is optional but routinely set by German servers. Matching
    // only the literal `UTF-8''` prefix left `UTF-8'de'` in front of the name and
    // filed the receipt as `UTF-8'de'Rechnung.pdf` — wrong data in the books,
    // with nothing failing visibly.
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename*=UTF-8'de'Rechnung.pdf",
        },
      })) as unknown as typeof fetch;
    const out = await fetchRemoteFile("https://ok.example.com/x", {
      lookup: publicLookup,
      fetchImpl,
      allowedHosts: ["ok.example.com"],
    });
    expect(out.filename).toBe("Rechnung.pdf");
  });

  it("decodes a percent-encoded filename* carrying a language tag", async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename*=UTF-8'de'Rechnung%20M%C3%BCller.pdf",
        },
      })) as unknown as typeof fetch;
    const out = await fetchRemoteFile("https://ok.example.com/x", {
      lookup: publicLookup,
      fetchImpl,
      allowedHosts: ["ok.example.com"],
    });
    expect(out.filename).toBe("Rechnung Müller.pdf");
  });

  it("still decodes filename* with an EMPTY language tag (the no-language form)", async () => {
    // The other half of "with and without a language tag": splitting on the two
    // apostrophes generically must not break the plain `UTF-8''…` case.
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename*=UTF-8''Rechnung%20M%C3%BCller.pdf",
        },
      })) as unknown as typeof fetch;
    const out = await fetchRemoteFile("https://ok.example.com/x", {
      lookup: publicLookup,
      fetchImpl,
      allowedHosts: ["ok.example.com"],
    });
    expect(out.filename).toBe("Rechnung Müller.pdf");
  });

  it("keeps a malformed filename* with no apostrophes at all verbatim", async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename*=Rechnung.pdf",
        },
      })) as unknown as typeof fetch;
    const out = await fetchRemoteFile("https://ok.example.com/x", {
      lookup: publicLookup,
      fetchImpl,
      allowedHosts: ["ok.example.com"],
    });
    expect(out.filename).toBe("Rechnung.pdf");
  });

  it("reduces a filename to its basename and strips path separators", async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="../../etc/passwd"',
        },
      })) as unknown as typeof fetch;
    const out = await fetchRemoteFile("https://ok.example.com/x", {
      lookup: publicLookup,
      fetchImpl,
      allowedHosts: ["ok.example.com"],
    });
    expect(out.filename).toBe("passwd");
  });
});
