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
  "get-invoice",
  "get-quotation",
  "get-credit-note",
  "get-order-confirmation",
  "get-delivery-note",
  "get-dunning",
  "get-down-payment-invoice",
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
  // expansion: file download, document PDF render, recurring-template list
  "download-file",
  "render-invoice-pdf",
  "render-quotation-pdf",
  "render-credit-note-pdf",
  "render-delivery-note-pdf",
  "render-order-confirmation-pdf",
  "render-dunning-pdf",
  "render-down-payment-invoice-pdf",
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
  registerTools(fakeServer, {} as unknown as LexwareClient, config, new TicketStore(), "https://mcp.example.test");
  return names.sort();
}

const TOKEN = "a".repeat(40);
const env = (extra: Record<string, string> = {}) =>
  ({ LEXWARE_API_KEY: "k", MCP_AUTH_TOKEN: TOKEN, ...extra }) as NodeJS.ProcessEnv;

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

  it("finalize implies drafts: enabling finalize with drafts off still registers drafts", () => {
    // Guards against a config that exposes ONLY the irreversible create-finalized-*
    // tools (no safe draft path).
    const names = registeredNames(
      loadConfig(env({ LEXWARE_ENABLE_DRAFTS: "false", LEXWARE_ENABLE_FINALIZE: "true" })),
    );
    expect(names).toEqual([...READ_TOOLS, ...DRAFT_TOOLS, ...FINALIZE_TOOLS].sort());
  });
});
