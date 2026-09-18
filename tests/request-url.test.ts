import type { McpServer } from "skybridge/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LexwareClient } from "../src/lexware/client.js";
import { registerContactReadTools } from "../src/tools/contacts.js";
import { registerDocumentReadTools } from "../src/tools/documents.js";

/**
 * Assertions about the URL that is actually sent.
 *
 * Every other tool test asserts the query OBJECT handed to `client.get`, which stops one
 * layer short: `buildUrl` serializes it through `URLSearchParams`, and that layer has its
 * own opinions — it percent-encodes a comma and writes a space as `+`. Both matter here.
 * The multi-value filters and the composed `sort` are built as comma-joined strings, and
 * the contacts search encoding is only correct if it survives composition.
 *
 * The contacts encoding shipped with a live probe through this exact path; the comma
 * behaviour was probed live too (`%2C` and a literal comma return identical counts). This
 * file pins both so the wire form cannot drift silently afterwards.
 */

type Handler = (input: Record<string, unknown>) => Promise<unknown>;

const EMPTY_PAGE = {
  content: [],
  first: true,
  last: true,
  number: 0,
  numberOfElements: 0,
  size: 25,
  totalPages: 0,
  totalElements: 0,
};

/**
 * Register the read tools against a REAL client whose fetch is stubbed, so the assertion
 * runs against `buildUrl`'s output rather than a reconstruction of it.
 */
function setup() {
  const urls: string[] = [];
  const client = new LexwareClient({
    baseUrl: "https://api.test",
    apiKey: "secret-key",
    fetchFn: (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(EMPTY_PAGE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
    rateLimit: { capacity: 1000, refillPerSec: 1000 },
  });

  const handlers: Record<string, Handler> = {};
  const schemas: Record<string, z.ZodRawShape> = {};
  const server = {
    registerTool(cfg: { name: string; inputSchema?: z.ZodRawShape }, handler: Handler) {
      handlers[cfg.name] = handler;
      if (cfg.inputSchema) schemas[cfg.name] = cfg.inputSchema;
      return server;
    },
  } as unknown as McpServer;
  registerDocumentReadTools(server, client, "https://app.test");
  registerContactReadTools(server, client);

  /** Parse through the published schema first — the SDK never hands a handler raw input. */
  const invoke = async (name: string, input: Record<string, unknown>) => {
    const parsed = z.object(schemas[name]).parse(input) as Record<string, unknown>;
    return handlers[name](parsed);
  };
  const query = () => new URL(urls[urls.length - 1]).searchParams;
  return { invoke, urls, query };
}

describe("the URL that actually goes on the wire", () => {
  it("percent-encodes the comma in a multi-value filter, and Lexware decodes it", async () => {
    const { invoke, urls, query } = setup();
    await invoke("get-voucherlist", { voucherType: ["invoice", "quotation"], voucherStatus: "open,paid" });

    // This is the raw form — the thing the earlier probes had to confirm, because every
    // curl probe used a literal comma while the client cannot produce one.
    expect(urls[0]).toContain("voucherType=invoice%2Cquotation");
    expect(urls[0]).toContain("voucherStatus=open%2Cpaid");
    // ...and it round-trips back to the comma-joined value Lexware's binder splits on.
    expect(query().get("voucherType")).toBe("invoice,quotation");
    expect(query().get("voucherStatus")).toBe("open,paid");
  });

  it("percent-encodes the comma in the composed sort parameter", async () => {
    const { invoke, urls, query } = setup();
    await invoke("get-voucherlist", { sortBy: "voucherNumber", sortDirection: "ASC" });

    expect(urls[0]).toContain("sort=voucherNumber%2CASC");
    expect(query().get("sort")).toBe("voucherNumber,ASC");
  });

  it("sends the HTML-encoded ampersand without the URL layer undoing it", async () => {
    const { invoke, urls, query } = setup();
    await invoke("list-contacts", { name: "Müller & Sohn" });

    // The whole point of the fix: `&` leaves as `&amp;`, then the URL layer escapes the
    // `&` of `&amp;` again, so the wire carries `%26amp%3B`. A single encoding step would
    // produce `%26` here and Lexware would match nothing.
    expect(urls[0]).toContain("name=M%C3%BCller+%26amp%3B+Sohn");
    expect(urls[0]).not.toContain("name=M%C3%BCller+%26+Sohn");
    // Spaces are `+`, not `%20` — URLSearchParams serializes form-encoded. Pinned because
    // the module doc records this as the verified wire form.
    expect(urls[0]).toContain("+%26amp%3B+");
    expect(query().get("name")).toBe("Müller &amp; Sohn");
  });

  it("leaves the exact-match filters unencoded", async () => {
    const { invoke, query } = setup();
    await invoke("list-contacts", { number: 10001 });
    expect(query().get("number")).toBe("10001");

    const b = setup();
    await b.invoke("get-voucherlist", { voucherNumber: "RE0069" });
    expect(b.query().get("voucherNumber")).toBe("RE0069");
  });

  it("never emits an empty voucherType/voucherStatus, which Lexware answers with a 500", async () => {
    const { invoke, urls } = setup();
    await invoke("get-voucherlist", {});
    expect(urls[0]).toContain("voucherType=any");
    expect(urls[0]).toContain("voucherStatus=any");
    expect(urls[0]).not.toMatch(/voucherType=(&|$)/);
    expect(urls[0]).not.toMatch(/voucherStatus=(&|$)/);
  });
});
