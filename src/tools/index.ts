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
import { withJsonText } from "./shared.js";
import { registerReferenceReadTools } from "./reference.js";
import { registerUploadTools } from "./uploads.js";
import { registerUrlUploadTool } from "./url-upload.js";
import { registerVoucherWriteTools } from "./vouchers.js";

/** The part of a tool config {@link withAnnotationTitles} reads and rewrites. */
interface TitledToolConfig {
  title?: string;
  annotations?: Record<string, unknown>;
}

/**
 * Mirror every tool's `title` into `annotations.title`. The spec reads the top-level
 * `title` first, but Anthropic's directory checklist asks for `annotations.title`, and a
 * client may honour only one of them. One source, set in one place, so the two can't drift.
 *
 * Only `registerTool` is forwarded: that is the one method the register* functions call.
 */
function withAnnotationTitles(server: McpServer): McpServer {
  const registerTool = server.registerTool.bind(server) as (config: TitledToolConfig, ...rest: unknown[]) => unknown;
  return {
    registerTool: (config: TitledToolConfig, ...rest: unknown[]) =>
      registerTool(
        config.title ? { ...config, annotations: { ...config.annotations, title: config.title } } : config,
        ...rest,
      ),
  } as unknown as McpServer;
}

/**
 * Give every tool result a serialized copy of its `structuredContent` as text (see
 * {@link withJsonText}), by wrapping each handler once here instead of in ~40 of them.
 */
function withJsonTextResults(server: McpServer): McpServer {
  const registerTool = server.registerTool.bind(server) as (
    config: unknown,
    handler: (...args: unknown[]) => unknown,
  ) => unknown;
  return {
    registerTool: (config: unknown, handler: (...args: unknown[]) => unknown) =>
      registerTool(config, async (...args: unknown[]) => withJsonText(await handler(...args))),
  } as unknown as McpServer;
}

/**
 * Register MCP tools according to the resolved capability tiers. Only enabled
 * tiers are registered — a disabled tool is never advertised to the model.
 */
export function registerTools(
  mcpServer: McpServer,
  client: LexwareClient,
  config: Config,
  uploadTickets: TicketStore,
): void {
  const server = withJsonTextResults(withAnnotationTitles(mcpServer));
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

  // Gated separately from the drafts tier, not nested inside it: config.capabilities
  // already resolves urlUpload to false whenever drafts are off, so the flat check
  // states the actual precondition instead of restating it in two places.
  if (capabilities.urlUpload) {
    registerUrlUploadTool(server, client, config.uploadAllowedHosts);
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
