import type { IncomingMessage } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createPinnedFetch, createPinnedLookup, responseFromIncoming } from "../src/uploads/pinned-fetch.js";

/**
 * A hostname reserved by RFC 6761 §6.4 to be guaranteed NOT resolvable. That is what
 * makes the connection tests proofs rather than coincidences: if a connection arrives at
 * the listener, DNS cannot have produced the address — only the pin can have.
 */
const UNRESOLVABLE = "no-such-host.invalid";

/**
 * A TCP listener that records what reaches it and then hangs up. Deliberately NOT a TLS
 * server: these tests assert where the socket goes and what it announces, and the
 * handshake is expected to fail right afterwards. Standing up a real TLS peer would need
 * a certificate, and X.509 issuance is not something Node can do without a dependency.
 */
function recordingListener(): Promise<{
  server: Server;
  port: number;
  connections: Socket[];
  /** Peer addresses, captured on connect — `socket.remoteAddress` is cleared on destroy. */
  peers: string[];
  firstBytes: Promise<Buffer>;
}> {
  const connections: Socket[] = [];
  const peers: string[] = [];
  let resolveBytes: (b: Buffer) => void;
  const firstBytes = new Promise<Buffer>((r) => (resolveBytes = r));

  const server = createServer((socket) => {
    connections.push(socket);
    peers.push(socket.remoteAddress ?? "");
    socket.once("data", (chunk: Buffer) => {
      resolveBytes(chunk);
      socket.destroy();
    });
    // A peer that connects but sends nothing must not wedge the test.
    socket.setTimeout(2_000, () => socket.destroy());
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port, connections, peers, firstBytes });
    });
  });
}

/**
 * Extracts the SNI host from a TLS ClientHello. Hand-rolled because the point is to read
 * what actually went on the wire, and asking Node's TLS stack would just be asking the
 * code under test to grade itself.
 *
 * Layout walked: record header (5) → handshake header (4) → client_version (2) →
 * random (32) → session_id → cipher_suites → compression_methods → extensions, then the
 * server_name extension (type 0x0000) → server_name_list → host_name entry (type 0x00).
 */
function sniFromClientHello(buf: Buffer): string | undefined {
  let p = 5 + 4 + 2 + 32; // record header, handshake header, version, random
  if (buf.length < p + 1) return undefined;
  p += 1 + buf[p]; // session_id
  if (buf.length < p + 2) return undefined;
  p += 2 + buf.readUInt16BE(p); // cipher_suites
  if (buf.length < p + 1) return undefined;
  p += 1 + buf[p]; // compression_methods
  if (buf.length < p + 2) return undefined;
  const extensionsEnd = p + 2 + buf.readUInt16BE(p);
  p += 2;

  while (p + 4 <= extensionsEnd && p + 4 <= buf.length) {
    const type = buf.readUInt16BE(p);
    const length = buf.readUInt16BE(p + 2);
    const body = p + 4;
    if (type === 0x0000) {
      // server_name_list length (2), then entries of: type (1) + length (2) + host.
      let q = body + 2;
      while (q + 3 <= body + length) {
        const nameType = buf[q];
        const nameLength = buf.readUInt16BE(q + 1);
        if (nameType === 0x00) return buf.subarray(q + 3, q + 3 + nameLength).toString("ascii");
        q += 3 + nameLength;
      }
      return undefined;
    }
    p = body + length;
  }
  return undefined;
}

describe("createPinnedLookup", () => {
  /** Collects one invocation of the lookup into a plain value the assertions can read. */
  function invoke(
    lookup: ReturnType<typeof createPinnedLookup>,
    host: string,
    options: { family?: number | "IPv4" | "IPv6"; all?: boolean },
  ) {
    return new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) => {
      lookup(host, options, (err, address, family) => resolve({ err, address, family }));
    });
  }

  it("returns every vetted address for an all:true lookup, in order", async () => {
    const lookup = createPinnedLookup("files.example.com", ["203.0.113.7", "2001:db8::1"]);
    const { err, address } = await invoke(lookup, "files.example.com", { all: true });
    expect(err).toBeNull();
    expect(address).toEqual([
      { address: "203.0.113.7", family: 4 },
      { address: "2001:db8::1", family: 6 },
    ]);
  });

  it("returns the first vetted address for an all:false lookup, with its family", async () => {
    const lookup = createPinnedLookup("files.example.com", ["2001:db8::1", "203.0.113.7"]);
    const { err, address, family } = await invoke(lookup, "files.example.com", { all: false });
    expect(err).toBeNull();
    expect(address).toBe("2001:db8::1");
    expect(family).toBe(6);
  });

  it("honours a requested family instead of handing back an address of the wrong one", async () => {
    const lookup = createPinnedLookup("files.example.com", ["203.0.113.7", "2001:db8::1"]);
    const v6 = await invoke(lookup, "files.example.com", { family: 6, all: true });
    expect(v6.address).toEqual([{ address: "2001:db8::1", family: 6 }]);
    const v4 = await invoke(lookup, "files.example.com", { family: 4, all: false });
    expect(v4.address).toBe("203.0.113.7");
  });

  it("understands the string spelling of family, not only the numeric one", async () => {
    // dns.lookup accepts "IPv4"/"IPv6"; a lookup that only matched 4 and 6 would read
    // those as "no preference" and hand back an address of the wrong family.
    const lookup = createPinnedLookup("files.example.com", ["203.0.113.7", "2001:db8::1"]);
    const v6 = await invoke(lookup, "files.example.com", { family: "IPv6", all: true });
    expect(v6.address).toEqual([{ address: "2001:db8::1", family: 6 }]);
    const v4 = await invoke(lookup, "files.example.com", { family: "IPv4", all: true });
    expect(v4.address).toEqual([{ address: "203.0.113.7", family: 4 }]);
  });

  it("errors rather than falling back when the requested family has no vetted address", async () => {
    const lookup = createPinnedLookup("files.example.com", ["203.0.113.7"]);
    const { err, address } = await invoke(lookup, "files.example.com", { family: 6, all: true });
    expect(err?.message).toMatch(/No vetted IPv6 address/);
    expect(address).toBe("");
  });

  it("refuses a hostname other than the vetted one — the pin is not a general resolver", async () => {
    const lookup = createPinnedLookup("files.example.com", ["203.0.113.7"]);
    const { err } = await invoke(lookup, "attacker.example.net", { all: true });
    expect(err?.message).toMatch(/only files\.example\.com was vetted/);
  });

  it("treats a case difference and a trailing root-label dot as the same host", async () => {
    const lookup = createPinnedLookup("Files.Example.com.", ["203.0.113.7"]);
    const { err, address } = await invoke(lookup, "FILES.example.COM", { all: true });
    expect(err).toBeNull();
    expect(address).toEqual([{ address: "203.0.113.7", family: 4 }]);
  });

  it("errors when nothing was vetted, instead of resolving the name", async () => {
    const lookup = createPinnedLookup("files.example.com", []);
    const { err } = await invoke(lookup, "files.example.com", { all: true });
    expect(err?.message).toMatch(/No vetted address/);
  });
});

describe("createPinnedFetch", () => {
  let open: Awaited<ReturnType<typeof recordingListener>> | undefined;

  afterEach(async () => {
    if (!open) return;
    for (const socket of open.connections) socket.destroy();
    await new Promise((resolve) => open!.server.close(resolve));
    open = undefined;
  });

  it("connects to the pinned address for a host DNS cannot resolve at all", async () => {
    open = await recordingListener();
    const pinnedFetch = createPinnedFetch(UNRESOLVABLE, ["127.0.0.1"]);

    // Rejects, because the listener is not a TLS peer — that is expected and beside the
    // point. What matters is that the connection ARRIVED: `no-such-host.invalid` has no
    // DNS answer, so an unpinned client fails with ENOTFOUND and never opens a socket.
    await expect(
      pinnedFetch(new URL(`https://${UNRESOLVABLE}:${open.port}/file.pdf`), {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow();

    expect(open.connections.length).toBe(1);
    expect(open.peers[0]).toBe("127.0.0.1");
  });

  it("still announces the HOSTNAME in the TLS handshake, so certificate validation is unchanged", async () => {
    open = await recordingListener();
    const pinnedFetch = createPinnedFetch(UNRESOLVABLE, ["127.0.0.1"]);

    const attempt = pinnedFetch(new URL(`https://${UNRESOLVABLE}:${open.port}/file.pdf`), {
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    const hello = await open.firstBytes;
    await expect(attempt).rejects.toThrow();

    // 0x16 = TLS handshake record. Pinning changes the address dialled, nothing else:
    // the SNI is the hostname, so the peer must still present a certificate valid for
    // it. Were the IP substituted into the request instead, this would read "127.0.0.1"
    // and any certificate for the pinned host would be rejected — or worse, accepted.
    expect(hello[0]).toBe(0x16);
    expect(sniFromClientHello(hello)).toBe(UNRESOLVABLE);
  });

  it("refuses to issue a request for a host other than the vetted one", async () => {
    open = await recordingListener();
    const pinnedFetch = createPinnedFetch(UNRESOLVABLE, ["127.0.0.1"]);

    await expect(
      pinnedFetch(new URL(`https://other-host.invalid:${open.port}/file.pdf`), {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow(/only no-such-host\.invalid was vetted/);

    expect(open.connections.length).toBe(0);
  });

  it("refuses when no address was vetted, without touching the network", async () => {
    open = await recordingListener();
    const pinnedFetch = createPinnedFetch(UNRESOLVABLE, []);

    await expect(
      pinnedFetch(new URL(`https://${UNRESOLVABLE}:${open.port}/file.pdf`), {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow(/No vetted address/);

    expect(open.connections.length).toBe(0);
  });
});

describe("responseFromIncoming", () => {
  /** A stand-in for what `https.request` hands back, so the translation can be read directly. */
  function incoming(statusCode: number, headers: Record<string, string | string[]>, body?: string) {
    const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, "utf8")]);
    return Object.assign(stream, { statusCode, headers }) as unknown as IncomingMessage;
  }

  it("carries status, headers and body through unchanged", async () => {
    const res = responseFromIncoming(
      incoming(
        200,
        {
          "content-type": "application/pdf",
          "content-length": "5",
          "content-disposition": `attachment; filename*=UTF-8'de'Rechnung.pdf`,
        },
        "hello",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8'de'Rechnung.pdf`);
    expect(await res.text()).toBe("hello");
  });

  it("keeps a redirect's location readable, since redirects are followed by hand", async () => {
    const res = responseFromIncoming(incoming(302, { location: "https://elsewhere.example.com/f.pdf" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://elsewhere.example.com/f.pdf");
  });

  it("gives a null body to statuses that cannot carry one, instead of throwing", async () => {
    for (const status of [204, 205, 304]) {
      const res = responseFromIncoming(incoming(status, {}));
      expect(res.status, String(status)).toBe(status);
      expect(res.body, String(status)).toBeNull();
    }
  });

  it("keeps repeated headers as separate values rather than losing all but one", () => {
    const res = responseFromIncoming(incoming(200, { "set-cookie": ["a=1", "b=2"] }, "x"));
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("reports a status outside 200-599 as itself, not as a RangeError from Response", () => {
    expect(() => responseFromIncoming(incoming(100, {}))).toThrow(/Unexpected HTTP status 100/);
  });
});
