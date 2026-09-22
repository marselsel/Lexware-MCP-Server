import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LexwareClient } from "../src/lexware/client.js";
import { LexwareApiError } from "../src/lexware/errors.js";
import { registerDocumentReadTools } from "../src/tools/documents.js";

type Handler = (input: Record<string, unknown>) => Promise<unknown>;

/**
 * Register the read tools and return their handlers.
 *
 * Both maps are per-call on purpose. A module-level one accumulates across tests, so an
 * assertion can be satisfied by an entry an earlier test's setup() wrote — the schema
 * test below would stay green even if the tool stopped being registered at all.
 */
function register(getBinary: LexwareClient["getBinary"]) {
  const client = { getBinary } as unknown as LexwareClient;
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

  /**
   * Call a tool the way the SDK does: parse through the PUBLISHED schema first.
   *
   * Calling a handler with raw input skips both the SDK's strip-mode object and zod, so
   * an argument sails through whether or not the tool declares it — which means such a
   * test stays green even if `format` is removed from the schema entirely and XML becomes
   * unreachable. Every assertion about `format` therefore goes through here.
   */
  const invoke = (name: string, input: Record<string, unknown>) =>
    handlers[name](z.object(schemas[name]).parse(input) as Record<string, unknown>);

  return { handlers, schemas, invoke };
}

const setup = (getBinary: LexwareClient["getBinary"]) => register(getBinary).handlers;

/** Fresh spies per test — a shared mock would carry calls between them. */
const pdfOk = () =>
  vi.fn(async () => ({ data: Buffer.from("%PDF-1.7"), contentType: "application/pdf" }));
const xmlOk = () =>
  vi.fn(async () => ({
    data: Buffer.from("<?xml version='1.0'?><Invoice/>"),
    contentType: "application/xml",
  }));

/** The (path, accept) pair of the first getBinary call. */
function call(spy: ReturnType<typeof vi.fn>): [string, string | undefined] {
  return spy.mock.calls[0] as [string, string | undefined];
}

describe("document file downloads: PDF vs e-invoice XML", () => {
  it("asks for application/pdf by default", async () => {
    const spy = pdfOk();
    await setup(spy as never)["get-document-file"]({ resourceType: "invoices", id: "inv-1", format: "pdf" });
    expect(call(spy)).toEqual(["/v1/invoices/inv-1/file", "application/pdf"]);
  });

  it("asks for application/xml when the XML is wanted", async () => {
    // The point of the parameter: Lexware's PDF of an XRechnung is a preview and is
    // explicitly not a valid e-invoice, so the XML has to be reachable. Driven through
    // the published schema, so narrowing the enum to ["pdf"] fails here rather than
    // leaving a green suite behind a feature that can no longer be requested.
    const spy = xmlOk();
    await register(spy as never).invoke("get-document-file", { resourceType: "invoices", id: "inv-1", format: "xml" });
    expect(call(spy)).toEqual(["/v1/invoices/inv-1/file", "application/xml"]);
  });

  it("threads the format through for a credit note too", async () => {
    const spy = xmlOk();
    await register(spy as never).invoke("get-document-file", {
      resourceType: "credit-notes",
      id: "cn-1",
      format: "xml",
    });
    expect(call(spy)).toEqual(["/v1/credit-notes/cn-1/file", "application/xml"]);
  });

  it("publishes format on get-document-file, with xml among its values and pdf as default", () => {
    // get-document-file is the only way to download a sales document, so a `format` that
    // silently disappeared from its schema would only ever be noticed as "XML stopped working".
    const { schemas } = register(pdfOk() as never);
    expect(Object.keys(schemas["get-document-file"])).toContain("format");

    const published = z.toJSONSchema(z.object(schemas["get-document-file"]), {
      target: "draft-7",
      io: "input",
    }) as { properties: Record<string, { enum?: unknown[]; default?: unknown }> };
    expect(published.properties.format.enum).toContain("xml");
    // The default is the whole reason it is declared: a runtime-only default never
    // reaches the model, which is the same trap PR #46 fixed for the voucherlist filters.
    expect(published.properties.format.default).toBe("pdf");
  });

  it("percent-encodes the id", async () => {
    const spy = pdfOk();
    await setup(spy as never)["get-document-file"]({ resourceType: "invoices", id: "a/b", format: "pdf" });
    expect(call(spy)[0]).toBe("/v1/invoices/a%2Fb/file");
  });

  it("reports the format in the result, not a hardcoded 'PDF'", async () => {
    const result = (await setup(xmlOk() as never)["get-document-file"]({
      resourceType: "invoices",
      id: "inv-1",
      format: "xml",
    })) as { structuredContent: Record<string, unknown>; content: unknown };
    expect(result.structuredContent.format).toBe("xml");
    expect(result.structuredContent.mimeType).toBe("application/xml");
  });

  it("translates the 404 on an XML request into what actually happened", async () => {
    // Verified live: an EN16931 (ZUGFeRD) invoice answers 404 for application/xml,
    // because its XML is embedded in the PDF rather than served separately. The raw
    // 404 reads as "no such invoice" and would send the caller after the wrong problem.
    const notFound = vi.fn(async () => {
      throw new LexwareApiError(404, "Not Found");
    });
    await expect(
      setup(notFound as never)["get-document-file"]({ resourceType: "invoices", id: "inv-1", format: "xml" }),
    ).rejects.toThrow(/not an XRechnung .* embedded in the PDF/s);
  });

  it("leaves a 404 on a PDF request alone — there it really does mean not found", async () => {
    // Assert the MESSAGE, not just the class. Since the translation started rethrowing a
    // LexwareApiError instead of a bare Error, both branches produce the same class, so
    // `toThrow(LexwareApiError)` no longer distinguishes translated from passed-through —
    // dropping `format === "xml"` from the catch condition would leave this green while a
    // plain typo on a PDF request got answered with the XRechnung explanation.
    const notFound = vi.fn(async () => {
      throw new LexwareApiError(404, "Not Found");
    });
    const err = await setup(notFound as never)
      ["get-document-file"]({ resourceType: "invoices", id: "nope", format: "pdf" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LexwareApiError);
    expect((err as LexwareApiError).status).toBe(404);
    expect((err as LexwareApiError).message).not.toMatch(/XRechnung|electronicDocumentProfile/);
  });

  it("accepts xml exactly for the resources that can be an e-invoice", async () => {
    // Only invoices, credit notes and down payment invoices can be an XRechnung. Every
    // other type reports electronicDocumentProfile "NONE", so xml there is refused before
    // a request is spent on it.
    const eInvoice = new Set(["invoices", "credit-notes", "down-payment-invoices"]);
    for (const resource of [
      "invoices",
      "quotations",
      "credit-notes",
      "order-confirmations",
      "delivery-notes",
      "dunnings",
      "down-payment-invoices",
    ]) {
      const { handlers } = register(xmlOk() as never);
      const outcome = await handlers["get-document-file"]({ resourceType: resource, id: "x", format: "xml" })
        .then(() => "accepted" as const)
        .catch((e: Error) => (/never has an e-invoice XML/.test(e.message) ? ("refused" as const) : "accepted"));
      expect(outcome, resource).toBe(eInvoice.has(resource) ? "accepted" : "refused");
    }
  });

  it("refuses an XML request for a resource that can never have one, without a request", async () => {
    const spy = pdfOk();
    await expect(
      setup(spy as never)["get-document-file"]({
        resourceType: "quotations",
        id: "q-1",
        format: "xml",
      }),
    ).rejects.toThrow(/never has an e-invoice XML/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps the reworded XML 404 classifiable as a 404", async () => {
    // Only the WORDING is improved. Rethrowing as a bare Error would strip `status` and
    // `kind`, so isNotFound() and every status branch elsewhere would stop recognising it
    // — the message would read better while the error got harder to handle.
    const notFound = vi.fn(async () => {
      throw new LexwareApiError(404, "Not Found", { IssueList: [{ type: "missing" }] });
    });
    const err = await setup(notFound as never)
      ["get-document-file"]({ resourceType: "invoices", id: "inv-1", format: "xml" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LexwareApiError);
    expect((err as LexwareApiError).status).toBe(404);
    expect((err as LexwareApiError).kind).toBe("not_found");
    // The original Lexware body survives the rewording, so nothing is lost by it.
    expect((err as LexwareApiError).body).toEqual({ IssueList: [{ type: "missing" }] });
  });

  it("names both causes of the 404, not just the profile one", async () => {
    // The same status covers "exists but has no standalone XML" and "no such id".
    // Naming only the first sends someone with a typo hunting through the profile.
    const notFound = vi.fn(async () => {
      throw new LexwareApiError(404, "Not Found");
    });
    await expect(
      setup(notFound as never)["get-document-file"]({ resourceType: "invoices", id: "typo", format: "xml" }),
    ).rejects.toThrow(/no document exists with that id/);
  });

  it("reports the normalized format, not the raw input", async () => {
    // Called RAW, deliberately, not through invoke(): parsing first applies zod's
    // .default("pdf"), so the raw and the normalized value agree and echoing the raw one
    // looks correct. It once did echo it, reporting `format: undefined` beside PDF bytes.
    const result = (await setup(pdfOk() as never)["get-document-file"]({
      resourceType: "invoices",
      id: "inv-1",
    })) as { structuredContent: Record<string, unknown> };
    expect(result.structuredContent.format).toBe("pdf");
  });

  it("leaves other errors alone, including a 409 draft", async () => {
    // A draft has no file at all; Lexware answers 409 on /file. That must surface as
    // itself, not get rewritten into the XML explanation. Asserting the class alone would
    // not catch that: the translation rethrows a LexwareApiError too, so dropping the
    // `status === 404` condition would rewrite this 409 and the test would stay green.
    const conflict = vi.fn(async () => {
      throw new LexwareApiError(409, "Conflict");
    });
    const err = await setup(conflict as never)
      ["get-document-file"]({ resourceType: "invoices", id: "draft-1", format: "xml" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LexwareApiError);
    expect((err as LexwareApiError).status).toBe(409);
    expect((err as LexwareApiError).message).not.toMatch(/XRechnung|electronicDocumentProfile/);
  });
});
