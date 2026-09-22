import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { DESTRUCTIVE, RO, text, WRITE, deleteIdempotent } from "./shared.js";

/** Read tools for event subscriptions (webhooks). Always registered. */
export function registerEventSubscriptionReadTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "list-event-subscriptions",
      title: "List webhook subscriptions",
      description: "List webhook event subscriptions configured for this organization.",
      annotations: RO,
    },
    async () => {
      const data = await client.get<unknown>("/v1/event-subscriptions");
      return { structuredContent: { data }, content: text("Retrieved event subscriptions.") };
    },
  );

  server.registerTool(
    {
      name: "get-event-subscription",
      title: "Get webhook subscription",
      description: "Get a single event subscription by id.",
      inputSchema: { id: z.string() },
      annotations: RO,
    },
    async ({ id }) => {
      const sub = await client.get<Record<string, unknown>>(`/v1/event-subscriptions/${encodeURIComponent(id)}`);
      return { structuredContent: sub, content: text(`Event subscription ${id} retrieved.`) };
    },
  );
}

/**
 * Write tools for event subscriptions (webhooks). Registered with the FINALIZE tier
 * (off by default): a webhook streams financial events to an arbitrary external URL,
 * so creating one is a data-exfiltration-capable operation and deleting one severs a
 * possibly third-party integration. Both are gated behind an explicit opt-in and kept
 * symmetric (whoever can create can delete). See registerTools in ./index.ts.
 */
export function registerEventSubscriptionWriteTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "create-event-subscription",
      title: "Create webhook subscription",
      description:
        "Subscribe a callback URL to a Lexware event type (webhook), e.g. eventType 'invoice.created'. Sends future " +
        "event notifications to an EXTERNAL URL, so treat the target as trusted. The callback URL must be https:// " +
        "and serve a Grade-A HTTPS certificate.",
      inputSchema: {
        eventType: z.string().describe("e.g. 'invoice.created', 'invoice.status.changed'."),
        callbackUrl: z
          .string()
          .url()
          .refine((u) => u.startsWith("https://"), { message: "callbackUrl must be https://." })
          .describe("HTTPS endpoint that will receive events (Lexware requires a Grade-A HTTPS certificate)."),
      },
      annotations: WRITE,
    },
    async ({ eventType, callbackUrl }) => {
      const created = await client.post<{ subscriptionId?: string; id?: string }>(
        "/v1/event-subscriptions",
        { eventType, callbackUrl },
      );
      const id = created.subscriptionId ?? created.id ?? "";
      return {
        structuredContent: created,
        content: text(`Created event subscription ${id} for ${eventType}.`),
      };
    },
  );
}

/**
 * Delete (unsubscribe) an event subscription. Registered with the FINALIZE tier,
 * symmetric with create-event-subscription (both are gated together): it can sever a
 * webhook belonging to any integration on the org, so it stays behind the explicit
 * opt-in rather than being available by default.
 */
export function registerEventSubscriptionDeleteTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "delete-event-subscription",
      title: "Delete webhook subscription",
      description: "Delete (unsubscribe) an event subscription by id. Stops the webhook; recreate it to re-subscribe.",
      inputSchema: { id: z.string() },
      annotations: DESTRUCTIVE,
    },
    async ({ id }) => {
      const { alreadyAbsent } = await deleteIdempotent(
        client,
        `/v1/event-subscriptions/${encodeURIComponent(id)}`,
      );
      return {
        structuredContent: { id, deleted: true, alreadyAbsent },
        content: text(
          alreadyAbsent
            ? `Event subscription ${id} was already absent (nothing to delete).`
            : `Deleted event subscription ${id}.`,
        ),
      };
    },
  );
}
