import type { McpServer } from "skybridge/server";
import type { Config } from "../config.js";
import type { LexwareClient } from "../lexware/client.js";
import type { TicketStore } from "../uploads/tickets.js";
import {
  registerArticleDeleteTools,
  registerArticleReadTools,
  registerArticleWriteTools,
} from "./articles.js";
import { registerContactDraftTools, registerContactReadTools } from "./contacts.js";
import {
  registerDocumentDraftTools,
  registerDocumentFinalizeTools,
  registerDocumentReadTools,
} from "./documents.js";
import {
  registerEventSubscriptionDeleteTools,
  registerEventSubscriptionReadTools,
  registerEventSubscriptionWriteTools,
} from "./event-subscriptions.js";
import { registerFileReadTools, registerFileWriteTools } from "./files.js";
import { registerProfileTools } from "./profile.js";
import { registerReferenceReadTools } from "./reference.js";
import { registerUploadTools } from "./uploads.js";
import { registerVoucherWriteTools } from "./vouchers.js";

/**
 * Register MCP tools according to the resolved capability tiers. Only enabled
 * tiers are registered — a disabled tool is never advertised to the model.
 */
export function registerTools(
  server: McpServer,
  client: LexwareClient,
  config: Config,
  uploadTickets: TicketStore,
): void {
  const { capabilities } = config;

  // Read tier — always on.
  registerProfileTools(server, client);
  registerContactReadTools(server, client);
  registerArticleReadTools(server, client);
  registerDocumentReadTools(server, client, config.lexwareAppBaseUrl);
  registerReferenceReadTools(server, client);
  registerFileReadTools(server, client);
  registerEventSubscriptionReadTools(server, client);

  // Draft / write tier (create drafts + non-binding updates).
  if (capabilities.drafts) {
    registerContactDraftTools(server, client);
    registerArticleWriteTools(server, client);
    registerDocumentDraftTools(server, client);
    registerVoucherWriteTools(server, client);
    registerFileWriteTools(server, client);
    registerUploadTools(server, uploadTickets, config.publicBaseUrl);
  }

  // Finalize / sensitive & irreversible tier (off by default).
  if (capabilities.finalize) {
    registerDocumentFinalizeTools(server, client);
    registerArticleDeleteTools(server, client);
    // Event-subscription create + delete are gated here (not drafts): a webhook streams
    // financial events to an arbitrary external URL (exfiltration-capable) and delete can
    // sever a third-party integration, so both are opt-in and registered together.
    registerEventSubscriptionWriteTools(server, client);
    registerEventSubscriptionDeleteTools(server, client);
  }
}
