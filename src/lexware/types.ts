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

/** Voucher types accepted by `GET /v1/voucherlist` (`any` matches all). */
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
  "dunning",
  "recurringtemplate",
] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

/** Voucher statuses accepted by `GET /v1/voucherlist` (`any` matches all). */
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
  "paymentordered",
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
