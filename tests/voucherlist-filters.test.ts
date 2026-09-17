import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import type { LexwareClient } from "../src/lexware/client.js";
import { registerDocumentReadTools } from "../src/tools/documents.js";

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

/** Register the read tools against a fake server and return handlers + the get spy. */
function setup() {
  const get = vi.fn(async () => EMPTY_PAGE);
  const client = { get } as unknown as LexwareClient;
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool(cfg: { name: string }, handler: Handler) {
      handlers[cfg.name] = handler;
      return server;
    },
  } as unknown as McpServer;
  registerDocumentReadTools(server, client, "https://app.test");
  return { handlers, get };
}

/** The query object of the first client.get call. */
function query(get: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return (get.mock.calls[0] as [string, Record<string, unknown>])[1];
}

describe("get-voucherlist filters", () => {
  it("forwards the created/updated date bounds an incremental sync needs", async () => {
    const { handlers, get } = setup();
    await handlers["get-voucherlist"]({
      voucherType: "any",
      voucherStatus: "any",
      createdDateFrom: "2026-09-01",
      createdDateTo: "2026-09-17",
      updatedDateFrom: "2026-09-10",
      updatedDateTo: "2026-09-17",
    });
    const q = query(get);
    expect(q.createdDateFrom).toBe("2026-09-01");
    expect(q.createdDateTo).toBe("2026-09-17");
    expect(q.updatedDateFrom).toBe("2026-09-10");
    expect(q.updatedDateTo).toBe("2026-09-17");
  });

  it("forwards voucherNumber for an exact lookup", async () => {
    const { handlers, get } = setup();
    await handlers["get-voucherlist"]({
      voucherType: "any",
      voucherStatus: "any",
      voucherNumber: "RE0069",
    });
    expect(query(get).voucherNumber).toBe("RE0069");
  });

  it("composes sortBy + sortDirection into Lexware's single `sort` parameter", async () => {
    const { handlers, get } = setup();
    await handlers["get-voucherlist"]({
      voucherType: "invoice",
      voucherStatus: "any",
      sortBy: "voucherNumber",
      sortDirection: "ASC",
    });
    expect(query(get).sort).toBe("voucherNumber,ASC");
  });

  it("sends the bare field when no direction is given, leaving Lexware's default", async () => {
    const { handlers, get } = setup();
    await handlers["get-voucherlist"]({
      voucherType: "invoice",
      voucherStatus: "any",
      sortBy: "createdDate",
    });
    expect(query(get).sort).toBe("createdDate");
  });

  it("omits `sort` entirely when no sortBy is given", async () => {
    const { handlers, get } = setup();
    await handlers["get-voucherlist"]({ voucherType: "any", voucherStatus: "any" });
    // Must be absent, not an empty string: the API rejects a malformed `sort` with a 400,
    // and omitting it is what keeps Lexware's voucherDate-descending default.
    expect(query(get).sort).toBeUndefined();
  });

  it("rejects a direction with nothing to sort instead of silently dropping it", async () => {
    // Silently dropping it would hand back Lexware's DESC default to a caller who
    // explicitly asked for ASC, i.e. the wrong end of the list.
    const { handlers, get } = setup();
    await expect(
      handlers["get-voucherlist"]({
        voucherType: "any",
        voucherStatus: "any",
        sortDirection: "ASC",
      }),
    ).rejects.toThrow(/sortDirection requires sortBy/);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("summarize-vouchers filters", () => {
  it("forwards the created/updated bounds too, so totals can cover a sync window", async () => {
    const { handlers, get } = setup();
    await handlers["summarize-vouchers"]({
      voucherType: "any",
      voucherStatus: "any",
      groupBy: "none",
      maxPages: 1,
      createdDateFrom: "2026-09-01",
      updatedDateTo: "2026-09-17",
    });
    const q = query(get);
    expect(q.createdDateFrom).toBe("2026-09-01");
    expect(q.updatedDateTo).toBe("2026-09-17");
  });

  it("echoes them back in `filters`, so the total is not captioned as unrestricted", async () => {
    // The filters block is what a caller reads back to label the number. A bound that
    // is applied to the scan but missing from the echo turns an honest total into a
    // mislabelled one ("all time" over a one-week window).
    const { handlers } = setup();
    const result = (await handlers["summarize-vouchers"]({
      voucherType: "any",
      voucherStatus: "any",
      groupBy: "none",
      maxPages: 1,
      createdDateFrom: "2026-09-01",
      updatedDateTo: "2026-09-17",
    })) as { structuredContent: { filters: Record<string, unknown> } };
    expect(result.structuredContent.filters.createdDateFrom).toBe("2026-09-01");
    expect(result.structuredContent.filters.updatedDateTo).toBe("2026-09-17");
    for (const key of ["createdDateFrom", "createdDateTo", "updatedDateFrom", "updatedDateTo"]) {
      expect(key in result.structuredContent.filters).toBe(true);
    }
  });
});
