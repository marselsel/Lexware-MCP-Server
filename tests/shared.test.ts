import { describe, expect, it, vi } from "vitest";
import type { LexwareClient } from "../src/lexware/client.js";
import { LexwareApiError } from "../src/lexware/errors.js";
import type { Paged } from "../src/lexware/types.js";
import {
  binaryResult,
  decodeBase64Strict,
  deepMergePatch,
  deleteIdempotent,
  mergeAddresses,
  pagedResult,
  text,
  withJsonText,
} from "../src/tools/shared.js";
import { mergeBody } from "../src/tools/schemas.js";

describe("deepMergePatch (read-modify-write)", () => {
  it("preserves base fields the patch omits", () => {
    const base = { id: "1", files: ["f1"], voucherNumber: "RE-1", version: 2 };
    const out = deepMergePatch(base, { remark: "edited" });
    expect(out.files).toEqual(["f1"]);
    expect(out.voucherNumber).toBe("RE-1");
    expect(out.remark).toBe("edited");
  });

  it("overrides scalars and replaces arrays wholesale", () => {
    const base = { items: [{ a: 1 }, { a: 2 }], status: "open" };
    const out = deepMergePatch(base, { items: [{ a: 9 }], status: "paid" });
    expect(out.items).toEqual([{ a: 9 }]);
    expect(out.status).toBe("paid");
  });

  it("merges nested objects so siblings survive", () => {
    const base = { company: { name: "Acme", vatRegistrationId: "OLD" } };
    const out = deepMergePatch(base, { company: { vatRegistrationId: "IE3336483DH" } });
    expect(out.company).toEqual({ name: "Acme", vatRegistrationId: "IE3336483DH" });
  });

  it("ignores undefined (omission keeps base) but applies explicit null (clears)", () => {
    const base = { a: "keep", b: "clearme" };
    const out = deepMergePatch(base, { a: undefined, b: null });
    expect(out.a).toBe("keep");
    expect(out.b).toBeNull();
  });

  it("does not mutate the base object", () => {
    const base = { nested: { x: 1 } };
    const out = deepMergePatch(base, { nested: { y: 2 } });
    expect(base).toEqual({ nested: { x: 1 } });
    expect(out.nested).toEqual({ x: 1, y: 2 });
  });
});

describe("mergeAddresses (index-wise contact address merge)", () => {
  it("merges a partial billing[0] into the existing address, keeping street/zip/city", () => {
    const current = {
      billing: [{ street: "Europaplatz 1", zip: "10557", city: "Berlin", countryCode: "DE" }],
    };
    const out = mergeAddresses(current, { billing: [{ countryCode: "IE" }] });
    expect(out.billing).toEqual([
      { street: "Europaplatz 1", zip: "10557", city: "Berlin", countryCode: "IE" },
    ]);
  });

  it("adds a billing address when none exists yet", () => {
    const out = mergeAddresses({}, { billing: [{ countryCode: "IE" }] });
    expect(out.billing).toEqual([{ countryCode: "IE" }]);
  });

  it("preserves shipping and untouched extra entries when only billing[0] is patched", () => {
    const current = {
      billing: [
        { city: "Berlin", countryCode: "DE" },
        { city: "Munich", countryCode: "DE" },
      ],
      shipping: [{ city: "Hamburg", countryCode: "DE" }],
    };
    const out = mergeAddresses(current, { billing: [{ countryCode: "IE" }] });
    expect(out.billing).toEqual([
      { city: "Berlin", countryCode: "IE" },
      { city: "Munich", countryCode: "DE" },
    ]);
    expect(out.shipping).toEqual([{ city: "Hamburg", countryCode: "DE" }]);
  });
});

describe("decodeBase64Strict", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("decodes valid standard base64", () => {
    expect(decodeBase64Strict(b64("hello")).toString("utf8")).toBe("hello");
  });

  it("strips a data-URI prefix", () => {
    expect(decodeBase64Strict(`data:application/pdf;base64,${b64("PDF")}`).toString("utf8")).toBe("PDF");
  });

  it("tolerates embedded whitespace/newlines (wrapped base64)", () => {
    const wrapped = `${b64("hello world foo bar")}`.replace(/(.{4})/g, "$1\n");
    expect(decodeBase64Strict(wrapped).toString("utf8")).toBe("hello world foo bar");
  });

  it("accepts the URL-safe alphabet", () => {
    const urlSafe = Buffer.from("~~~ ??", "utf8").toString("base64url");
    expect(decodeBase64Strict(urlSafe).toString("utf8")).toBe("~~~ ??");
  });

  it("rejects non-base64 characters instead of silently dropping them", () => {
    // Bare Buffer.from would skip the '!' and '*' and return garbage; we reject.
    expect(() => decodeBase64Strict("not valid!!! base64 ***")).toThrow(/invalid base64/);
  });

  it("rejects an empty payload", () => {
    expect(() => decodeBase64Strict("   ")).toThrow(/empty/);
  });

  it("accepts non-canonical padding that standard decoders decode identically", () => {
    // "TR==" and "TQ==" both decode to byte 0x4D; a re-encode round-trip would wrongly
    // reject "TR==", so the charset+length check must accept it.
    expect(decodeBase64Strict("TR==")[0]).toBe(0x4d);
  });

  it("rejects a length that cannot be valid base64 (len % 4 === 1)", () => {
    expect(() => decodeBase64Strict("QUJD")).not.toThrow(); // 4 chars, valid
    expect(() => decodeBase64Strict("QUJDR")).toThrow(); // 5 chars → len%4=1, impossible
  });
});

describe("mergeBody (create-tool escape hatch)", () => {
  it("merges additionalFields under the typed input (input wins)", () => {
    const out = mergeBody({ name: "typed" }, { name: "extra", xRechnung: { ref: "r" } });
    expect(out).toEqual({ name: "typed", xRechnung: { ref: "r" } });
  });

  it("strips reserved control keys from additionalFields", () => {
    const out = mergeBody(
      { title: "t" },
      { finalize: true, confirm_finalize: true, precedingSalesVoucherId: "q", version: 5, id: "x", ok: 1 },
    );
    expect(out).toEqual({ title: "t", ok: 1 });
  });

  it("tolerates a missing/non-object additionalFields", () => {
    expect(mergeBody({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(mergeBody({ a: 1 }, "nope")).toEqual({ a: 1 });
    expect(mergeBody({ a: 1 }, ["x"])).toEqual({ a: 1 });
  });
});

describe("deleteIdempotent", () => {
  it("returns alreadyAbsent=false when the DELETE succeeds", async () => {
    const request = vi.fn(async () => undefined);
    const client = { request } as unknown as LexwareClient;
    await expect(deleteIdempotent(client, "/v1/articles/a1")).resolves.toEqual({
      deleted: true,
      alreadyAbsent: false,
    });
    expect(request).toHaveBeenCalledWith("DELETE", "/v1/articles/a1", { idempotent: true });
  });

  it("swallows a 404 and flags alreadyAbsent=true", async () => {
    const client = {
      request: vi.fn(async () => {
        throw new LexwareApiError(404, "not found");
      }),
    } as unknown as LexwareClient;
    await expect(deleteIdempotent(client, "/v1/articles/a1")).resolves.toEqual({
      deleted: true,
      alreadyAbsent: true,
    });
  });

  it("rethrows a non-404 error", async () => {
    const client = {
      request: vi.fn(async () => {
        throw new LexwareApiError(409, "conflict");
      }),
    } as unknown as LexwareClient;
    await expect(deleteIdempotent(client, "/v1/articles/a1")).rejects.toThrow();
  });
});

describe("pagedResult", () => {
  const paged = (over: Partial<Paged<unknown>>): Paged<unknown> => ({
    content: [],
    first: true,
    last: true,
    number: 0,
    numberOfElements: 0,
    size: 25,
    totalPages: 0,
    totalElements: 0,
    ...over,
  });

  it("renders page 1/1 (not the impossible 1/0) for an empty result set", () => {
    const res = pagedResult(paged({}), "contact(s)");
    expect(res.content[0].text).toBe("Found 0 contact(s); showing page 1/1.");
  });

  it("renders the real 1-based page/total for a populated set", () => {
    const res = pagedResult(paged({ number: 1, totalPages: 3, totalElements: 70 }), "article(s)");
    expect(res.content[0].text).toBe("Found 70 article(s); showing page 2/3.");
  });
});

describe("binaryResult", () => {
  it("builds a text summary + an embedded-resource block with base64 data", () => {
    const data = Buffer.from("%PDF-1.7");
    const res = binaryResult({
      uri: "lexware://files/f1",
      data,
      contentType: "application/pdf",
      structuredContent: { fileId: "f1" },
      message: "Downloaded file f1.",
    });
    expect(res.content[0]).toEqual({ type: "text", text: "Downloaded file f1." });
    expect(res.content[1]).toEqual({
      type: "resource",
      resource: {
        uri: "lexware://files/f1",
        mimeType: "application/pdf",
        blob: data.toString("base64"),
      },
    });
  });
});

describe("withJsonText", () => {
  it("appends the structuredContent as compact JSON after the summary", () => {
    const out = withJsonText({ structuredContent: { id: "i1", lineItems: [{ name: "x" }] }, content: text("Invoice i1 retrieved.") });
    expect(out.content).toEqual([
      { type: "text", text: "Invoice i1 retrieved." },
      { type: "text", text: '{"id":"i1","lineItems":[{"name":"x"}]}' },
    ]);
  });

  it("keeps a binary result's embedded file and adds the metadata after it", () => {
    const data = Buffer.from("%PDF");
    const out = withJsonText(
      binaryResult({ uri: "lexware://files/f1", data, contentType: "application/pdf", structuredContent: { fileId: "f1" }, message: "Downloaded." }),
    );
    expect(out.content.map((c) => c.type)).toEqual(["text", "resource", "text"]);
    expect(out.content[2]).toEqual({ type: "text", text: '{"fileId":"f1"}' });
  });

  it("normalizes a string or missing content before appending", () => {
    expect(withJsonText({ structuredContent: { a: 1 }, content: "hi" }).content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: '{"a":1}' },
    ]);
    expect(withJsonText({ structuredContent: { a: 1 } }).content).toEqual([{ type: "text", text: '{"a":1}' }]);
  });

  it("leaves error results and results without an object structuredContent untouched", () => {
    const error = { isError: true, structuredContent: { a: 1 }, content: text("boom") };
    expect(withJsonText(error)).toBe(error);
    const plain = { content: text("ok") };
    expect(withJsonText(plain)).toBe(plain);
    // The SDK already serializes a non-object structuredContent itself.
    const scalar = { structuredContent: 42, content: text("n") };
    expect(withJsonText(scalar)).toBe(scalar);
  });
});
