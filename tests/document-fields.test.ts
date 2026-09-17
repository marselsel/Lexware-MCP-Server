import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LexwareClient } from "../src/lexware/client.js";
import { registerDocumentDraftTools } from "../src/tools/documents.js";
import { invoiceInputShape } from "../src/tools/schemas.js";

type Handler = (input: Record<string, unknown>) => Promise<unknown>;

const BASE = {
  voucherDate: "2026-09-17T00:00:00.000+02:00",
  address: { contactId: "c1" },
  lineItems: [{ type: "custom", name: "Item", quantity: 1, unitPrice: { currency: "EUR", netAmount: 100 } }],
  totalPrice: { currency: "EUR" },
  taxConditions: { taxType: "net" },
  shippingConditions: { shippingType: "service" },
};

function draftTools(post: ReturnType<typeof vi.fn>) {
  const client = { post } as unknown as LexwareClient;
  const handlers: Record<string, Handler> = {};
  const schemas: Record<string, z.ZodRawShape> = {};
  const server = {
    registerTool(cfg: { name: string; inputSchema?: z.ZodRawShape }, handler: Handler) {
      handlers[cfg.name] = handler;
      if (cfg.inputSchema) schemas[cfg.name] = cfg.inputSchema;
      return server;
    },
  } as unknown as McpServer;
  registerDocumentDraftTools(server, client);
  /**
   * Drive a tool the way the SDK does: validate the input against the tool's published
   * schema FIRST, then hand the parsed result to the handler. Calling the handler with
   * raw input instead would skip the strip-mode object, so an untyped field would sail
   * through and the test would pass whether or not the field is actually declared.
   */
  const invoke = async (name: string, input: Record<string, unknown>) => {
    const parsed = z.object(schemas[name]).parse(input) as Record<string, unknown>;
    return handlers[name](parsed);
  };
  return { invoke, handlers };
}

/** The body argument of the first client.post call. */
function postBody(post: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return (post.mock.calls[0] as [string, Record<string, unknown>])[1];
}

describe("language and printLayoutId are typed on the document shapes", () => {
  it("the invoice schema keeps them instead of stripping them", () => {
    // Before this they were absent from the shape, so the SDK's strip-mode object
    // dropped them and they could only be sent through the additionalFields hatch —
    // which works, but no model is going to guess the field names.
    const parsed = z.object(invoiceInputShape).parse({
      ...BASE,
      language: "en",
      printLayoutId: "5efd2002-ecd7-48b2-ad25-7d1c5da7d7de",
    });
    expect(parsed.language).toBe("en");
    expect(parsed.printLayoutId).toBe("5efd2002-ecd7-48b2-ad25-7d1c5da7d7de");
  });

  it("survive schema validation and reach the request body", async () => {
    const post = vi.fn(async () => ({ id: "inv-1", version: 0 }));
    await draftTools(post).invoke("create-draft-invoice", {
      ...BASE,
      language: "en",
      printLayoutId: "layout-1",
    });
    const body = postBody(post);
    expect(body.language).toBe("en");
    expect(body.printLayoutId).toBe("layout-1");
  });

  it("stay optional — omitting them sends nothing, keeping the org defaults", async () => {
    const post = vi.fn(async () => ({ id: "inv-1", version: 0 }));
    await draftTools(post).invoke("create-draft-invoice", { ...BASE });
    const body = postBody(post);
    expect("language" in body).toBe(false);
    expect("printLayoutId" in body).toBe(false);
  });

  it("a typed field still wins over the same key in additionalFields", async () => {
    // mergeBody puts typed input over the escape hatch. Now that these two are typed,
    // that precedence has to hold for them as well.
    const post = vi.fn(async () => ({ id: "inv-1", version: 0 }));
    await draftTools(post).invoke("create-draft-invoice", {
      ...BASE,
      language: "en",
      additionalFields: { language: "de" },
    });
    expect(postBody(post).language).toBe("en");
  });
});

describe("text-field descriptions carry Lexware's documented limits", () => {
  // These are descriptions rather than .max() constraints on purpose: the numbers are
  // vendor-documented and unverified against a live write, and this module is
  // deliberately lenient. A wrong number in a description cannot reject a valid
  // document; a wrong .max() would.
  const shape = invoiceInputShape as Record<string, z.ZodTypeAny>;
  const describeOf = (key: string) => shape[key]?.description ?? "";

  it("names the unusually short 25-character title limit", () => {
    expect(describeOf("title")).toMatch(/25-character/);
  });

  it("names the 2000-character limit on introduction and remark", () => {
    expect(describeOf("introduction")).toMatch(/2000-character/);
    expect(describeOf("remark")).toMatch(/introduction/); // defers to it for both
  });

  it("says how far Lexware's documentation for `language` actually goes", () => {
    // It sits on the shared base shape, so it is offered on document types Lexware
    // never documented it for. Kept deliberately (an unlisted language is
    // undocumented, not impossible), so the description has to carry the caveat.
    const language = describeOf("language");
    expect(language).toMatch(/invoices, credit notes and order confirmations/);
    expect(language).toMatch(/undocumented and may be ignored/);
  });

  it("mentions the formatting Lexware accepts, which nobody would guess", () => {
    expect(describeOf("introduction")).toMatch(/\*\*bold\*\*/);
    expect(describeOf("introduction")).toMatch(/__italic__/);
  });

  it("does NOT constrain the lengths, so a wrong doc value cannot reject a document", () => {
    const longTitle = "x".repeat(200);
    const parsed = z.object(invoiceInputShape).parse({ ...BASE, title: longTitle });
    expect(parsed.title).toBe(longTitle);
  });
});
