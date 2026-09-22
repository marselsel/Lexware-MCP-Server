import type { McpServer } from "skybridge/server";
import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import type { LexwareClient } from "../src/lexware/client.js";
import { registerTools } from "../src/tools/index.js";
import { TicketStore } from "../src/uploads/tickets.js";

const READ_TOOLS = [
  "get-profile",
  "list-contacts",
  "get-contact",
  "list-articles",
  "get-article",
  "get-voucherlist",
  "summarize-vouchers",
  "get-voucher",
  "get-vouchers",
  "get-document",
  "get-document-file",
  "get-voucher-file",
  "get-document-link",
  "get-countries",
  "get-payment-conditions",
  "get-posting-categories",
  "get-print-layouts",
  "get-payment",
  "get-recurring-template",
  "list-event-subscriptions",
  "get-event-subscription",
  // expansion: file download, recurring-template list
  "download-file",
  "list-recurring-templates",
];
const DRAFT_TOOLS = [
  "create-contact",
  "update-contact",
  "create-article",
  "update-article",
  "create-draft-invoice",
  "create-draft-quotation",
  "create-draft-credit-note",
  "create-draft-order-confirmation",
  "create-draft-delivery-note",
  "create-draft-dunning",
  // expansion: bookkeeping vouchers + receipts, file upload
  "create-voucher",
  "update-voucher",
  "upload-voucher-file",
  "upload-file",
  // expansion: ticket-gated upload, no base64 through the model context
  "create-upload-ticket",
  "get-upload-result",
];
const FINALIZE_TOOLS = [
  "create-finalized-invoice",
  "create-finalized-quotation",
  "create-finalized-credit-note",
  "create-finalized-order-confirmation",
  "create-finalized-delivery-note",
  "create-finalized-dunning",
  // expansion: destructive article delete (finalize tier)
  "delete-article",
  // event-subscription create + delete are gated together in the finalize tier: a webhook
  // to an arbitrary external URL is exfiltration-capable, so it is opt-in, not default-on.
  "create-event-subscription",
  "delete-event-subscription",
];

/** Capture which tool names get registered for a given config. */
function registeredNames(config: Config): string[] {
  const names: string[] = [];
  const fakeServer = {
    registerTool(cfg: { name: string }) {
      names.push(cfg.name);
      return fakeServer;
    },
  } as unknown as McpServer;
  registerTools(fakeServer, {} as unknown as LexwareClient, config, new TicketStore());
  return names.sort();
}

interface ToolDef {
  name: string;
  title?: string;
  outputSchema?: unknown;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** Capture the full config of every registered tool for a given config. */
function registeredDefs(config: Config): ToolDef[] {
  const defs: ToolDef[] = [];
  const fakeServer = {
    registerTool(cfg: ToolDef) {
      defs.push(cfg);
      return fakeServer;
    },
  } as unknown as McpServer;
  registerTools(fakeServer, {} as unknown as LexwareClient, config, new TicketStore());
  return defs;
}

const TOKEN = "a".repeat(40);
const env = (extra: Record<string, string> = {}) =>
  ({ LEXWARE_API_KEY: "k", MCP_AUTH_TOKEN: TOKEN, ...extra }) as NodeJS.ProcessEnv;

describe("tool metadata", () => {
  // Every tier on, so no tool escapes the checks.
  const defs = registeredDefs(
    loadConfig(env({ LEXWARE_ENABLE_FINALIZE: "true", LEXWARE_ENABLE_URL_UPLOAD: "true" })),
  );

  it("gives every tool a distinct human-readable title", () => {
    const untitled = defs.filter((d) => !d.title?.trim()).map((d) => d.name);
    expect(untitled).toEqual([]);
    const titles = defs.map((d) => d.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("declares no outputSchema while Claude's clients still fail on them (see shared.ts)", () => {
    expect(defs.filter((d) => d.outputSchema !== undefined).map((d) => d.name)).toEqual([]);
  });

  it("mirrors the title into annotations.title, which Anthropic's directory checklist reads", () => {
    for (const d of defs) expect(d.annotations?.title, d.name).toBe(d.title);
  });

  it("marks exactly the overwriting, deleting and irreversible tools destructive", () => {
    // Clients prompt a human before a destructive tool runs. That confirmation is the
    // real gate on finalizing: confirm_finalize is a value the model sets itself.
    const destructive = defs.filter((d) => d.annotations?.destructiveHint).map((d) => d.name);
    expect(destructive.sort()).toEqual(
      defs
        .map((d) => d.name)
        .filter((n) => /^(update|delete|create-finalized)-/.test(n))
        .sort(),
    );
  });

  it("marks every read tool read-only, and no write tool", () => {
    for (const d of defs) {
      const isRead = READ_TOOLS.includes(d.name) || d.name === "get-upload-result";
      expect(d.annotations?.readOnlyHint, d.name).toBe(isRead);
    }
  });
});

describe("registerTools (tiered registration)", () => {
  it("read-only registers exactly the read tools", () => {
    const names = registeredNames(loadConfig(env({ LEXWARE_READ_ONLY: "true" })));
    expect(names).toEqual([...READ_TOOLS].sort());
  });

  it("default registers read + draft tools (no finalize)", () => {
    const names = registeredNames(loadConfig(env()));
    expect(names).toEqual([...READ_TOOLS, ...DRAFT_TOOLS].sort());
    expect(names).not.toContain("create-finalized-invoice");
  });

  it("finalize tier adds the finalize tool", () => {
    const names = registeredNames(loadConfig(env({ LEXWARE_ENABLE_FINALIZE: "true" })));
    expect(names).toEqual([...READ_TOOLS, ...DRAFT_TOOLS, ...FINALIZE_TOOLS].sort());
  });

  it("never registers a disabled tier's tools", () => {
    const names = registeredNames(loadConfig(env({ LEXWARE_ENABLE_DRAFTS: "false" })));
    expect(names).toEqual([...READ_TOOLS].sort());
  });

  it("does NOT register upload-file-from-url by default — the outbound fetcher is opt-in", () => {
    const names = registeredNames(loadConfig(env()));
    expect(names).not.toContain("upload-file-from-url");
  });

  it("registers upload-file-from-url only when LEXWARE_ENABLE_URL_UPLOAD is on", () => {
    const names = registeredNames(loadConfig(env({ LEXWARE_ENABLE_URL_UPLOAD: "true" })));
    expect(names).toEqual([...READ_TOOLS, ...DRAFT_TOOLS, "upload-file-from-url"].sort());
  });

  it("does not register it in read-only mode, even when explicitly enabled", () => {
    // The flag says "yes" and the tier says "no". A tool that writes a file into the
    // bookkeeping must never win that argument.
    const names = registeredNames(
      loadConfig(env({ LEXWARE_READ_ONLY: "true", LEXWARE_ENABLE_URL_UPLOAD: "true" })),
    );
    expect(names).toEqual([...READ_TOOLS].sort());
  });

  it("does not register it when the drafts tier is off, even when explicitly enabled", () => {
    const names = registeredNames(
      loadConfig(env({ LEXWARE_ENABLE_DRAFTS: "false", LEXWARE_ENABLE_URL_UPLOAD: "true" })),
    );
    expect(names).toEqual([...READ_TOOLS].sort());
  });

  it("finalize implies drafts: enabling finalize with drafts off still registers drafts", () => {
    // Guards against a config that exposes ONLY the irreversible create-finalized-*
    // tools (no safe draft path).
    const names = registeredNames(
      loadConfig(env({ LEXWARE_ENABLE_DRAFTS: "false", LEXWARE_ENABLE_FINALIZE: "true" })),
    );
    expect(names).toEqual([...READ_TOOLS, ...DRAFT_TOOLS, ...FINALIZE_TOOLS].sort());
  });
});

describe("tool results carry the structured data as text", () => {
  it("adds the serialized structuredContent to what every registered handler returns", async () => {
    // Through registerTools, so the wiring is what is tested, not only the helper: a client
    // that shows the model only `content` must still see the document, not just a summary.
    const handlers: Record<string, (args: unknown) => Promise<{ content: { type: string; text?: string }[]; structuredContent: unknown }>> = {};
    const fakeServer = {
      registerTool(cfg: { name: string }, handler: (typeof handlers)[string]) {
        handlers[cfg.name] = handler;
        return fakeServer;
      },
    } as unknown as McpServer;
    const profile = { organizationId: "org-1", companyName: "Acme GmbH" };
    const client = { get: async () => profile } as unknown as LexwareClient;
    registerTools(fakeServer, client, loadConfig(env()), new TicketStore());

    const result = await handlers["get-profile"]({});
    expect(result.content.at(-1)).toEqual({ type: "text", text: JSON.stringify(result.structuredContent) });
    expect(result.content.at(-1)?.text).toContain("Acme GmbH");
  });
});
