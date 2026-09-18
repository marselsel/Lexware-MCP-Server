import { describe, expect, it, vi } from "vitest";
import { LexwareClient } from "../src/lexware/client.js";
import { LexwareApiError } from "../src/lexware/errors.js";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function binary(bytes: Uint8Array, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(bytes, {
    status,
    headers: { "content-type": "application/pdf", ...headers },
  });
}

/** Client with rate limiting effectively disabled and deterministic backoff. */
function makeClient(fetchFn: typeof fetch, slept: number[] = [], now?: () => number) {
  return new LexwareClient({
    baseUrl: "https://api.test",
    apiKey: "secret-key",
    fetchFn,
    sleep: async (ms) => {
      slept.push(ms);
    },
    random: () => 0,
    now,
    rateLimit: { capacity: 1000, refillPerSec: 1000 },
    maxRetries: 4,
  });
}

/** A 200 Response whose body read rejects, to exercise the body-stream error path. */
function bodyReadFails(read: "text" | "arrayBuffer"): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
    text: async () => {
      if (read === "text") throw new TypeError("terminated");
      return "";
    },
    arrayBuffer: async () => {
      if (read === "arrayBuffer") throw new TypeError("terminated");
      return new ArrayBuffer(0);
    },
  } as unknown as Response;
}

describe("LexwareClient", () => {
  it("sends a Bearer token and parses JSON", async () => {
    const fetchFn = vi.fn(async (_url, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
      return json({ companyName: "Acme" });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const res = await client.get<{ companyName: string }>("/v1/profile");
    expect(res.companyName).toBe("Acme");
  });

  it("retries on 429 and honors Retry-After seconds", async () => {
    const slept: number[] = [];
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      return n === 1 ? json({ error: "slow down" }, 429, { "retry-after": "2" }) : json({ ok: true });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn, slept);
    const res = await client.get<{ ok: boolean }>("/v1/voucherlist");
    expect(res.ok).toBe(true);
    expect(n).toBe(2);
    expect(slept).toContain(2000);
  });

  it("clamps a huge Retry-After so a request can't hang", async () => {
    const slept: number[] = [];
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      return n === 1 ? json({}, 429, { "retry-after": "3600" }) : json({ ok: true });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn, slept);
    await client.get("/v1/profile");
    expect(Math.max(...slept)).toBeLessThanOrEqual(30_000);
  });

  it("does NOT retry a POST on a network error (no duplicate writes)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    await expect(client.post("/v1/invoices", { a: 1 })).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("POST not retried"),
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries an idempotent GET on a network error, then succeeds", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("ETIMEDOUT");
      return json({ ok: true });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const res = await client.get<{ ok: boolean }>("/v1/profile");
    expect(res.ok).toBe(true);
    expect(n).toBe(2);
  });

  it("passes an abort signal and retries an idempotent GET that times out", async () => {
    let n = 0;
    const fetchFn = vi.fn(async (_url, init) => {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
      n += 1;
      if (n === 1) throw new DOMException("The operation timed out.", "TimeoutError");
      return json({ ok: true });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const res = await client.get<{ ok: boolean }>("/v1/profile");
    expect(res.ok).toBe(true);
    expect(n).toBe(2);
  });

  it("does NOT retry a POST that times out (no duplicate writes)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    await expect(client.post("/v1/invoices", { a: 1 })).rejects.toMatchObject({ status: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries idempotent GETs on 5xx", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      return n < 3 ? json({ e: 1 }, 503) : json({ ok: true });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const res = await client.get<{ ok: boolean }>("/v1/profile");
    expect(res.ok).toBe(true);
    expect(n).toBe(3);
  });

  it("maps a 400 to a validation error with safe detail", async () => {
    const fetchFn = vi.fn(async () =>
      json({ message: "voucherDate must not be null" }, 400),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const err = await client.get("/v1/invoices/x").catch((e) => e);
    expect(err).toBeInstanceOf(LexwareApiError);
    expect(err.status).toBe(400);
    expect(err.kind).toBe("validation");
    expect(err.message).toContain("voucherDate must not be null");
    expect(err.message).not.toContain("secret-key");
  });

  it("surfaces the Lexware IssueList (source + i18nKey) on a 406 and preserves the raw body", async () => {
    const issueBody = {
      IssueList: [
        { i18nKey: "missing_entity", source: "voucherItems[0].taxRatePercent", type: "validation_failure" },
        { i18nKey: "regex_mismatch", source: "voucherDate", type: "validation_failure" },
      ],
    };
    const fetchFn = vi.fn(async () => json(issueBody, 406)) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const err = await client.post("/v1/vouchers", { a: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(LexwareApiError);
    expect(err.status).toBe(406);
    expect(err.kind).toBe("validation");
    // The field path (source) and reason (i18nKey) must come through — not just "validation_failure".
    expect(err.message).toContain("voucherItems[0].taxRatePercent");
    expect(err.message).toContain("missing_entity");
    expect(err.message).toContain("voucherDate");
    // The full parsed body is preserved for downstream inspection.
    expect(err.body).toEqual(issueBody);
  });

  it("never swallows an unrecognized error body (raw-JSON fallback)", async () => {
    const fetchFn = vi.fn(async () => json({ weird: "shape", code: 17 }, 422)) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const err = await client.get("/v1/vouchers/x").catch((e) => e);
    expect(err.message).toContain("weird");
    expect(err.message).toContain("shape");
  });

  it("classifies 401 as auth", async () => {
    const fetchFn = vi.fn(async () => json({}, 401)) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const err = await client.get("/v1/profile").catch((e) => e);
    expect(err.kind).toBe("auth");
  });

  it("getBinary returns the bytes as a Buffer with the response content-type", async () => {
    const fetchFn = vi.fn(async (_url, init) => {
      expect((init?.headers as Record<string, string>).Accept).toBe("application/pdf");
      return binary(new Uint8Array([1, 2, 3, 4]), 200, { "content-type": "application/pdf" });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const { data, contentType } = await client.getBinary("/v1/files/abc");
    expect(Buffer.isBuffer(data)).toBe(true);
    expect([...data]).toEqual([1, 2, 3, 4]);
    expect(contentType).toBe("application/pdf");
  });

  it("getBinary falls back to octet-stream, not to a wildcard Accept", async () => {
    // The voucher and file downloads send `Accept: */*` because an attachment is whatever
    // the user filed. If the response carries no content-type, echoing that back would put
    // a match pattern where a media type belongs: it reaches the caller as the embedded
    // resource's `mimeType`, and `*/*` is not a media type a strict client can render.
    // Built without the `binary` helper on purpose: it defaults the header to
    // application/pdf, and the whole point here is a response that carries none.
    const noContentType = () => new Response(new Uint8Array([1]), { status: 200 });
    const client = makeClient(vi.fn(noContentType) as unknown as typeof fetch);
    const { contentType } = await client.getBinary("/v1/files/abc", "*/*");
    expect(contentType).toBe("application/octet-stream");
  });

  it("getBinary still falls back to a concrete Accept when the response omits one", async () => {
    const noContentType = () => new Response(new Uint8Array([1]), { status: 200 });
    const client = makeClient(vi.fn(noContentType) as unknown as typeof fetch);
    const { contentType } = await client.getBinary("/v1/invoices/x/file", "application/xml");
    expect(contentType).toBe("application/xml");
  });

  it("getBinary retries an idempotent GET on 5xx, then succeeds", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      return n < 2 ? json({ e: 1 }, 503) : binary(new Uint8Array([9]));
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const { data } = await client.getBinary("/v1/files/x");
    expect([...data]).toEqual([9]);
    expect(n).toBe(2);
  });

  it("maps a body-read failure on request() to a classified network error (not a raw stream error)", async () => {
    const fetchFn = vi.fn(async () => bodyReadFails("text")) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const err = await client.get("/v1/profile").catch((e) => e);
    expect(err).toBeInstanceOf(LexwareApiError);
    expect(err.status).toBe(0);
    expect(err.kind).toBe("network");
    expect(err.message).toContain("reading Lexware response");
  });

  it("maps a body-read failure on getBinary to a classified network error", async () => {
    const fetchFn = vi.fn(async () => bodyReadFails("arrayBuffer")) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const err = await client.getBinary("/v1/files/x").catch((e) => e);
    expect(err).toBeInstanceOf(LexwareApiError);
    expect(err.status).toBe(0);
    expect(err.kind).toBe("network");
  });

  it("computes an HTTP-date Retry-After against the injected clock, not wall time", async () => {
    const slept: number[] = [];
    const nowMs = 1_000_000_000_000;
    const retryAt = new Date(nowMs + 5000).toUTCString(); // 5s in the future per the injected clock
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      return n === 1 ? json({}, 429, { "retry-after": retryAt }) : json({ ok: true });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn, slept, () => nowMs);
    await client.get("/v1/profile");
    // ~5000ms (clamped into [250, 30000]); would be a wild value if wall-clock Date.now() were used.
    expect(slept.some((ms) => ms >= 4000 && ms <= 6000)).toBe(true);
  });

  it("getBinary maps a 406 to a validation error", async () => {
    const fetchFn = vi.fn(async () =>
      json({ message: "not acceptable" }, 406),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const err = await client.getBinary("/v1/files/x").catch((e) => e);
    expect(err).toBeInstanceOf(LexwareApiError);
    expect(err.status).toBe(406);
    expect(err.kind).toBe("validation");
  });

  it("postMultipart sends a FormData body and never sets Content-Type itself", async () => {
    const fetchFn = vi.fn(async (_url, init) => {
      const i = init as RequestInit;
      expect(i.method).toBe("POST");
      // Must be absent so fetch derives the multipart boundary.
      expect((i.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
      expect(i.body).toBeInstanceOf(FormData);
      const form = i.body as FormData;
      expect(form.get("type")).toBe("voucher");
      expect(form.get("file")).toBeInstanceOf(Blob);
      return json({ id: "file-1" });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const res = await client.postMultipart<{ id: string }>(
      "/v1/files",
      { bytes: new Uint8Array([1, 2, 3]), filename: "receipt.pdf", contentType: "application/pdf" },
      { type: "voucher" },
    );
    expect(res.id).toBe("file-1");
  });

  it("postMultipart does NOT retry on a network error (no duplicate uploads)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    await expect(
      client.postMultipart("/v1/files", {
        bytes: new Uint8Array([1]),
        filename: "a.pdf",
        contentType: "application/pdf",
      }),
    ).rejects.toMatchObject({ status: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("postMultipart still retries on 429", async () => {
    const slept: number[] = [];
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      return n === 1 ? json({}, 429, { "retry-after": "1" }) : json({ id: "f" });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn, slept);
    const res = await client.postMultipart<{ id: string }>("/v1/files", {
      bytes: new Uint8Array([1]),
      filename: "a.pdf",
      contentType: "application/pdf",
    });
    expect(res.id).toBe("f");
    expect(n).toBe(2);
  });
});
