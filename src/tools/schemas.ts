import { z } from "zod";
import { DEFAULT_PAGE_SIZE } from "./shared.js";

/**
 * Shared zod schemas for Lexware write payloads.
 *
 * These are intentionally lenient (`.passthrough()` keeps unknown keys on nested
 * objects) because the full Lexware document schema is large and version-dependent.
 * We validate the load-bearing required fields and forward the rest untouched.
 *
 * IMPORTANT: `.passthrough()` only preserves unknown keys INSIDE a typed sub-object.
 * The MCP SDK compiles each tool's top-level input shape with a strip-mode
 * `z.object`, so an unknown TOP-LEVEL field (e.g. `xRechnung` on an invoice) would
 * be silently dropped before the handler runs. Every create tool therefore exposes an
 * `additionalFields` escape hatch ({@link additionalFieldsParam}), merged into the
 * request body via {@link mergeBody}, so a valid Lexware field we don't model can
 * still be sent.
 */

/**
 * Wrap an object/array schema so the tool ALSO accepts the value as a JSON string.
 * Some MCP clients serialise nested object/array arguments as a string, which would
 * otherwise fail Zod with "expected object, received string". `z.preprocess` keeps the
 * published JSON Schema's input type intact (verified), so this is purely additive.
 */
export const jsonObj = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => {
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return value; // leave as-is so Zod reports a precise error
      }
    }
    return value;
  }, schema);

/** Accept a boolean param a client serialised as the string "true"/"false". */
export const jsonBool = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), schema);

/** Accept a numeric param a client serialised as a string (e.g. "25"). */
export const jsonNum = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v),
    schema,
  );

/** Optimistic-locking `version` param (number, string-coerced) for update tools. */
export const versionParam = (noun: string) =>
  jsonNum(z.number().int().optional()).describe(
    `Current version from ${noun} (optimistic lock). Omit to use the latest.`,
  );

/**
 * Escape hatch for valid Lexware body fields not modeled by a create tool's shape.
 * Top-level unknown keys are stripped by the SDK's strip-mode object (see the module
 * doc), so pass any such fields here (e.g. { xRechnung: {...} }) to have them merged
 * into the request body. Typed fields on the tool take precedence over these.
 */
export const additionalFieldsParam = jsonObj(z.record(z.string(), z.unknown()))
  .optional()
  .describe(
    "Extra Lexware body fields not covered by this tool's parameters (e.g. xRechnung), merged into the " +
      "request as-is. Use only for valid API fields the tool doesn't already expose.",
  );

/**
 * Keys that must never be smuggled into a request body via {@link additionalFieldsParam}:
 * they are query/control parameters (finalize is a query flag; version/id are managed by
 * the tool), so accepting them in the body would defeat tier gating or optimistic locking.
 */
const RESERVED_BODY_KEYS = new Set([
  "finalize",
  "confirm_finalize",
  "precedingSalesVoucherId",
  "version",
  "id",
]);

/**
 * Build a create/update request body: the tool's typed `input` merged OVER the
 * `additionalFields` escape hatch (so typed fields always win), with reserved
 * control keys stripped from the escape hatch first.
 */
export function mergeBody(
  input: Record<string, unknown>,
  additionalFields: unknown,
): Record<string, unknown> {
  const extra =
    additionalFields && typeof additionalFields === "object" && !Array.isArray(additionalFields)
      ? { ...(additionalFields as Record<string, unknown>) }
      : {};
  for (const k of RESERVED_BODY_KEYS) delete extra[k];
  return { ...extra, ...input };
}

/** Shared paging params for list tools (string-coerced). */
export const pageParam = jsonNum(z.number().int().min(0).default(0)).describe("0-based page index.");
export const sizeParam = jsonNum(z.number().int().min(1).max(250).default(DEFAULT_PAGE_SIZE)).describe(
  "Page size (max 250).",
);

export const moneySchema = z
  .object({
    currency: z.string().default("EUR").describe("ISO currency; Lexware supports EUR."),
    netAmount: z.number().optional(),
    grossAmount: z.number().optional(),
    taxRatePercentage: z.number().optional().describe("Tax rate, e.g. 19 or 7 or 0."),
  })
  .passthrough();

export const lineItemSchema = z
  .object({
    type: z.string().describe('Line type, e.g. "custom", "material", "service", "text".'),
    name: z.string().describe("Position name. Lexware documents a 255-character limit."),
    description: z
      .string()
      .optional()
      .describe(
        "Position description. Lexware documents a 2000-character limit and supports simple " +
          "formatting here: **bold**, __italic__, and `- ` bullet lines. Line breaks are \\n.",
      ),
    quantity: z.number().optional(),
    unitName: z.string().optional().describe('e.g. "piece", "hour".'),
    unitPrice: moneySchema.optional(),
    optional: jsonBool(z.boolean().optional()).describe(
      "Optional line item (Optionale Position): shown with its price but NOT counted in the document total.",
    ),
    alternative: jsonBool(z.boolean().optional()).describe(
      "Alternative line item (Alternativposition): an alternative to another position; not counted in the total.",
    ),
  })
  .passthrough();

export const addressSchema = z
  .object({
    contactId: z.string().optional().describe("Reference an existing contact by id."),
    name: z.string().optional().describe("Recipient name for a one-off address."),
    countryCode: z.string().optional().describe('ISO country code, e.g. "DE".'),
  })
  .passthrough()
  .refine((a) => Boolean(a.contactId) || Boolean(a.name), {
    message: "address requires either contactId or a name (one-off address).",
  });

export const taxConditionsSchema = z
  .object({
    taxType: z
      .string()
      .describe('e.g. "net", "gross", "vatfree", "intraCommunitySupply", "thirdPartyCountry".'),
  })
  .passthrough();

export const shippingConditionsSchema = z
  .object({
    shippingType: z.string().describe('e.g. "service", "delivery", "none".'),
  })
  .passthrough();

export const paymentConditionsSchema = z
  .object({
    paymentTermLabel: z
      .string()
      .optional()
      .describe('Payment-term text on the document, e.g. "Zahlbar innerhalb von 14 Tagen ohne Abzug".'),
    paymentTermDuration: z
      .number()
      .int()
      .optional()
      .describe("Days until the invoice is due (drives the Fälligkeitsdatum), e.g. 14. 0 = due immediately."),
  })
  .passthrough();

/** Fields common to every voucher document; specific shapes spread this. */
const baseDocumentShape = {
  voucherDate: z.string().describe("ISO date/dateTime of the document."),
  address: jsonObj(addressSchema),
  lineItems: jsonObj(z.array(lineItemSchema).min(1).max(300)),
  totalPrice: jsonObj(
    z
      .object({ currency: z.string().default("EUR") })
      .passthrough()
      .describe("Must include the currency (EUR)."),
  ),
  taxConditions: jsonObj(taxConditionsSchema),
  paymentConditions: jsonObj(paymentConditionsSchema)
    .optional()
    .describe(
      "Payment terms (paymentTermLabel + paymentTermDuration in days). Set this at creation — the Lexware " +
        "API has no update endpoint for invoices/quotations/etc., so a draft cannot be patched afterwards.",
    ),
  title: z
    .string()
    .optional()
    .describe(
      'Document heading, e.g. "Rechnung". Lexware documents a 25-character limit on this one, ' +
        "which is much shorter than the other text fields.",
    ),
  introduction: z
    .string()
    .optional()
    .describe(
      "Text above the line items. Lexware documents a 2000-character limit and supports simple " +
        "formatting: **bold**, __italic__, and `- ` bullet lines. Line breaks are \\n.",
    ),
  remark: z
    .string()
    .optional()
    .describe(
      "Closing text below the line items. Same 2000-character limit and formatting support as " +
        "introduction.",
    ),
  language: z
    .string()
    .optional()
    .describe(
      'Document language, e.g. "de" or "en" — this is how an English invoice is produced. ' +
        "Documented for invoices, credit notes and order confirmations, and it needs an Invoicing " +
        "Pro plan (check businessFeatures via get-profile). Omit to use the organization default.",
    ),
  printLayoutId: z
    .string()
    .optional()
    .describe(
      "Print layout to render with. Ids come from get-print-layouts; needs an Invoicing Pro plan. " +
        "Omit to use the organization's default layout.",
    ),
} as const;

/** Invoice (draft or finalized): base fields + required shippingConditions. */
export const invoiceInputShape = {
  ...baseDocumentShape,
  shippingConditions: jsonObj(shippingConditionsSchema),
} as const;

/** Quotation: base fields + expirationDate (no shippingConditions). */
export const quotationInputShape = {
  ...baseDocumentShape,
  expirationDate: z.string().describe("ISO date the quotation is valid until."),
} as const;

/**
 * Generic voucher-document body, used for credit notes, order confirmations,
 * delivery notes, etc. Lenient: `shippingConditions` is optional since it varies
 * by document type.
 */
export const genericDocumentInputShape = {
  ...baseDocumentShape,
  shippingConditions: jsonObj(shippingConditionsSchema).optional(),
} as const;

/** Create an article: full body. */
export const articleInputShape = {
  title: z.string(),
  type: z.enum(["PRODUCT", "SERVICE"]),
  unitName: z.string().describe('e.g. "piece", "hour".'),
  articleNumber: z.string().optional(),
  gtin: z.string().optional(),
  description: z
    .string()
    .optional()
    .describe(
      "Article description. Lexware supports simple formatting here: **bold**, __italic__, and " +
        "`- ` bullet lines. Note this applies to the description only, NOT to the title.",
    ),
  price: jsonObj(
    z
      .object({
        leadingPrice: z.enum(["NET", "GROSS"]),
        taxRate: z.number(),
        netPrice: z.number().optional(),
        grossPrice: z.number().optional(),
      })
      .passthrough(),
  ),
} as const;

/**
 * Article fields for update-article (read-modify-write): every field is optional, so
 * a minimal edit (e.g. just `price`) is safe — unspecified fields carry over from the
 * existing article and the `price` object is merged (set just netPrice without
 * resending leadingPrice/taxRate).
 */
export const articleUpdateShape = {
  title: z.string().optional(),
  type: z.enum(["PRODUCT", "SERVICE"]).optional(),
  unitName: z.string().optional().describe('e.g. "piece", "hour".'),
  articleNumber: z.string().optional(),
  gtin: z.string().optional(),
  description: z
    .string()
    .optional()
    .describe(
      "Article description. Lexware supports simple formatting here: **bold**, __italic__, and " +
        "`- ` bullet lines. Note this applies to the description only, NOT to the title.",
    ),
  price: jsonObj(
    z
      .object({
        leadingPrice: z.enum(["NET", "GROSS"]).optional(),
        taxRate: z.number().optional(),
        netPrice: z.number().optional(),
        grossPrice: z.number().optional(),
      })
      .passthrough(),
  ).optional(),
} as const;

// Shared contact sub-schemas (used by both create and update). All lenient.
const contactRolesSchema = z
  .object({
    customer: z.object({ number: jsonNum(z.number().int().optional()) }).passthrough().optional(),
    vendor: z.object({ number: jsonNum(z.number().int().optional()) }).passthrough().optional(),
  })
  .passthrough();

const contactPersonBase = { salutation: z.string().optional(), firstName: z.string().optional() };

const contactPersonsSchema = z.array(
  z
    .object({
      salutation: z.string().optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      primary: jsonBool(z.boolean().optional()),
      emailAddress: z.string().optional(),
      phoneNumber: z.string().optional(),
    })
    .passthrough(),
);

const contactPhoneNumbersSchema = z
  .object({
    business: z.array(z.string()).optional(),
    office: z.array(z.string()).optional(),
    mobile: z.array(z.string()).optional(),
    private: z.array(z.string()).optional(),
    fax: z.array(z.string()).optional(),
    other: z.array(z.string()).optional(),
  })
  .passthrough();

const contactCompanyFields = {
  vatRegistrationId: z.string().optional().describe('VAT registration ID, e.g. "IE3336483DH".'),
  taxNumber: z.string().optional(),
  allowTaxFreeInvoices: jsonBool(z.boolean().optional()),
  contactPersons: contactPersonsSchema.optional().describe("Company contact persons."),
};

const contactAddressEntrySchema = z
  .object({
    supplement: z.string().optional(),
    street: z.string().optional(),
    zip: z.string().optional(),
    city: z.string().optional(),
    countryCode: z.string().optional().describe('ISO country code, e.g. "DE", "IE".'),
  })
  .passthrough();

const contactAddressesSchema = z
  .object({
    billing: z.array(contactAddressEntrySchema).optional(),
    shipping: z.array(contactAddressEntrySchema).optional(),
  })
  .passthrough()
  .describe(
    "Billing/shipping addresses. countryCode (ISO-3166 alpha-2, e.g. \"IE\") is required by lexoffice for any " +
      "address. On update a partial address (e.g. just countryCode) is merged into the existing one, so " +
      "street/zip/city are kept.",
  );

const contactEmailAddressesSchema = z
  .object({
    business: z.array(z.string()).optional(),
    office: z.array(z.string()).optional(),
    private: z.array(z.string()).optional(),
    other: z.array(z.string()).optional(),
  })
  .passthrough();

/** Contact creation: roles + person or company. version must be 0 for create. */
export const contactInputShape = {
  roles: jsonObj(contactRolesSchema.describe('At least one role, e.g. { "customer": {} }.')),
  person: jsonObj(
    z
      .object({ ...contactPersonBase, lastName: z.string() })
      .passthrough()
      .describe("For a private person; lastName is required."),
  ).optional(),
  company: jsonObj(
    z
      .object({ name: z.string(), ...contactCompanyFields })
      .passthrough()
      .describe("For a company; name is required. May include vatRegistrationId."),
  ).optional(),
  addresses: jsonObj(contactAddressesSchema).optional(),
  emailAddresses: jsonObj(contactEmailAddressesSchema).optional(),
  phoneNumbers: jsonObj(contactPhoneNumbersSchema).optional(),
  // NOTE: `archived` is deliberately not exposed — it is READ-ONLY on the Lexware
  // contacts API (verified against the docs), so setting it here would be silently
  // ignored. Archiving a contact is a web-app-only action; there is no delete either.
  note: z.string().optional(),
} as const;

/**
 * Contact fields for update-contact (read-modify-write): every field is optional.
 * Unspecified fields (existing addresses, emailAddresses, roles, …) are carried over
 * from the current contact, and nested objects like `company` are merged — so you can
 * set just `company.vatRegistrationId` or a billing `countryCode` without resending
 * everything else.
 */
export const contactUpdateShape = {
  roles: jsonObj(contactRolesSchema).optional(),
  person: jsonObj(
    z.object({ ...contactPersonBase, lastName: z.string().optional() }).passthrough(),
  ).optional(),
  company: jsonObj(
    z
      .object({ name: z.string().optional(), ...contactCompanyFields })
      .passthrough()
      .describe("Company fields to set (e.g. vatRegistrationId); merged into the existing company."),
  ).optional(),
  addresses: jsonObj(contactAddressesSchema).optional(),
  emailAddresses: jsonObj(contactEmailAddressesSchema).optional(),
  phoneNumbers: jsonObj(contactPhoneNumbersSchema).optional(),
  // NOTE: `archived` is READ-ONLY on the Lexware contacts API — a PUT with archived:true
  // is accepted (version bumps) but silently ignored. Archiving is web-app-only and there
  // is no contact delete, so the param is not exposed (it would mislead the model).
  note: z.string().optional(),
} as const;

/**
 * Bookkeeping voucher body (POST/PUT /v1/vouchers). Lenient: the load-bearing
 * fields are typed and `voucherItems` rows pass through. Formats below were
 * confirmed against a live voucher (full-ISO dates with offset, voucherStatus
 * "unchecked"). The exact create required-set and the valid `taxRatePercent`
 * values are reported by Lexware's IssueList on a 406 — now surfaced verbatim in
 * the tool error (field path + reason), so iterate from that.
 */
export const voucherInputShape = {
  type: z
    .string()
    .describe('Required. "salesinvoice", "salescreditnote", "purchaseinvoice", or "purchasecreditnote".'),
  voucherStatus: z
    .string()
    .optional()
    .describe('e.g. "unchecked" (uncategorized inbox voucher), "open", "paid", or "voided".'),
  voucherNumber: z
    .string()
    .optional()
    .describe("Supplier/document number (commonly required for purchase vouchers)."),
  voucherDate: z
    .string()
    .describe('Required. Full ISO date-time with offset, e.g. "2026-06-12T00:00:00.000+02:00".'),
  shippingDate: z.string().optional().describe("Full ISO date-time with offset."),
  dueDate: z.string().optional().describe("Full ISO date-time with offset."),
  totalGrossAmount: jsonNum(z.number().optional()).describe(
    "Total gross amount. Must equal the sum of voucherItems[].amount when taxType is gross.",
  ),
  totalTaxAmount: jsonNum(z.number().optional()).describe(
    "Total tax amount. Must equal the sum of voucherItems[].taxAmount.",
  ),
  taxType: z
    .string()
    .optional()
    .describe('"gross" or "net" — whether each voucherItems[].amount is gross or net.'),
  useCollectiveContact: jsonBool(z.boolean().optional()).describe(
    "If true, no contactId is required (books to a collective contact).",
  ),
  contactId: z
    .string()
    .optional()
    .describe("Existing contact id; required unless useCollectiveContact is true."),
  contactName: z
    .string()
    .optional()
    .describe('Custom one-off contact name (e.g. "Sammellieferant"). Auto-cleared when you set contactId.'),
  remark: z.string().optional(),
  voucherItems: jsonObj(
    z
      .array(
        z
          .object({
            amount: z.number().describe("Line amount (gross or net per taxType)."),
            taxAmount: z.number().describe("Tax amount of the line."),
            taxRatePercent: z
              .number()
              .describe("VAT rate: 0, 7, or 19 (also 5, 16 historically). A frequent 406 cause — must be a valid rate."),
            categoryId: z
              .string()
              .describe("Posting category id from get-posting-categories (required for each line)."),
          })
          .passthrough(),
      )
      .describe("Booking lines. May be empty for an unchecked voucher; required to fully book one."),
  ).optional(),
  files: jsonObj(z.array(z.string()))
    .optional()
    .describe("Attached file ids (receipts). Set to re-link existing file(s) by id; replaces the whole list."),
} as const;

/**
 * Voucher fields for update-voucher (read-modify-write): every field is optional.
 * Unspecified fields are carried over from the existing voucher, so a minimal edit
 * like `{ id, voucherItems: [...] }` is safe (attached files, voucherNumber and
 * voucherStatus are preserved). If you send `voucherItems` it replaces the whole
 * list — include every line.
 */
export const voucherUpdateShape = {
  ...voucherInputShape,
  type: z
    .string()
    .optional()
    .describe('"salesinvoice", "salescreditnote", "purchaseinvoice", or "purchasecreditnote".'),
  voucherDate: z
    .string()
    .optional()
    .describe('Full ISO date-time with offset, e.g. "2026-06-12T00:00:00.000+02:00".'),
} as const;
