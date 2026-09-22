import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { pageParam, sizeParam } from "./schemas.js";
import { RO, text } from "./shared.js";

/**
 * Read-only reference + supporting data. Always registered.
 * These help the model build valid documents (tax/country/payment metadata) and
 * inspect payments and recurring templates.
 */
export function registerReferenceReadTools(server: McpServer, client: LexwareClient): void {
  const simpleGet = (name: string, title: string, path: string, description: string) =>
    server.registerTool({ name, title, description, annotations: RO }, async () => {
      const data = await client.get<unknown>(path);
      return {
        structuredContent: { data },
        content: text(`Retrieved ${name.replace(/^get-/, "")}.`),
      };
    });

  simpleGet("get-countries", "List countries", "/v1/countries", "List countries with tax classification data.");
  simpleGet("get-payment-conditions", "List payment conditions", "/v1/payment-conditions", "List configured payment conditions.");
  simpleGet("get-posting-categories", "List posting categories", "/v1/posting-categories", "List bookkeeping posting categories.");
  simpleGet("get-print-layouts", "List print layouts", "/v1/print-layouts", "List available document print layouts.");

  server.registerTool(
    {
      name: "get-payment",
      title: "Get payment status",
      description:
        "Get payment information for a voucher/document by its id. NOTE: this is the only payment data the " +
        "public API exposes — there is no general bank-transaction read/assignment endpoint, no DATEV export, " +
        "and tax returns (e.g. USt-Voranmeldung) are not available via the API, so VAT/§13b reconciliation " +
        "can't be fully automated.",
      inputSchema: { id: z.string() },
      annotations: RO,
    },
    async ({ id }) => {
      const payment = await client.get<Record<string, unknown>>(`/v1/payments/${encodeURIComponent(id)}`);
      return { structuredContent: payment, content: text(`Payment info for ${id} retrieved.`) };
    },
  );

  server.registerTool(
    {
      name: "get-recurring-template",
      title: "Get recurring template",
      description: "Get a recurring-invoice template by id.",
      inputSchema: { id: z.string() },
      annotations: RO,
    },
    async ({ id }) => {
      const tmpl = await client.get<Record<string, unknown>>(`/v1/recurring-templates/${encodeURIComponent(id)}`);
      return { structuredContent: tmpl, content: text(`Recurring template ${id} retrieved.`) };
    },
  );

  server.registerTool(
    {
      name: "list-recurring-templates",
      title: "List recurring templates",
      description: "List recurring-invoice templates. Results may be paged (use page/size).",
      inputSchema: {
        page: pageParam,
        size: sizeParam,
      },
      annotations: RO,
    },
    async ({ page, size }) => {
      const data = await client.get<unknown>("/v1/recurring-templates", { page, size });
      return { structuredContent: { data }, content: text("Retrieved recurring templates.") };
    },
  );
}
