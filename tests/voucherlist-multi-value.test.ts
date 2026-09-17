import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
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

/** Register the read tools and keep both the handlers and their published schemas. */
function setup() {
  const get = vi.fn(async () => EMPTY_PAGE);
  const client = { get } as unknown as LexwareClient;
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
  return { handlers, schemas, get };
}

function query(get: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return (get.mock.calls[0] as [string, Record<string, unknown>])[1];
}

/** Parse an input against the tool's real published schema (the zod layer). */
function parseInput(name: string, input: Record<string, unknown>) {
  const { schemas } = setup();
  return z.object(schemas[name]).parse(input) as Record<string, unknown>;
}

describe("voucherlist type/status filter — the zod layer", () => {
  it("accepts a single value, an array, a comma string, and a JSON-encoded array", () => {
    expect(parseInput("get-voucherlist", { voucherStatus: "open" }).voucherStatus).toBe("open");
    expect(parseInput("get-voucherlist", { voucherStatus: ["open", "paid"] }).voucherStatus).toEqual([
      "open",
      "paid",
    ]);
    // Lexware's own wire format, and a plausible thing for a caller to reach for.
    expect(parseInput("get-voucherlist", { voucherStatus: "open,paid" }).voucherStatus).toEqual([
      "open",
      "paid",
    ]);
    expect(parseInput("get-voucherlist", { voucherStatus: "open, paid" }).voucherStatus).toEqual([
      "open",
      "paid",
    ]);
    // Clients that serialise array arguments as strings.
    expect(parseInput("get-voucherlist", { voucherStatus: '["open","paid"]' }).voucherStatus).toEqual([
      "open",
      "paid",
    ]);
  });

  it("rejects an empty entry rather than letting it reach the API", () => {
    // This is the whole reason the filter is an enum union and not a free string:
    // `voucherStatus=open,,paid` makes Lexware answer HTTP 500.
    expect(() => parseInput("get-voucherlist", { voucherStatus: "open,,paid" })).toThrow();
    expect(() => parseInput("get-voucherlist", { voucherStatus: "" })).toThrow();
    expect(() => parseInput("get-voucherlist", { voucherStatus: [] })).toThrow();
  });

  it("rejects a value outside the enum, in either branch", () => {
    expect(() => parseInput("get-voucherlist", { voucherStatus: "bogus" })).toThrow();
    expect(() => parseInput("get-voucherlist", { voucherStatus: ["open", "bogus"] })).toThrow();
    expect(() => parseInput("get-voucherlist", { voucherType: ["invoice", "nope"] })).toThrow();
  });

  it("still defaults to 'any'", () => {
    const parsed = parseInput("get-voucherlist", {});
    expect(parsed.voucherStatus).toBe("any");
    expect(parsed.voucherType).toBe("any");
  });

  it("PUBLISHES that default in the JSON Schema, not just at runtime", () => {
    // `.default()` has to sit inside the preprocess wrapper. Applied outside it lands
    // on a ZodPipe, and zod drops a pipe's default from the input JSON Schema: the
    // runtime default keeps working, so every parse test above still passes, while the
    // model silently stops being told what the default is — which is the only reason
    // it is declared. This asserts the published annotation, not the behaviour.
    const { schemas } = setup();
    const published = z.toJSONSchema(z.object(schemas["get-voucherlist"]), { io: "input" }) as {
      properties: Record<string, { default?: unknown; anyOf?: unknown[] }>;
    };
    expect(published.properties.voucherType.default).toBe("any");
    expect(published.properties.voucherStatus.default).toBe("any");
    // ...and the two branches are still both visible, with their allowed values.
    expect(published.properties.voucherStatus.anyOf).toHaveLength(2);
  });
});

describe("voucherlist type/status filter — the request it builds", () => {
  it("joins several values into the single comma-separated parameter Lexware takes", async () => {
    const { handlers, get } = setup();
    await handlers["get-voucherlist"]({
      voucherType: ["invoice", "quotation"],
      voucherStatus: ["open", "paid"],
    });
    const q = query(get);
    expect(q.voucherType).toBe("invoice,quotation");
    expect(q.voucherStatus).toBe("open,paid");
  });

  it("passes a single value through unchanged", async () => {
    const { handlers, get } = setup();
    await handlers["get-voucherlist"]({ voucherType: "invoice", voucherStatus: "any" });
    expect(query(get).voucherType).toBe("invoice");
    expect(query(get).voucherStatus).toBe("any");
  });

  it("refuses to combine 'any' with a concrete value", async () => {
    // Probed: the API answers 400 "voucherStatus filter 'any' cannot be used in
    // combination with other states". Caught here so it costs no request.
    const { handlers, get } = setup();
    await expect(
      handlers["get-voucherlist"]({ voucherType: "any", voucherStatus: ["any", "open"] }),
    ).rejects.toThrow(/'any' already matches every value/);
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses to combine 'overdue', which Lexware derives rather than stores", async () => {
    const { handlers, get } = setup();
    await expect(
      handlers["get-voucherlist"]({ voucherType: "any", voucherStatus: ["overdue", "open"] }),
    ).rejects.toThrow(/cannot be combined/);
    expect(get).not.toHaveBeenCalled();
  });

  it("treats a repeated uncombinable value as the single value it means", async () => {
    const { handlers, get } = setup();
    await handlers["get-voucherlist"]({ voucherType: "any", voucherStatus: ["any", "any"] });
    expect(query(get).voucherStatus).toBe("any");
  });

  it("never sends an empty filter value, whatever it is handed", async () => {
    // An empty value is not a 400, it is an HTTP 500 ("A technical error has
    // occurred"), and buildUrl only omits `undefined` — so `""` would reach the wire
    // as `voucherType=`. The zod layer supplies the default in production, but this
    // handler is driven directly in tests and must not depend on that.
    const { handlers, get } = setup();
    await handlers["get-voucherlist"]({});
    const q = query(get);
    expect(q.voucherType).toBe("any");
    expect(q.voucherStatus).toBe("any");
    for (const empty of [[], [""], "", undefined]) {
      const fresh = setup();
      await fresh.handlers["get-voucherlist"]({ voucherType: empty, voucherStatus: empty });
      expect(query(fresh.get).voucherType).toBe("any");
      expect(query(fresh.get).voucherStatus).toBe("any");
    }
  });

  it("applies the same joining to summarize-vouchers", async () => {
    const { handlers, get } = setup();
    await handlers["summarize-vouchers"]({
      voucherType: ["invoice", "creditnote"],
      voucherStatus: "any",
      groupBy: "none",
      maxPages: 1,
    });
    expect(query(get).voucherType).toBe("invoice,creditnote");
  });
});
