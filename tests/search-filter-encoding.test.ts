import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import type { LexwareClient } from "../src/lexware/client.js";
import { encodeSearchFilter } from "../src/lexware/search.js";
import { registerContactReadTools } from "../src/tools/contacts.js";

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
  registerContactReadTools(server, client);
  return { handlers, get };
}

function query(get: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return (get.mock.calls[0] as [string, Record<string, unknown>])[1];
}

describe("encodeSearchFilter", () => {
  it("HTML-encodes exactly the three characters Lexware asks for", () => {
    expect(encodeSearchFilter("johnson & partner")).toBe("johnson &amp; partner");
    expect(encodeSearchFilter("a < b")).toBe("a &lt; b");
    expect(encodeSearchFilter("a > b")).toBe("a &gt; b");
  });

  it("does not re-encode its own output", () => {
    // Sequential `replace` calls would turn "&" into "&amp;" and then into
    // "&amp;amp;", because the replacement text itself contains an ampersand.
    expect(encodeSearchFilter("&")).toBe("&amp;");
    expect(encodeSearchFilter("<&>")).toBe("&lt;&amp;&gt;");
    expect(encodeSearchFilter("&amp;")).toBe("&amp;amp;"); // already-encoded input is data, not markup
  });

  it("leaves everything else alone", () => {
    for (const value of ["Müller GmbH", "100%", "a_b", "O'Brien", "", "ä ö ü ß", "a+b", "x/y"]) {
      expect(encodeSearchFilter(value)).toBe(value);
    }
  });

  it("passes undefined through, so it can wrap an optional param", () => {
    expect(encodeSearchFilter(undefined)).toBeUndefined();
  });
});

describe("list-contacts search filters", () => {
  it("encodes name and email, so a contact with an ampersand is findable at all", async () => {
    // Verified live against a contact named "ZZZ Encoding Test & Co (...)":
    //   control (no special char) -> 1 match
    //   plain `&`                 -> 0 matches   <- the bug
    //   `&amp;`                   -> 1 match
    const { handlers, get } = setup();
    await handlers["list-contacts"]({ name: "Test & Co", email: "a&b@example.com" });
    const q = query(get);
    expect(q.name).toBe("Test &amp; Co");
    expect(q.email).toBe("a&amp;b@example.com");
  });

  it("leaves the non-search filters untouched", async () => {
    // Lexware documents that this encoding breaks other parameters, so it must reach
    // only the two substring filters.
    const { handlers, get } = setup();
    await handlers["list-contacts"]({ number: 10042, customer: true, vendor: false, page: 2, size: 50 });
    const q = query(get);
    expect(q.number).toBe(10042);
    expect(q.customer).toBe(true);
    expect(q.vendor).toBe(false);
    expect(q.page).toBe(2);
    expect(q.size).toBe(50);
  });

  it("does not disturb an ordinary name search", async () => {
    const { handlers, get } = setup();
    await handlers["list-contacts"]({ name: "FLOYT Mobility" });
    expect(query(get).name).toBe("FLOYT Mobility");
  });
});
