import { describe, expect, it } from "vitest";
import { VOUCHER_STATUSES, VOUCHER_TYPES } from "../src/lexware/types.js";

/**
 * These two sets are the voucherlist FILTER vocabulary. Every value in them was probed
 * individually against the live Lexware API (one `GET /v1/voucherlist` per value).
 *
 * A value the API rejects is worse than a missing one: it is advertised to the model as
 * a valid choice, so the model will pick it and can only ever get a
 * `400 Invalid value '…' received for request parameter '…'` back. That is why these
 * lists are pinned exactly rather than spot-checked.
 */
describe("voucherlist filter vocabulary", () => {
  const types = [...VOUCHER_TYPES] as string[];
  const statuses = [...VOUCHER_STATUSES] as string[];

  it("offers no voucherType the API rejects", () => {
    // Both probed 400. They are real document types with their own endpoints, but the
    // voucherlist does not accept them as filters — dunnings and recurring templates
    // simply never appear as rows in it.
    expect(types).not.toContain("dunning");
    expect(types).not.toContain("recurringtemplate");
  });

  it("offers no voucherStatus the API rejects", () => {
    expect(statuses).not.toContain("paymentordered"); // probed 400
  });

  it("can filter the uncategorized receipt inbox", () => {
    // The whole Belege-Eingang workflow hangs off these two. Without `unchecked` the
    // only way to reach an uncategorized receipt is to page the entire voucherlist
    // under `any` and filter client-side.
    expect(statuses).toContain("unchecked");
    expect(statuses).toContain("blank");
  });

  it("pins the full accepted sets", () => {
    expect([...types].sort()).toEqual([
      "any",
      "creditnote",
      "deliverynote",
      "downpaymentinvoice",
      "invoice",
      "orderconfirmation",
      "purchasecreditnote",
      "purchaseinvoice",
      "quotation",
      "salescreditnote",
      "salesinvoice",
    ]);
    expect([...statuses].sort()).toEqual([
      "accepted",
      "any",
      "blank",
      "draft",
      "open",
      "overdue",
      "paid",
      "paidoff",
      "rejected",
      "sepadebit",
      "transferred",
      "unchecked",
      "voided",
    ]);
  });
});
