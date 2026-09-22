import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { additionalFieldsParam, mergeBody, versionParam, voucherInputShape, voucherUpdateShape } from "./schemas.js";
import { DESTRUCTIVE, WRITE, decodeBase64Strict, deepMergePatch, text } from "./shared.js";

/** Voucher statuses lexoffice DERIVES from payments — re-sending them on PUT is rejected (invalid_value). */
const DERIVED_VOUCHER_STATUSES = new Set(["paid", "paidoff", "voided", "transferred", "sepadebit"]);

/**
 * Write tools for bookkeeping vouchers (manually-booked sales/purchase
 * transactions). Reads live in documents.ts (get-voucher, get-voucherlist).
 * Registered with the drafts tier.
 */
export function registerVoucherWriteTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "create-voucher",
      title: "Create voucher",
      description:
        "Create a bookkeeping voucher (a manually-booked sales/purchase transaction). Returns the new id. " +
        "To attach a receipt afterwards, use upload-voucher-file.",
      inputSchema: { ...voucherInputShape, additionalFields: additionalFieldsParam },
      annotations: WRITE,
    },
    async ({ additionalFields, ...input }) => {
      // `version` must be 0 when creating (optimistic locking), mirroring contacts.
      const body: Record<string, unknown> = { version: 0, ...mergeBody(input, additionalFields) };
      // A referenced contactId can't coexist with a custom contactName (lexoffice 406).
      if (input.contactId) {
        delete body.contactName;
        body.useCollectiveContact = false;
      }
      const created = await client.post<{ id: string }>("/v1/vouchers", body);
      return { structuredContent: created, content: text(`Created voucher ${created.id}.`) };
    },
  );

  server.registerTool(
    {
      name: "update-voucher",
      title: "Update voucher",
      description:
        "Update a bookkeeping voucher. Read-modify-write: the current voucher is fetched and your fields are " +
        "merged over it, so attached files and untouched fields (voucherNumber, contact, …) are preserved. Send " +
        "only what you change, e.g. { id, voucherItems: [...] }. voucherItems and files REPLACE the whole list. " +
        "To link a real contact pass contactId (its custom contactName is auto-cleared and useCollectiveContact " +
        'set false); for a one-off pass contactName. voucherStatus paid/voided/transferred/sepadebit are ' +
        "payment-derived: an unset status is omitted so a paid-but-not-filed voucher stays editable; pass " +
        'voucherStatus:"voided" (voiding) and deleting are NOT supported via the public API — UI-only Storno. NOTE: ' +
        "vouchers in an already-filed VAT period are festgeschrieben and cannot be modified or deleted via API " +
        "(web-app Storno only); there is no DELETE endpoint for vouchers. Pass `version` for optimistic locking " +
        "(omit for latest).",
      inputSchema: {
        id: z.string(),
        version: versionParam("get-voucher"),
        ...voucherUpdateShape,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ id, version, ...fields }) => {
      // Read-modify-write: lexoffice PUT replaces the whole resource, so load the
      // current voucher and merge the caller's fields over it (keeping files etc.).
      const current = await client.get<Record<string, unknown>>(`/v1/vouchers/${encodeURIComponent(id)}`);
      const body = deepMergePatch(current, {
        ...fields,
        version: version ?? (current.version as number),
      });
      // A1: a referenced contactId can't coexist with a custom contactName (lexoffice:
      // custom_contact_name_for_referenced_contact_not_allowed). Whichever the caller
      // sets wins; the other is dropped from the merged body so they never coexist.
      if (fields.contactId) {
        delete body.contactName;
        body.useCollectiveContact = false;
      } else if (fields.contactName) {
        // Switching to a one-off name: drop the contactId carried over from the current
        // voucher (the schema can't express contactId:null), and book to the collective
        // contact — lexoffice pairs a custom contactName with useCollectiveContact:true.
        delete body.contactId;
        body.useCollectiveContact = true;
      }
      // B1: omit a payment-derived voucherStatus unless the caller set one explicitly, so a
      // paid-but-not-filed voucher stays editable (and an explicit "voided" is still attempted).
      if (fields.voucherStatus === undefined && DERIVED_VOUCHER_STATUSES.has(String(body.voucherStatus))) {
        delete body.voucherStatus;
      }
      const updated = await client.request<{ id: string; version: number }>(
        "PUT",
        `/v1/vouchers/${encodeURIComponent(id)}`,
        { body, idempotent: false },
      );
      return {
        structuredContent: updated,
        content: text(`Updated voucher ${id} (now version ${updated.version}).`),
      };
    },
  );

  server.registerTool(
    {
      name: "upload-voucher-file",
      title: "Attach file to voucher",
      description:
        "Attach a file (receipt/scan) to a bookkeeping voucher via POST /v1/vouchers/{id}/files. Provide the " +
        "file as base64 (inline; ~12 MB body cap, so keep the source under ~8 MB). To RE-LINK an already-uploaded " +
        "file by id without re-sending bytes, set the voucher's `files` array via update-voucher instead.",
      inputSchema: {
        id: z.string().describe("The voucher id to attach the file to."),
        fileBase64: z.string().describe("File contents, base64-encoded."),
        filename: z.string().describe('e.g. "receipt.pdf".'),
        mimeType: z.string().describe('Content type, e.g. "application/pdf" or "image/png".'),
      },
      annotations: WRITE,
    },
    async ({ id, fileBase64, filename, mimeType }) => {
      const bytes = decodeBase64Strict(fileBase64, "fileBase64");
      const result = await client.postMultipart<Record<string, unknown>>(
        `/v1/vouchers/${encodeURIComponent(id)}/files`,
        { bytes, filename, contentType: mimeType },
      );
      return {
        structuredContent: result,
        content: text(`Attached ${filename} to voucher ${id}.`),
      };
    },
  );
}
