/**
 * Lightweight types for the Lexware Office endpoints this server uses.
 *
 * Kept intentionally partial: we model only the fields we read/return, and let
 * full payloads pass through as `structuredContent`. Some values (enum sets,
 * page-size limits) are flagged in the plan to verify against the live API.
 */

/** Spring-Data style pagination envelope used by Lexware list endpoints. */
export interface Paged<T> {
  content: T[];
  first: boolean;
  last: boolean;
  number: number;
  numberOfElements: number;
  size: number;
  totalPages: number;
  totalElements: number;
}

/**
 * Voucher types accepted by `GET /v1/voucherlist` (`any` matches all).
 *
 * This is the set of valid *filter* values, which is narrower than the set of
 * document types the API has: `dunning` and `recurringtemplate` are real
 * documents with their own endpoints, but the voucherlist rejects both with
 * `400 Invalid value '…' received for request parameter 'voucherType'`. Every
 * value below was probed against the live API; do not add one back without
 * doing the same, because an unaccepted value here is advertised to the model
 * as a valid choice and can only fail.
 *
 * Dunnings and recurring templates are still reachable — via `get-document` and
 * `list-recurring-templates` respectively.
 */
export const VOUCHER_TYPES = [
  "any",
  "salesinvoice",
  "salescreditnote",
  "purchaseinvoice",
  "purchasecreditnote",
  "invoice",
  "downpaymentinvoice",
  "creditnote",
  "orderconfirmation",
  "quotation",
  "deliverynote",
] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

/**
 * Voucher statuses accepted by `GET /v1/voucherlist` (`any` matches all).
 *
 * Same rule as {@link VOUCHER_TYPES}: probed against the live API. `unchecked`
 * is the uncategorized receipt inbox (Belege-Eingang) and `blank` is the
 * transient state while Lexware runs OCR on a freshly uploaded receipt, so
 * both are needed to work the inbox at all. `blank` is accepted by the filter
 * although Lexware's filter documentation omits it (it is documented as a
 * voucher status elsewhere). `paymentordered` is NOT accepted and was removed.
 *
 * Note `overdue` cannot be combined with another status — Lexware derives it
 * from the due date rather than storing it.
 */
export const VOUCHER_STATUSES = [
  "any",
  "draft",
  "open",
  "paid",
  "paidoff",
  "voided",
  "transferred",
  "sepadebit",
  "overdue",
  "accepted",
  "rejected",
  "unchecked",
  "blank",
] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];

/**
 * Fields `GET /v1/voucherlist` can sort by. Probed against the live API: each of these
 * returns 200, and anything else fails with `parameter 'sort' is invalid`. Lexware
 * takes the direction in the same parameter (`field,ASC` / `field,DESC`) and defaults
 * to `voucherDate` descending when `sort` is omitted.
 */
export const VOUCHERLIST_SORT_FIELDS = [
  "voucherDate",
  "voucherNumber",
  "createdDate",
  "updatedDate",
] as const;
export type VoucherlistSortField = (typeof VOUCHERLIST_SORT_FIELDS)[number];

/** A single row from the voucherlist index. */
export interface VoucherlistEntry {
  id: string;
  voucherType: string;
  voucherStatus: string;
  voucherNumber?: string;
  voucherDate?: string;
  dueDate?: string;
  contactName?: string;
  totalAmount?: number;
  openAmount?: number;
  currency?: string;
  archived?: boolean;
}
