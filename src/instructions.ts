import type { Capabilities } from "./config.js";

/**
 * The MCP `instructions` a client reads when it connects (the initialize result, or
 * `server/discover` on the 2026-07-28 protocol): how the tools fit together, which no
 * single tool description can say.
 *
 * Built from the capability tiers so it never mentions a tool the server did not
 * register — a line about create-finalized-* on a drafts-only deployment would point
 * the model at something that does not exist.
 *
 * Written as description, not command. Claude's connector review treats instructions
 * that steer the model ("always call X first") as prompt injection, and the model
 * follows a stated fact about the API about as well as an order anyway.
 */
export function buildServerInstructions(capabilities: Capabilities): string {
  const lines = [
    "Lexware Office accounting: contacts, articles, sales documents (invoices, quotations, credit notes, " +
      "order confirmations, delivery notes, dunnings), bookkeeping vouchers and their files.",
    "The Lexware API allows about 2 requests per second, so tools that do the paging server-side are " +
      "much faster than repeated calls: summarize-vouchers totals the voucher list by type, status, month, " +
      "contact or currency, and get-vouchers fetches up to 50 vouchers in one call.",
    "get-voucherlist is the index of every financial document. Its voucherNumber filter is the only way to " +
      "find a document by its number (exact match). A voucherlist row resolves to the full document with " +
      "get-document(id, voucherType), and to its PDF with get-document-file.",
    "Dates: the voucherlist date filters take yyyy-MM-dd; document and voucher bodies take a full ISO " +
      "datetime with offset (2026-07-06T00:00:00.000+02:00).",
  ];

  if (capabilities.drafts) {
    lines.push(
      "create-draft-* creates an editable draft that is not legally issued. The API cannot change or delete " +
        "a sales document after creation, so a wrong draft stays until someone removes it in the Lexware web app.",
      "The update-* tools are read-modify-write: fields left out keep their current value.",
      "create-upload-ticket moves a file into Lexware without its bytes passing through the conversation: " +
        "it returns a browser link and a curl command, and get-upload-result reads the file id after a " +
        "browser upload. upload-file takes the file as base64 instead.",
    );
  } else {
    lines.push("This server is read-only: it cannot create or change anything in Lexware.");
  }

  if (capabilities.finalize) {
    lines.push(
      "create-finalized-* issues a legally binding document that can never be edited or deleted afterwards.",
    );
  }

  return lines.join("\n\n");
}
