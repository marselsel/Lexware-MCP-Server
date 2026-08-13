import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LexwareClient } from "../src/lexware/client.js";
import { LexwareApiError } from "../src/lexware/errors.js";
import { registerArticleDeleteTools, registerArticleWriteTools } from "../src/tools/articles.js";
import { registerEventSubscriptionDeleteTools } from "../src/tools/event-subscriptions.js";
import { registerContactDraftTools } from "../src/tools/contacts.js";
import {
  registerDocumentDraftTools,
  registerDocumentFinalizeTools,
  registerDocumentReadTools,
} from "../src/tools/documents.js";
import { invoiceInputShape } from "../src/tools/schemas.js";
import { registerVoucherWriteTools } from "../src/tools/vouchers.js";

type Handler = (input: Record<string, unknown>) => Promise<unknown>;

/** Register a tool group against a fake server and return its handlers by name. */
function handlersFor(
  register: (s: McpServer, c: LexwareClient) => void,
  client: LexwareClient,
): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool(cfg: { name: string }, handler: Handler) {
      handlers[cfg.name] = handler;
      return server;
    },
  } as unknown as McpServer;
  register(server, client);
  return handlers;
}

/** The body argument of the (single) client.request("PUT", path, { body }) call. */
function putBody(request: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = request.mock.calls[0] as [string, string, { body: Record<string, unknown> }];
  expect(call[0]).toBe("PUT");
  return call[2].body;
}

describe("update-voucher (read-modify-write)", () => {
  it("GETs first, then PUTs the merged object, preserving files/number/status", async () => {
    const current = {
      id: "v1",
      organizationId: "org",
      type: "purchaseinvoice",
      voucherStatus: "unchecked",
      voucherNumber: "RE-2024-1",
      voucherDate: "2026-06-12T00:00:00.000+02:00",
      totalGrossAmount: 119,
      totalTaxAmount: 19,
      taxType: "gross",
      voucherItems: [{ amount: 119, taxAmount: 19, taxRatePercent: 19, categoryId: "old" }],
      files: ["file-1"],
      version: 2,
    };
    const request = vi.fn(async () => ({ id: "v1", version: 3 }));
    const get = vi.fn(async () => current);
    const client = { get, request } as unknown as LexwareClient;

    await handlersFor(registerVoucherWriteTools, client)["update-voucher"]({
      id: "v1",
      version: 2,
      voucherItems: [{ amount: 119, taxAmount: 19, taxRatePercent: 19, categoryId: "new" }],
    });

    expect(get).toHaveBeenCalledWith("/v1/vouchers/v1");
    const body = putBody(request);
    expect(body.files).toEqual(["file-1"]); // attached receipt preserved
    expect(body.voucherNumber).toBe("RE-2024-1"); // not wiped → no missing_entity
    expect(body.voucherStatus).toBe("unchecked"); // not wiped → no invalid_value
    expect(body.voucherItems).toEqual([
      { amount: 119, taxAmount: 19, taxRatePercent: 19, categoryId: "new" },
    ]); // only change applied
    expect(body.version).toBe(2); // caller's version
  });

  it("falls back to the current version when the caller omits it", async () => {
    const current = { id: "v1", type: "purchaseinvoice", voucherDate: "x", files: [], version: 7 };
    const request = vi.fn(async () => ({ id: "v1", version: 8 }));
    const client = { get: vi.fn(async () => current), request } as unknown as LexwareClient;

    await handlersFor(registerVoucherWriteTools, client)["update-voucher"]({ id: "v1", remark: "note" });

    const body = putBody(request);
    expect(body.version).toBe(7);
    expect(body.remark).toBe("note");
  });
});

describe("update-contact (read-modify-write)", () => {
  it("preserves emailAddresses/roles and merges company.vatRegistrationId without wiping the name", async () => {
    const current = {
      id: "c1",
      organizationId: "org",
      version: 4,
      roles: { vendor: {} },
      company: { name: "Deutsche Bahn AG" },
      emailAddresses: { business: ["billing@db.de"] },
      addresses: { billing: [{ street: "Europaplatz 1", zip: "10557", city: "Berlin", countryCode: "DE" }] },
    };
    const request = vi.fn(async () => ({ id: "c1", version: 5 }));
    const get = vi.fn(async () => current);
    const client = { get, request } as unknown as LexwareClient;

    await handlersFor(registerContactDraftTools, client)["update-contact"]({
      id: "c1",
      version: 4,
      company: { vatRegistrationId: "IE3336483DH" },
      addresses: { billing: [{ countryCode: "IE" }] }, // ONLY the country changes
    });

    expect(get).toHaveBeenCalledWith("/v1/contacts/c1");
    const body = putBody(request);
    expect(body.emailAddresses).toEqual({ business: ["billing@db.de"] }); // preserved
    expect(body.company).toEqual({ name: "Deutsche Bahn AG", vatRegistrationId: "IE3336483DH" }); // merged, name kept
    expect(body.roles).toEqual({ vendor: {} }); // preserved
    const addresses = body.addresses as { billing: Array<Record<string, string>> };
    // street/zip/city preserved, only countryCode updated (element-wise address merge)
    expect(addresses.billing[0]).toEqual({
      street: "Europaplatz 1",
      zip: "10557",
      city: "Berlin",
      countryCode: "IE",
    });
    expect(body.version).toBe(4);
  });
});

describe("update-article (read-modify-write)", () => {
  it("GETs first, then PUTs the merged article, preserving fields and merging price", async () => {
    const current = {
      id: "a1",
      organizationId: "org",
      version: 3,
      title: "Widget",
      type: "PRODUCT",
      unitName: "piece",
      articleNumber: "W-1",
      gtin: "1234567890123",
      description: "A widget",
      price: { leadingPrice: "NET", taxRate: 19, netPrice: 10, grossPrice: 11.9 },
    };
    const request = vi.fn(async () => ({ id: "a1", version: 4 }));
    const get = vi.fn(async () => current);
    const client = { get, request } as unknown as LexwareClient;

    await handlersFor(registerArticleWriteTools, client)["update-article"]({
      id: "a1",
      version: 3,
      price: { netPrice: 12 }, // change only one price component
    });

    expect(get).toHaveBeenCalledWith("/v1/articles/a1");
    const body = putBody(request);
    expect(body.title).toBe("Widget"); // preserved
    expect(body.articleNumber).toBe("W-1"); // preserved
    expect(body.price).toEqual({ leadingPrice: "NET", taxRate: 19, netPrice: 12, grossPrice: 11.9 }); // merged
    expect(body.version).toBe(3);
  });
});

describe("invoice draft: paymentConditions set at creation (the API has no PUT/update for invoices)", () => {
  const sample = {
    voucherDate: "2026-06-16T00:00:00.000+02:00",
    address: { contactId: "c1" },
    lineItems: [
      { type: "custom", name: "Item", quantity: 1, unitPrice: { currency: "EUR", netAmount: 100 } },
    ],
    totalPrice: { currency: "EUR" },
    taxConditions: { taxType: "net" },
    shippingConditions: { shippingType: "service" },
    paymentConditions: {
      paymentTermLabel: "Zahlbar innerhalb von 14 Tagen ohne Abzug",
      paymentTermDuration: 14,
    },
  };

  it("the invoice input schema retains paymentConditions instead of stripping it", () => {
    const parsed = z.object(invoiceInputShape).parse(sample);
    expect(parsed.paymentConditions).toEqual({
      paymentTermLabel: "Zahlbar innerhalb von 14 Tagen ohne Abzug",
      paymentTermDuration: 14,
    });
  });

  it("create-draft-invoice forwards paymentConditions in the POST body to /v1/invoices", async () => {
    const post = vi.fn(async () => ({ id: "i1" }));
    const client = { post } as unknown as LexwareClient;

    await handlersFor(registerDocumentDraftTools, client)["create-draft-invoice"](sample);

    const call = post.mock.calls[0] as [string, Record<string, unknown>, unknown];
    expect(call[0]).toBe("/v1/invoices");
    expect(call[1].paymentConditions).toEqual({
      paymentTermLabel: "Zahlbar innerhalb von 14 Tagen ohne Abzug",
      paymentTermDuration: 14,
    });
  });
});

describe("update-voucher contact + status handling", () => {
  it("A1: setting contactId drops a custom contactName and forces useCollectiveContact:false", async () => {
    const current = {
      id: "v1",
      contactName: "Sammellieferant",
      useCollectiveContact: true,
      voucherStatus: "open",
      files: ["f1"],
      version: 1,
    };
    const request = vi.fn(async () => ({ id: "v1", version: 2 }));
    const client = { get: vi.fn(async () => current), request } as unknown as LexwareClient;
    await handlersFor(registerVoucherWriteTools, client)["update-voucher"]({ id: "v1", contactId: "contact-9" });
    const body = putBody(request);
    expect(body.contactId).toBe("contact-9");
    expect(body.contactName).toBeUndefined();
    expect(body.useCollectiveContact).toBe(false);
    expect(body.files).toEqual(["f1"]); // RMW still preserves the receipt
  });

  it("A2: setting a one-off contactName drops the contactId carried over from the current voucher", async () => {
    const current = {
      id: "v1",
      contactId: "contact-9",
      voucherStatus: "open",
      files: ["f1"],
      version: 1,
    };
    const request = vi.fn(async () => ({ id: "v1", version: 2 }));
    const client = { get: vi.fn(async () => current), request } as unknown as LexwareClient;
    await handlersFor(registerVoucherWriteTools, client)["update-voucher"]({
      id: "v1",
      contactName: "Sammellieferant",
    });
    const body = putBody(request);
    expect(body.contactName).toBe("Sammellieferant");
    expect(body.contactId).toBeUndefined(); // inherited id cleared so the two don't 406
    expect(body.useCollectiveContact).toBe(true); // one-off name books to the collective contact
    expect(body.files).toEqual(["f1"]); // RMW still preserves the receipt
  });

  it("B1: a payment-derived voucherStatus (paid) is omitted from the PUT", async () => {
    const current = { id: "v2", voucherStatus: "paid", files: [], version: 3 };
    const request = vi.fn(async () => ({ id: "v2", version: 4 }));
    const client = { get: vi.fn(async () => current), request } as unknown as LexwareClient;
    await handlersFor(registerVoucherWriteTools, client)["update-voucher"]({ id: "v2", remark: "note" });
    const body = putBody(request);
    expect(body.voucherStatus).toBeUndefined();
    expect(body.remark).toBe("note");
  });

  it("B5: an explicit voucherStatus (voided) is kept for a void attempt", async () => {
    const current = { id: "v3", voucherStatus: "open", files: [], version: 1 };
    const request = vi.fn(async () => ({ id: "v3", version: 2 }));
    const client = { get: vi.fn(async () => current), request } as unknown as LexwareClient;
    await handlersFor(registerVoucherWriteTools, client)["update-voucher"]({ id: "v3", voucherStatus: "voided" });
    const body = putBody(request);
    expect(body.voucherStatus).toBe("voided");
  });
});

describe("get-vouchers (batch read)", () => {
  it("fetches each id and collects failures into errors instead of throwing", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/bad")) throw new Error("Lexware API 404: not found");
      return { id: path.split("/").pop(), voucherStatus: "open" };
    });
    const client = { get } as unknown as LexwareClient;
    const handlers = handlersFor((s, c) => registerDocumentReadTools(s, c, "https://app.test"), client);
    const res = (await handlers["get-vouchers"]({ ids: ["a", "bad", "b"] })) as {
      structuredContent: { vouchers: unknown[]; errors: Array<{ id: string }> };
    };
    expect(res.structuredContent.vouchers).toHaveLength(2);
    expect(res.structuredContent.errors.map((e) => e.id)).toEqual(["bad"]);
  });
});

describe("get-document dispatch + get-voucher-file", () => {
  it("get-document routes by voucherType and rejects unknown types", async () => {
    const get = vi.fn(async (path: string) => ({ path }));
    const client = { get } as unknown as LexwareClient;
    const handlers = handlersFor((s, c) => registerDocumentReadTools(s, c, "https://app.test"), client);
    await handlers["get-document"]({ id: "x", voucherType: "purchaseinvoice" });
    expect(get).toHaveBeenCalledWith("/v1/vouchers/x");
    await handlers["get-document"]({ id: "y", voucherType: "quotation" });
    expect(get).toHaveBeenCalledWith("/v1/quotations/y");
    // recurringtemplate is a real voucherlist type and must dispatch, not throw.
    await handlers["get-document"]({ id: "r", voucherType: "recurringtemplate" });
    expect(get).toHaveBeenCalledWith("/v1/recurring-templates/r");
    await expect(handlers["get-document"]({ id: "z", voucherType: "bogus" })).rejects.toThrow(
      /Unknown voucherType/,
    );
    // A prototype key must be rejected too, not resolve to an inherited function that
    // stringifies into the request path. Before the Object.hasOwn guard these did NOT
    // throw — they built a garbled `/v1/function toString()…/id` and called client.get.
    const getCalls = get.mock.calls.length;
    for (const voucherType of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      await expect(handlers["get-document"]({ id: "z", voucherType })).rejects.toThrow(/Unknown voucherType/);
    }
    expect(get.mock.calls.length).toBe(getCalls); // none of them reached the client
  });

  it("get-voucher-file resolves the voucher's file id and downloads it", async () => {
    const get = vi.fn(async () => ({ files: ["file-7"] }));
    const getBinary = vi.fn(async () => ({ data: Buffer.from("%PDF-1.6"), contentType: "application/pdf" }));
    const client = { get, getBinary } as unknown as LexwareClient;
    const handlers = handlersFor((s, c) => registerDocumentReadTools(s, c, "https://app.test"), client);
    const res = (await handlers["get-voucher-file"]({ id: "v1", fileIndex: 0 })) as {
      structuredContent: { fileId: string };
    };
    expect(get).toHaveBeenCalledWith("/v1/vouchers/v1");
    expect(getBinary).toHaveBeenCalledWith("/v1/files/file-7");
    expect(res.structuredContent.fileId).toBe("file-7");
  });
});

const docBody = {
  voucherDate: "2026-06-01T00:00:00.000+02:00",
  address: { contactId: "c1" },
  lineItems: [{ type: "custom", name: "x" }],
  totalPrice: { currency: "EUR" },
  taxConditions: { taxType: "net" },
  shippingConditions: { shippingType: "none" },
};

describe("create-draft: body forwarding + precedingSalesVoucherId (no finalize flag)", () => {
  it("creates a draft and passes precedingSalesVoucherId as a query; never finalizes", async () => {
    const post = vi.fn(async () => ({ id: "i1" }));
    const client = { post } as unknown as LexwareClient;
    const handlers = handlersFor(registerDocumentDraftTools, client);
    const res = (await handlers["create-draft-invoice"]({
      ...docBody,
      precedingSalesVoucherId: "q9",
    })) as { structuredContent: { finalized: boolean } };
    const call = post.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(call[0]).toBe("/v1/invoices");
    expect(call[2]).toEqual({ precedingSalesVoucherId: "q9" }); // no finalize in the query
    expect(res.structuredContent.finalized).toBe(false);
  });

  it("merges additionalFields into the body (top-level escape hatch for unmodeled fields)", async () => {
    const post = vi.fn(async () => ({ id: "i1" }));
    const client = { post } as unknown as LexwareClient;
    const handlers = handlersFor(registerDocumentDraftTools, client);
    await handlers["create-draft-invoice"]({
      ...docBody,
      additionalFields: { xRechnung: { buyerReference: "04011000-12345-06" } },
    });
    const body = (post.mock.calls[0] as [string, Record<string, unknown>, unknown])[1];
    expect(body.xRechnung).toEqual({ buyerReference: "04011000-12345-06" }); // merged in
    expect(body.additionalFields).toBeUndefined(); // not forwarded as a literal key
  });

  it("strips reserved control keys (finalize) smuggled via additionalFields", async () => {
    const post = vi.fn(async () => ({ id: "i1" }));
    const client = { post } as unknown as LexwareClient;
    const handlers = handlersFor(registerDocumentDraftTools, client);
    await handlers["create-draft-invoice"]({
      ...docBody,
      additionalFields: { finalize: true, xRechnung: { buyerReference: "x" } },
    });
    const call = post.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(call[1].finalize).toBeUndefined(); // reserved key not smuggled into the body
    expect(call[1].xRechnung).toEqual({ buyerReference: "x" }); // legitimate extra kept
    expect(call[2]).toEqual({}); // and never reaches the query either
  });

  it("rejects a stale finalize=true on a draft tool with a pointer to create-finalized-*", async () => {
    const post = vi.fn(async () => ({ id: "i1" }));
    const client = { post } as unknown as LexwareClient;
    const handlers = handlersFor(registerDocumentDraftTools, client);
    await expect(
      handlers["create-draft-invoice"]({ ...docBody, finalize: true, confirm_finalize: true }),
    ).rejects.toThrow(/create-finalized-invoice/);
    expect(post).not.toHaveBeenCalled(); // fails loudly instead of silently creating a draft
  });
});

describe("create-finalized-* (finalize tier): the only finalize path", () => {
  it("POSTs ?finalize=true, strips confirm_finalize, and returns finalized:true", async () => {
    const post = vi.fn(async () => ({ id: "i1" }));
    const client = { post } as unknown as LexwareClient;
    const handlers = handlersFor(registerDocumentFinalizeTools, client);
    const res = (await handlers["create-finalized-invoice"]({
      ...docBody,
      confirm_finalize: true,
    })) as { structuredContent: { finalized: boolean } };
    const call = post.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(call[0]).toBe("/v1/invoices");
    expect(call[2]).toEqual({ finalize: true });
    expect(call[1].confirm_finalize).toBeUndefined(); // confirmation flag never sent to the API
    expect(res.structuredContent.finalized).toBe(true);
  });

  it("passes precedingSalesVoucherId alongside finalize (pursue → issue in one step)", async () => {
    const post = vi.fn(async () => ({ id: "i1" }));
    const client = { post } as unknown as LexwareClient;
    const handlers = handlersFor(registerDocumentFinalizeTools, client);
    await handlers["create-finalized-invoice"]({
      ...docBody,
      confirm_finalize: true,
      precedingSalesVoucherId: "q9",
    });
    const query = (post.mock.calls[0] as [string, unknown, Record<string, unknown>])[2];
    expect(query).toEqual({ finalize: true, precedingSalesVoucherId: "q9" });
  });
});

describe("delete tools: idempotent (a retried delete that already succeeded returns 404)", () => {
  it("delete-article reports deleted with alreadyAbsent=false on a real delete", async () => {
    const request = vi.fn(async () => undefined);
    const client = { request } as unknown as LexwareClient;
    const res = (await handlersFor(registerArticleDeleteTools, client)["delete-article"]({
      id: "a1",
    })) as { structuredContent: { deleted: boolean; alreadyAbsent: boolean } };
    expect(res.structuredContent.deleted).toBe(true);
    expect(res.structuredContent.alreadyAbsent).toBe(false);
  });

  it("delete-article treats a 404 as already-deleted and flags alreadyAbsent=true", async () => {
    const request = vi.fn(async () => {
      throw new LexwareApiError(404, "not found");
    });
    const client = { request } as unknown as LexwareClient;
    const res = (await handlersFor(registerArticleDeleteTools, client)["delete-article"]({
      id: "a1",
    })) as { structuredContent: { deleted: boolean; alreadyAbsent: boolean } };
    expect(res.structuredContent.deleted).toBe(true);
    expect(res.structuredContent.alreadyAbsent).toBe(true);
  });

  it("delete-article still throws on a non-404 error", async () => {
    const request = vi.fn(async () => {
      throw new LexwareApiError(409, "conflict");
    });
    const client = { request } as unknown as LexwareClient;
    await expect(handlersFor(registerArticleDeleteTools, client)["delete-article"]({ id: "a1" })).rejects.toThrow();
  });

  it("delete-event-subscription treats a 404 as already-unsubscribed", async () => {
    const request = vi.fn(async () => {
      throw new LexwareApiError(404, "not found");
    });
    const client = { request } as unknown as LexwareClient;
    const res = (await handlersFor(registerEventSubscriptionDeleteTools, client)["delete-event-subscription"]({
      id: "s1",
    })) as { structuredContent: { deleted: boolean; alreadyAbsent: boolean } };
    expect(res.structuredContent.deleted).toBe(true);
    expect(res.structuredContent.alreadyAbsent).toBe(true);
  });
});

describe("render-*-pdf and get-document-file download /file", () => {
  const mkClient = () =>
    ({ getBinary: vi.fn(async () => ({ data: Buffer.from("%PDF"), contentType: "application/pdf" })) }) as unknown as LexwareClient;

  it("render-invoice-pdf hits /v1/invoices/{id}/file", async () => {
    const client = mkClient();
    const handlers = handlersFor((s, c) => registerDocumentReadTools(s, c, "https://app.test"), client);
    await handlers["render-invoice-pdf"]({ id: "i9" });
    expect(client.getBinary).toHaveBeenCalledWith("/v1/invoices/i9/file");
  });

  it("get-document-file hits /v1/{resourceType}/{id}/file", async () => {
    const client = mkClient();
    const handlers = handlersFor((s, c) => registerDocumentReadTools(s, c, "https://app.test"), client);
    await handlers["get-document-file"]({ resourceType: "credit-notes", id: "c3" });
    expect(client.getBinary).toHaveBeenCalledWith("/v1/credit-notes/c3/file");
  });
});

describe("summarize-vouchers (server-side aggregation, no row dump)", () => {
  const sumHandler = (get: ReturnType<typeof vi.fn>) =>
    handlersFor(
      (s, c) => registerDocumentReadTools(s, c, "https://app.test"),
      { get } as unknown as LexwareClient,
    )["summarize-vouchers"];

  it("walks every page and sums gross/open grouped by voucherType (sorted desc)", async () => {
    const pages: Record<number, unknown> = {
      0: {
        content: [
          { id: "1", voucherType: "salesinvoice", voucherStatus: "open", voucherDate: "2026-04-01", totalAmount: 100, openAmount: 100, currency: "EUR" },
          { id: "2", voucherType: "salesinvoice", voucherStatus: "paid", voucherDate: "2026-05-01", totalAmount: 200, openAmount: 0, currency: "EUR" },
        ],
        first: true, last: false, number: 0, numberOfElements: 2, size: 250, totalPages: 2, totalElements: 3,
      },
      1: {
        content: [
          { id: "3", voucherType: "purchaseinvoice", voucherStatus: "paid", voucherDate: "2026-05-15", totalAmount: 50, openAmount: 0, currency: "EUR" },
        ],
        first: false, last: true, number: 1, numberOfElements: 1, size: 250, totalPages: 2, totalElements: 3,
      },
    };
    const get = vi.fn(async (_p: string, q: { page: number }) => pages[q.page]);
    const res = (await sumHandler(get)({
      voucherType: "any", voucherStatus: "any", groupBy: "voucherType", maxPages: 40,
    })) as { structuredContent: Record<string, any> };
    const sc = res.structuredContent;

    expect(get).toHaveBeenCalledTimes(2); // both pages walked
    expect(sc.scanned).toBe(3);
    expect(sc.truncated).toBe(false);
    expect(sc.grandTotal).toEqual({ sumTotalAmount: 350, sumOpenAmount: 100, currency: "EUR" });
    const byType = Object.fromEntries(sc.groups.map((g: any) => [g.key, g]));
    expect(byType.salesinvoice).toEqual({ key: "salesinvoice", count: 2, sumTotalAmount: 300, sumOpenAmount: 100, currency: "EUR" });
    expect(byType.purchaseinvoice.sumTotalAmount).toBe(50);
    expect(sc.groups[0].key).toBe("salesinvoice"); // sorted by gross desc
  });

  it("flags truncated when maxPages is hit before the last page", async () => {
    const page = {
      content: [{ id: "1", voucherType: "salesinvoice", voucherStatus: "open", totalAmount: 10, openAmount: 10, currency: "EUR" }],
      first: true, last: false, number: 0, numberOfElements: 1, size: 250, totalPages: 5, totalElements: 5,
    };
    const get = vi.fn(async () => page);
    const res = (await sumHandler(get)({ groupBy: "none", maxPages: 1 })) as {
      structuredContent: Record<string, any>;
    };
    expect(get).toHaveBeenCalledTimes(1);
    expect(res.structuredContent.truncated).toBe(true);
    // Exactly one page was fetched, so pagesScanned is 1 (not the old page+1 = 2).
    expect(res.structuredContent.pagesScanned).toBe(1);
    expect(res.structuredContent.groups[0].key).toBe("all");
  });
});
