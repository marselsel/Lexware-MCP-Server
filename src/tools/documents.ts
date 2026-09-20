import type { McpServer, StandardSchemaWithJSON } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { LexwareApiError } from "../lexware/errors.js";
import {
  type Paged,
  VOUCHER_STATUSES,
  VOUCHER_TYPES,
  VOUCHERLIST_SORT_FIELDS,
  type VoucherlistEntry,
} from "../lexware/types.js";
import {
  additionalFieldsParam,
  genericDocumentInputShape,
  invoiceInputShape,
  jsonBool,
  jsonNum,
  jsonObj,
  mergeBody,
  pageParam,
  quotationInputShape,
  sizeParam,
} from "./schemas.js";
import { LOCAL_RO, RO, WRITE, binaryResult, pagedResult, text } from "./shared.js";

/**
 * A tool's `inputSchema`: the raw field shape skybridge's `registerTool` takes.
 *
 * Named locally rather than imported from the 1.x SDK's `ZodRawShapeCompat`. skybridge 2
 * still depends on that SDK, so the import resolves and tsc stays quiet while the running
 * code is the v2 surface — see the same trap in oauth.ts.
 */
type ToolInputShape = Record<string, StandardSchemaWithJSON>;

/** A Lexware voucher-document type and how to create it. */
interface DocType {
  /** Tool-name suffix, e.g. "credit-note". */
  key: string;
  /** API path segment, e.g. "credit-notes". */
  path: string;
  /** Human label, e.g. "credit note". */
  label: string;
  /** Create-body schema; null means read-only (no create tools). */
  schema: ToolInputShape | null;
  /** Whether `?finalize=true` issuing is supported. */
  finalize: boolean;
  /**
   * Whether this document can ever be an e-invoice, i.e. whether asking for its file
   * as XML is a sensible thing to do. Only invoices, credit notes and down payment
   * invoices can; for every other type `electronicDocumentProfile` is always `NONE`,
   * so offering the choice could only ever produce a failure.
   */
  eInvoice: boolean;
}

const DOC_TYPES: DocType[] = [
  { key: "invoice", path: "invoices", label: "invoice", schema: invoiceInputShape, finalize: true, eInvoice: true },
  { key: "quotation", path: "quotations", label: "quotation", schema: quotationInputShape, finalize: true, eInvoice: false },
  { key: "credit-note", path: "credit-notes", label: "credit note", schema: genericDocumentInputShape, finalize: true, eInvoice: true },
  { key: "order-confirmation", path: "order-confirmations", label: "order confirmation", schema: genericDocumentInputShape, finalize: true, eInvoice: false },
  { key: "delivery-note", path: "delivery-notes", label: "delivery note", schema: genericDocumentInputShape, finalize: true, eInvoice: false },
  { key: "dunning", path: "dunnings", label: "dunning", schema: genericDocumentInputShape, finalize: true, eInvoice: false },
  // down-payment-invoices are GET-only (no create/finalize) but still have a finalized PDF via /{id}/file.
  { key: "down-payment-invoice", path: "down-payment-invoices", label: "down payment invoice", schema: null, finalize: false, eInvoice: true },
];

/** Document resource paths — the `resourceType` enum for get-document-file. */
const DOC_FILE_PATHS = DOC_TYPES.map((d) => d.path) as [string, ...string[]];

/**
 * Resource segments for the Lexware **web-app permalink**
 * (`{app}/permalink/{resource}/{action}/{id}`). NOTE: these are the
 * concatenated-lowercase web-app forms (`creditnotes`), NOT the hyphenated REST
 * API paths (`credit-notes`). Verify against the live app if extending.
 */
const DEEPLINK_RESOURCES = [
  "invoices",
  "quotations",
  "creditnotes",
  "orderconfirmations",
  "deliverynotes",
  "downpaymentinvoices",
  "dunnings",
  "vouchers",
  "contacts",
] as const;

/**
 * Map a voucherlist `voucherType` to its REST resource path, so get-document can
 * dispatch a voucherlist row to the right endpoint. Bookkeeping types (purchase
 * and sales invoices/credit-notes) resolve via `/vouchers`; the rest via their endpoint.
 */
const VOUCHERTYPE_TO_PATH: Record<string, string> = {
  invoice: "invoices",
  creditnote: "credit-notes",
  orderconfirmation: "order-confirmations",
  quotation: "quotations",
  deliverynote: "delivery-notes",
  downpaymentinvoice: "down-payment-invoices",
  dunning: "dunnings",
  purchaseinvoice: "vouchers",
  purchasecreditnote: "vouchers",
  salesinvoice: "vouchers",
  salescreditnote: "vouchers",
  voucher: "vouchers",
  recurringtemplate: "recurring-templates",
};

/**
 * `format` for the sales-voucher file downloads, mapped to the Accept header Lexware
 * keys off. Verified against the live API:
 *
 *   Accept: application/pdf  -> the PDF, for every document profile
 *   Accept: application/xml  -> the XML for an XRechnung; 404 for EN16931 (ZUGFeRD,
 *                               whose XML is embedded in the PDF) and for a plain PDF
 *   anything else            -> 406
 *
 * This is more than a convenience: Lexware's own documentation states that the PDF of
 * an XRechnung "is not a valid e-invoice and should not be used as one", so a
 * PDF-only download can hand back nothing but the preview for exactly the profile
 * where the distinction is legally load-bearing.
 */
const DOCUMENT_FILE_ACCEPT = {
  pdf: "application/pdf",
  xml: "application/xml",
} as const;

/**
 * Resources whose `/file` subresource can serve XML. Everything else always reports
 * `electronicDocumentProfile: "NONE"`, so XML is not merely absent, it is impossible.
 *
 * DERIVED from `DOC_TYPES`, not restated: the render-* tools decide whether to publish
 * the `format` parameter from the same `eInvoice` flag. Two hand-kept copies of one fact
 * drift silently, and either direction of drift is invisible — a type added here but not
 * there advertises a choice that is always refused locally, and the reverse requests XML
 * for a resource whose own render tool hides the option.
 */
const E_INVOICE_RESOURCES = new Set(DOC_TYPES.filter((d) => d.eInvoice).map((d) => d.path));

type DocumentFileFormat = keyof typeof DOCUMENT_FILE_ACCEPT;

const documentFormatParam = z
  .enum(["pdf", "xml"])
  .default("pdf")
  .describe(
    'File format. "xml" returns the e-invoice XML, which ONLY an XRechnung has: a ZUGFeRD ' +
      "(EN16931) invoice carries its XML embedded inside the PDF, and a plain invoice has none. " +
      "Check the document's electronicDocumentProfile before asking for xml.",
  );

/**
 * Fetch a document's file in the requested format.
 *
 * A 404 on an XML request means "this document has no standalone XML", not "no such
 * document" — the raw status reads as a missing document and would send the caller
 * looking for the wrong problem, so it is translated into what actually happened.
 */
async function fetchDocumentFile(
  client: LexwareClient,
  resource: string,
  id: string,
  format: DocumentFileFormat,
): Promise<{ data: Buffer; contentType: string }> {
  // Refuse before spending a request when the resource can never have XML at all.
  // get-document-file picks its resource at call time, so this cannot be expressed in
  // the schema the way the render-* tools do it.
  if (format === "xml" && !E_INVOICE_RESOURCES.has(resource)) {
    throw new Error(
      `A document in /${resource} never has an e-invoice XML: Lexware serves XML only for invoices, ` +
        `credit notes and down payment invoices, and only when the document is an XRechnung. ` +
        `Use format="pdf".`,
    );
  }
  try {
    return await client.getBinary(
      `/v1/${resource}/${encodeURIComponent(id)}/file`,
      DOCUMENT_FILE_ACCEPT[format],
    );
  } catch (err) {
    if (format === "xml" && err instanceof LexwareApiError && err.status === 404) {
      // Two different causes share this status, and the raw 404 names neither: the
      // document may exist but have no standalone XML, or the id may simply be wrong.
      // Naming only the first would send someone with a typo hunting through
      // electronicDocumentProfile.
      //
      // Rethrown as a LexwareApiError, not a bare Error: only the WORDING is being
      // improved, so the 404 must survive it. Downgrading to Error would strip `status`,
      // `kind` and the Lexware body, leaving an error that no longer says what it is —
      // the message would read better while the error got harder to handle.
      throw new LexwareApiError(
        err.status,
        `No XML returned for ${resource}/${id}. Either that document is not an XRechnung — a ZUGFeRD ` +
          `(EN16931) invoice keeps its XML embedded in the PDF and a plain invoice has none, so check ` +
          `electronicDocumentProfile and use format="pdf" — or no document exists with that id.`,
        err.body,
      );
    }
    throw err;
  }
}

/** Dimensions `summarize-vouchers` can group totals by. */
const SUMMARY_GROUP_BY = ["voucherType", "voucherStatus", "month", "contact", "currency", "none"] as const;

/** Bucket key for a voucherlist row under the chosen grouping dimension. */
function summaryGroupKey(row: VoucherlistEntry, groupBy: (typeof SUMMARY_GROUP_BY)[number]): string {
  switch (groupBy) {
    case "voucherStatus":
      return row.voucherStatus || "(unknown)";
    case "month":
      return row.voucherDate ? row.voucherDate.slice(0, 7) : "(no date)"; // YYYY-MM
    case "contact":
      return row.contactName || "(no contact)";
    case "currency":
      return row.currency || "(no currency)";
    case "none":
      return "all";
    default:
      return row.voucherType || "(unknown)";
  }
}

/**
 * A voucherlist `voucherType` / `voucherStatus` filter.
 *
 * Lexware accepts one value or a comma-separated list, so this takes either a single
 * enum value or an array of them. It also tolerates the comma-separated string itself,
 * because that is the API's own wire format and a plausible thing for a caller to
 * reach for, and a JSON-encoded array, for clients that serialise array arguments as
 * strings.
 *
 * Deliberately NOT a free string: an empty entry (`open,,paid`) makes Lexware answer
 * HTTP 500, so every part is validated against the enum before a request is spent on
 * it. The published JSON Schema is an `anyOf` of the two branches, so the allowed
 * values stay visible to the model in both.
 */
function voucherFilterParam<const T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(
    (raw) => {
      if (typeof raw !== "string") return raw;
      const value = raw.trim();
      if (value.startsWith("[")) {
        try {
          return JSON.parse(value);
        } catch {
          return raw; // leave as-is so Zod reports a precise error
        }
      }
      return value.includes(",") ? value.split(",").map((part) => part.trim()) : value;
    },
    // `.default` belongs INSIDE the preprocess wrapper. Applied outside it lands on a
    // ZodPipe, and zod does not carry a pipe's default into the published input JSON
    // Schema — the runtime default still works, but the model stops being told that
    // "any" is the default, which is the only reason it is declared. Same convention
    // as `jsonNum(z.number().int().default(40))` elsewhere in this file.
    z.union([z.enum(values), z.array(z.enum(values)).min(1)]).default("any" as T[number]),
  );
}

/**
 * Values Lexware refuses to combine with anything else in the same filter: `any`
 * already means "all", and `overdue` is derived from the due date rather than stored.
 * Both come back as a 400 naming the value, so they are caught here instead of costing
 * a request.
 */
const UNCOMBINABLE_VOUCHER_FILTER_VALUES = new Set(["any", "overdue"]);

/**
 * Collapse a type/status filter into the single comma-separated value Lexware takes.
 *
 * Total by construction, like the `format` resolution in the file download: an empty
 * result degrades to `"any"` rather than to the empty string. That matters because
 * `buildUrl` omits only `undefined`, so `""` would go on the wire as `voucherType=`,
 * and an empty filter value is exactly what makes Lexware answer HTTP 500 instead of a
 * 400. The zod layer supplies the default in production, but nothing downstream should
 * depend on that having happened.
 */
function voucherFilterValue(value: string | string[] | undefined, field: string): string {
  // De-duplicate first, so ["any", "any"] reads as the plain "any" it means rather
  // than tripping the combination check below.
  const given = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const parts = [...new Set(given)].filter((part) => part !== "");
  if (parts.length === 0) return "any";
  const blocking = parts.find((part) => UNCOMBINABLE_VOUCHER_FILTER_VALUES.has(part));
  if (parts.length > 1 && blocking !== undefined) {
    throw new Error(
      `${field} "${blocking}" cannot be combined with other values — pass it on its own.` +
        (blocking === "any"
          ? " 'any' already matches every value."
          : " Lexware derives 'overdue' from the due date rather than storing it."),
    );
  }
  return parts.join(",");
}

/** The `yyyy-MM-dd` shape every voucherlist date bound is restricted to. */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A voucherlist date bound. The `yyyy-MM-dd`-only rule is enforced, not just described:
 * the full ISO datetime is the format the create tools require for `voucherDate`, so
 * carrying it over here is the natural mistake, and it costs a request to find out. This
 * is the same argument the type/status filters make by validating against their enum —
 * a value the API is known to reject should not reach it.
 *
 * Only the SHAPE is checked. Whether the date exists (2026-02-30) is left to Lexware;
 * the point is to catch the wrong format, not to re-implement a calendar.
 */
const dateFilterParam = (what: string) =>
  z
    .string()
    .regex(CALENDAR_DAY, "Use yyyy-MM-dd — the voucherlist rejects a full ISO datetime.")
    .optional()
    .describe(`${what}, yyyy-MM-dd (inclusive). A full ISO datetime is rejected.`);

/**
 * Date-range filters `GET /v1/voucherlist` accepts.
 *
 * All six take `yyyy-MM-dd` ONLY. A full ISO datetime — the format the create tools
 * use for `voucherDate`, so an easy mistake to carry over — is rejected with a 400.
 * Probed on all three families: `voucherDateFrom`, `createdDateFrom` and
 * `updatedDateFrom` each answer 200 for `2025-01-01` and 400 for
 * `2025-01-01T00:00:00.000+01:00`. Both bounds are inclusive full days (Lexware made
 * the `…To` bounds inclusive in August 2026).
 *
 * `voucherDate*` filters on the document's own date, which the user sets and often
 * backdates. `createdDate*` and `updatedDate*` filter on when Lexware itself saw the
 * row, which is what an incremental sync needs ("what changed since my last run") and
 * what `voucherDate` cannot answer.
 */
const VOUCHERLIST_DATE_FILTERS = {
  voucherDateFrom: dateFilterParam("Document-date lower bound"),
  voucherDateTo: dateFilterParam("Document-date upper bound"),
  createdDateFrom: dateFilterParam("Lower bound on when the row was CREATED in Lexware"),
  createdDateTo: dateFilterParam("Upper bound on when the row was CREATED in Lexware"),
  updatedDateFrom: dateFilterParam("Lower bound on when the row was LAST CHANGED"),
  updatedDateTo: dateFilterParam("Upper bound on when the row was LAST CHANGED"),
} as const;

/** Read tools for financial documents. Always registered. */
export function registerDocumentReadTools(
  server: McpServer,
  client: LexwareClient,
  appBaseUrl: string,
): void {
  server.registerTool(
    {
      name: "get-voucherlist",
      description:
        "Search the voucher list — the primary index of all financial documents (invoices, credit notes, quotations, etc.). voucherType and voucherStatus both default to 'any', which matches all. Results are paged. Filter by createdDate*/updatedDate* to see only what is new or changed since a given day, and by voucherNumber to look a single document up by its number.",
      inputSchema: {
        voucherType: voucherFilterParam(VOUCHER_TYPES)
          .describe("One type, or several as an array/comma-separated list. 'any' must stand alone."),
        voucherStatus: voucherFilterParam(VOUCHER_STATUSES)
          .describe(
            "One status, or several as an array/comma-separated list. 'any' and 'overdue' must each stand alone.",
          ),
        contactId: z.string().optional(),
        voucherNumber: z
          .string()
          .optional()
          .describe(
            'Exact voucher number, e.g. "RE0069". Matches the WHOLE number only — a prefix or ' +
              "substring returns nothing. This is the only way to find a document by its number; " +
              "there is no search-by-number endpoint.",
          ),
        ...VOUCHERLIST_DATE_FILTERS,
        sortBy: z
          .enum(VOUCHERLIST_SORT_FIELDS)
          .optional()
          .describe("Field to sort by. Omit for Lexware's default, which is voucherDate newest-first."),
        sortDirection: z
          .enum(["ASC", "DESC"])
          .optional()
          .describe(
            "Sort direction, defaulting to DESC. Requires sortBy; on its own it has nothing to sort.",
          ),
        archived: jsonBool(z.boolean().optional()),
        page: pageParam,
        size: sizeParam,
      },
      annotations: RO,
    },
    async ({
      voucherType,
      voucherStatus,
      contactId,
      voucherNumber,
      voucherDateFrom,
      voucherDateTo,
      createdDateFrom,
      createdDateTo,
      updatedDateFrom,
      updatedDateTo,
      sortBy,
      sortDirection,
      archived,
      page,
      size,
    }) => {
      // Fail here rather than silently dropping the direction: a caller who asked for
      // ASC and got Lexware's DESC default would read the wrong end of the list.
      if (sortDirection && !sortBy) {
        throw new Error("sortDirection requires sortBy — name the field to sort on.");
      }
      const result = await client.get<Paged<VoucherlistEntry>>("/v1/voucherlist", {
        voucherType: voucherFilterValue(voucherType, "voucherType"),
        voucherStatus: voucherFilterValue(voucherStatus, "voucherStatus"),
        contactId,
        voucherNumber,
        voucherDateFrom,
        voucherDateTo,
        createdDateFrom,
        createdDateTo,
        updatedDateFrom,
        updatedDateTo,
        // Lexware carries the direction inside `sort` itself, as "field,DIR". The direction
        // is always written out, because a BARE field sorts the opposite way from no sort at
        // all — probed: no sort -> 2026-09-17 first, `sort=voucherDate` -> 2025-07-25 first,
        // `sort=voucherDate,DESC` -> 2026-09-17 first. Spring Data defaults a bare property to
        // ASC while the voucherlist's own default is newest-first, so naming a field and no
        // direction would silently hand back the oldest rows to a caller who only wanted to
        // sort by the field they were already getting.
        sort: sortBy === undefined ? undefined : `${sortBy},${sortDirection ?? "DESC"}`,
        archived,
        page,
        size,
      });
      return pagedResult(result, "voucher(s)");
    },
  );

  server.registerTool(
    {
      name: "summarize-vouchers",
      description:
        "Aggregate the voucherlist over a date range WITHOUT returning every row: server-side paginates all " +
        "matches and returns counts plus summed gross/open amounts, grouped by a chosen dimension. Use this " +
        "for totals (e.g. 'gross sales invoices in Q2') instead of get-voucherlist, which can blow the token " +
        "limit on large ranges. Amounts are GROSS (the voucherlist's totalAmount/openAmount) in the document " +
        "currency — the net/VAT split is not in the voucherlist, so this does not break out USt. " +
        "voucherType/voucherStatus default to 'any'.",
      inputSchema: {
        voucherType: voucherFilterParam(VOUCHER_TYPES)
          .describe("One type, or several as an array/comma-separated list. 'any' must stand alone."),
        voucherStatus: voucherFilterParam(VOUCHER_STATUSES)
          .describe(
            "One status, or several as an array/comma-separated list. 'any' and 'overdue' must each stand alone.",
          ),
        contactId: z.string().optional(),
        ...VOUCHERLIST_DATE_FILTERS,
        archived: jsonBool(z.boolean().optional()),
        groupBy: z
          .enum(SUMMARY_GROUP_BY)
          .default("voucherType")
          .describe("Dimension to group totals by. 'month' buckets by voucherDate (YYYY-MM); 'none' = one total."),
        maxPages: jsonNum(z.number().int().min(1).max(200).default(40)).describe(
          "Safety cap on pages scanned (250 rows/page). If hit, the result is flagged truncated.",
        ),
      },
      annotations: RO,
    },
    async ({
      voucherType,
      voucherStatus,
      contactId,
      voucherDateFrom,
      voucherDateTo,
      createdDateFrom,
      createdDateTo,
      updatedDateFrom,
      updatedDateTo,
      archived,
      groupBy,
      maxPages,
    }) => {
      const SIZE = 250;
      const groups = new Map<
        string,
        { count: number; sumTotalAmount: number; sumOpenAmount: number; currencies: Set<string> }
      >();
      let scanned = 0;
      let totalElements = 0;
      let page = 0;
      let pagesScanned = 0;
      let truncated = false;
      // Resolved once, above the loop: the inputs are loop-invariant, and resolving them
      // here also means the uncombinable-value error ("any" or "overdue" alongside another
      // value) is raised as the argument check it is, rather than from inside paging.
      const voucherTypeParam = voucherFilterValue(voucherType, "voucherType");
      const voucherStatusParam = voucherFilterValue(voucherStatus, "voucherStatus");
      // Walk every page; we only keep aggregates, so the response size is bounded
      // regardless of how many vouchers match.
      for (;;) {
        const res = await client.get<Paged<VoucherlistEntry>>("/v1/voucherlist", {
          voucherType: voucherTypeParam,
          voucherStatus: voucherStatusParam,
          contactId,
          voucherDateFrom,
          voucherDateTo,
          createdDateFrom,
          createdDateTo,
          updatedDateFrom,
          updatedDateTo,
          archived,
          page,
          size: SIZE,
        });
        totalElements = res.totalElements;
        pagesScanned++;
        for (const row of res.content) {
          scanned++;
          const key = summaryGroupKey(row, groupBy);
          const g = groups.get(key) ?? {
            count: 0,
            sumTotalAmount: 0,
            sumOpenAmount: 0,
            currencies: new Set<string>(),
          };
          g.count++;
          g.sumTotalAmount += row.totalAmount ?? 0;
          g.sumOpenAmount += row.openAmount ?? 0;
          if (row.currency) g.currencies.add(row.currency);
          groups.set(key, g);
        }
        if (res.last) break;
        page++;
        if (page >= maxPages) {
          truncated = true;
          break;
        }
      }
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const currencyOf = (set: Set<string>) =>
        set.size === 1 ? [...set][0] : set.size === 0 ? undefined : "mixed";
      const groupList = [...groups.entries()]
        .map(([key, g]) => ({
          key,
          count: g.count,
          sumTotalAmount: round2(g.sumTotalAmount),
          sumOpenAmount: round2(g.sumOpenAmount),
          currency: currencyOf(g.currencies),
        }))
        .sort((a, b) => b.sumTotalAmount - a.sumTotalAmount);
      const allCurrencies = new Set<string>(
        [...groups.values()].flatMap((g) => [...g.currencies]),
      );
      const currency = currencyOf(allCurrencies);
      const grandTotal = round2(groupList.reduce((s, g) => s + g.sumTotalAmount, 0));
      const grandOpen = round2(groupList.reduce((s, g) => s + g.sumOpenAmount, 0));
      return {
        structuredContent: {
          // Every filter that narrowed the scan has to appear here: this block is what
          // a caller reads back to caption the total, so a bound that is applied but
          // not echoed turns an honest number into a mislabelled one.
          filters: {
            voucherType,
            voucherStatus,
            contactId,
            voucherDateFrom,
            voucherDateTo,
            createdDateFrom,
            createdDateTo,
            updatedDateFrom,
            updatedDateTo,
            archived,
            groupBy,
          },
          scanned,
          totalElements,
          pagesScanned,
          truncated,
          grandTotal: { sumTotalAmount: grandTotal, sumOpenAmount: grandOpen, currency },
          groups: groupList,
        },
        content: text(
          `Summarized ${scanned} voucher(s)${truncated ? ` (TRUNCATED at ${maxPages} pages × ${SIZE})` : ""}; ` +
            `gross total ${currency ?? ""} ${grandTotal} across ${groupList.length} ${groupBy} group(s).`,
        ),
      };
    },
  );

  // get-<doctype> for every document type (invoices, quotations, credit-notes, …).
  for (const doc of DOC_TYPES) {
    server.registerTool(
      {
        name: `get-${doc.key}`,
        description: `Get a single ${doc.label} by id (full document including line items).`,
        inputSchema: { id: z.string() },
        annotations: RO,
      },
      async ({ id }) => {
        const document = await client.get<Record<string, unknown>>(`/v1/${doc.path}/${encodeURIComponent(id)}`);
        return { structuredContent: document, content: text(`${doc.label} ${id} retrieved.`) };
      },
    );
  }

  // render-<doctype>-pdf: download a document's finalized PDF.
  for (const doc of DOC_TYPES) {
    server.registerTool(
      {
        // The tool name keeps its `-pdf` suffix even though it can now also return XML:
        // renaming a registered tool breaks every saved prompt and client config that
        // refers to it, which is a poor trade for a suffix. The description carries it.
        name: `render-${doc.key}-pdf`,
        description: doc.eInvoice
          ? `Download the finalized file of a ${doc.label} (GET /v1/${doc.path}/{id}/file) and return it ` +
            `inline — the PDF by default, or the e-invoice XML with format="xml" (XRechnung only). ` +
            `The document must be FINALIZED — a draft has no file yet. (get-document-file is the generic form.)`
          : `Download the finalized PDF of a ${doc.label} (GET /v1/${doc.path}/{id}/file) and return it ` +
            `inline. The document must be FINALIZED — a draft has no file yet. ` +
            `(get-document-file is the generic form.)`,
        // The format choice is offered only where XML is possible. A quotation, order
        // confirmation, delivery note or dunning always reports
        // `electronicDocumentProfile: "NONE"`, so advertising format="xml" there would be
        // offering a choice that can only fail — the pattern #44 exists to remove.
        // Spread rather than a ternary between two object literals. TypeScript normalizes
        // such a ternary by giving the shorter branch an implicit `format?: undefined`,
        // and `undefined` does not satisfy skybridge 2's `Record<string,
        // StandardSchemaWithJSON>` constraint — so inference silently falls back and
        // EVERY key, `id` included, is typed `unknown` in the handler. Same runtime object
        // and same published JSON Schema; only the inference differs.
        inputSchema: { id: z.string(), ...(doc.eInvoice ? { format: documentFormatParam } : {}) },
        annotations: RO,
      },
      async ({ id, format }) => {
        // Resolved here rather than relying on zod's default having been applied:
        // anything that is not an explicit "xml" is the PDF, which keeps the handler
        // total even when it is driven directly.
        const wanted: DocumentFileFormat = format === "xml" ? "xml" : "pdf";
        const { data, contentType } = await fetchDocumentFile(client, doc.path, id, wanted);
        return binaryResult({
          uri: `lexware://${doc.path}/${id}/file?format=${wanted}`,
          data,
          contentType,
          structuredContent: {
            resource: doc.path,
            id,
            format: wanted,
            mimeType: contentType,
            byteLength: data.length,
          },
          message: `Downloaded ${doc.label} ${id} as ${wanted.toUpperCase()} (${data.length} bytes).`,
        });
      },
    );
  }

  server.registerTool(
    {
      name: "get-voucher",
      description:
        "Get a single bookkeeping voucher by id — the full object, including contactId for referenced contacts (collective vouchers have only contactName) and files[] (ids of attached receipts). Note: voucherlist rows of type 'invoice' resolve via get-invoice, 'quotation' via get-quotation, etc. — only manually-booked vouchers resolve here. There is no festgeschrieben/lock flag in the payload; a locked (filed-VAT-period) voucher only surfaces as an error on a write attempt.",
      inputSchema: { id: z.string() },
      annotations: RO,
    },
    async ({ id }) => {
      const voucher = await client.get<Record<string, unknown>>(`/v1/vouchers/${encodeURIComponent(id)}`);
      return { structuredContent: voucher, content: text(`Voucher ${id} retrieved.`) };
    },
  );

  server.registerTool(
    {
      name: "get-vouchers",
      description:
        "Fetch multiple bookkeeping vouchers by id in one call (each returned in full, like get-voucher) — " +
        "reduces round-trips when you need many. Fetched sequentially through the ~2 requests/second rate limit, " +
        "so a full batch of 50 takes ~25s; page through larger sets. Ids that fail are returned in `errors` " +
        "(not thrown), so one bad id won't fail the batch.",
      inputSchema: {
        ids: jsonObj(z.array(z.string()).min(1).max(50)).describe("Voucher ids to fetch (max 50 per call)."),
      },
      annotations: RO,
    },
    async ({ ids }) => {
      const vouchers: Record<string, unknown>[] = [];
      const errors: { id: string; error: string }[] = [];
      for (const id of ids as string[]) {
        try {
          vouchers.push(await client.get<Record<string, unknown>>(`/v1/vouchers/${encodeURIComponent(id)}`));
        } catch (e) {
          errors.push({ id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return {
        structuredContent: { vouchers, errors, count: vouchers.length },
        content: text(
          `Fetched ${vouchers.length}/${(ids as string[]).length} voucher(s)` +
            (errors.length ? `; ${errors.length} failed.` : "."),
        ),
      };
    },
  );

  server.registerTool(
    {
      name: "get-document",
      description:
        "Fetch a financial document by id, auto-dispatching to the correct endpoint from its voucherlist " +
        "`voucherType` — so you don't choose get-invoice vs get-voucher vs get-quotation, etc. Pass the id and " +
        "the voucherType exactly as get-voucherlist returns it (e.g. 'invoice', 'purchaseinvoice', 'quotation').",
      inputSchema: {
        id: z.string(),
        voucherType: z.string().describe("The voucherlist voucherType for this id."),
      },
      annotations: RO,
    },
    async ({ id, voucherType }) => {
      // Object.hasOwn, not a truthy check: `voucherType` is a free string, and a
      // prototype key like "toString" would otherwise resolve to an inherited function
      // (truthy) and stringify into the request path. hasOwn restricts it to the real
      // keys, so an unknown value gives a clean validation error, never a garbled path.
      const path = Object.hasOwn(VOUCHERTYPE_TO_PATH, voucherType) ? VOUCHERTYPE_TO_PATH[voucherType] : undefined;
      if (!path) {
        throw new Error(
          `Unknown voucherType "${voucherType}". Known: ${Object.keys(VOUCHERTYPE_TO_PATH).join(", ")}.`,
        );
      }
      const doc = await client.get<Record<string, unknown>>(`/v1/${path}/${encodeURIComponent(id)}`);
      return { structuredContent: doc, content: text(`${voucherType} ${id} retrieved via /${path}.`) };
    },
  );

  server.registerTool(
    {
      name: "get-document-file",
      description:
        "Download the finalized file of a document by resource + id (GET /v1/{resourceType}/{id}/file), " +
        "returned inline — the PDF by default, or the e-invoice XML with format=\"xml\" (XRechnung only). " +
        "The document must be FINALIZED. resourceType is the REST path, e.g. 'invoices', 'credit-notes'.",
      inputSchema: {
        resourceType: z.enum(DOC_FILE_PATHS).describe("Document resource path, e.g. 'invoices', 'credit-notes'."),
        id: z.string(),
        format: documentFormatParam,
      },
      annotations: RO,
    },
    async ({ resourceType, id, format }) => {
      const wanted: DocumentFileFormat = format === "xml" ? "xml" : "pdf";
      const { data, contentType } = await fetchDocumentFile(client, resourceType, id, wanted);
      return binaryResult({
        uri: `lexware://${resourceType}/${id}/file?format=${wanted}`,
        data,
        contentType,
        structuredContent: {
          resource: resourceType,
          id,
          format: wanted,
          mimeType: contentType,
          byteLength: data.length,
        },
        message: `Downloaded ${resourceType} ${id} as ${wanted.toUpperCase()} (${data.length} bytes).`,
      });
    },
  );

  server.registerTool(
    {
      name: "get-voucher-file",
      description:
        "Download the receipt attached to a bookkeeping voucher in one call: resolves the voucher's file id " +
        "and returns the file inline (instead of get-voucher then download-file). Use fileIndex to pick a " +
        "different attachment when a voucher has several.",
      inputSchema: {
        id: z.string().describe("The voucher id."),
        fileIndex: jsonNum(z.number().int().min(0).default(0)).describe("Which attached file (0 = first)."),
      },
      annotations: RO,
    },
    async ({ id, fileIndex }) => {
      const voucher = await client.get<{ files?: string[] }>(`/v1/vouchers/${encodeURIComponent(id)}`);
      const fileId = voucher.files?.[fileIndex as number];
      if (!fileId) {
        throw new Error(`Voucher ${id} has no attached file at index ${fileIndex}.`);
      }
      // `*/*`, matching download-file on the very same endpoint. A voucher attachment is
      // whatever the user filed — Lexware converts uploads to PDF in practice, but relying
      // on that would make the narrower Accept a silent 406 the day it does not. getBinary
      // defaults to application/pdf, which is right for a rendered document and wrong here.
      const { data, contentType } = await client.getBinary(
        `/v1/files/${encodeURIComponent(fileId)}`,
        "*/*",
      );
      return binaryResult({
        uri: `lexware://files/${fileId}`,
        data,
        contentType,
        structuredContent: { voucherId: id, fileId, mimeType: contentType, byteLength: data.length },
        message: `Downloaded voucher ${id} receipt (${data.length} bytes, ${contentType}).`,
      });
    },
  );

  server.registerTool(
    {
      name: "get-document-link",
      description:
        "Build a deeplink that opens a document directly in the Lexware web app (works when logged into Lexware). Use this to let the user view/print a document; do not use it to fetch raw PDF bytes.",
      inputSchema: {
        resourceType: z.enum(DEEPLINK_RESOURCES),
        id: z.string(),
        action: z.enum(["view", "edit"]).default("view"),
      },
      annotations: LOCAL_RO,
    },
    async ({ resourceType, id, action }) => {
      // Lexware permalink format: {app}/permalink/{resourceType}/{action}/{id}
      const url = `${appBaseUrl}/permalink/${resourceType}/${action}/${encodeURIComponent(id)}`;
      return { structuredContent: { url }, content: text(`Open in Lexware: ${url}`) };
    },
  );
}

/**
 * Make every field of a create shape optional, for the read-modify-write update
 * tools. The raw-shape values are real zod schemas at runtime, so `.optional()`
 * works; the cast bridges the SDK's compat type.
 */
function optionalShape(shape: ToolInputShape): ToolInputShape {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shape)) {
    out[key] = (value as z.ZodTypeAny).optional();
  }
  return out as ToolInputShape;
}

/** Draft-creation tools for every writable document type. Registered with the drafts tier. */
export function registerDocumentDraftTools(server: McpServer, client: LexwareClient): void {
  for (const doc of DOC_TYPES) {
    if (!doc.schema) continue;
    server.registerTool(
      {
        name: `create-draft-${doc.key}`,
        description:
          `Create a DRAFT ${doc.label} (editable, not legally issued). Provide the full document body for a ` +
          `standalone document; with precedingSalesVoucherId the body (line items/contact) is carried over ` +
          `from that preceding voucher — dunnings can ONLY be created this way (pursue from an invoice). ` +
          `To ISSUE a legally-binding document, use create-finalized-${doc.key} instead (finalize tier).`,
        inputSchema: {
          ...optionalShape(doc.schema),
          precedingSalesVoucherId: z
            .string()
            .optional()
            .describe(
              "Create as a follow-up of this preceding sales voucher id (e.g. quotation→order-confirmation→" +
                "invoice, invoice→credit-note/dunning). POSTs ?precedingSalesVoucherId={id}.",
            ),
          // Accepted only to fail LOUDLY: finalizing moved to create-finalized-* (finalize
          // tier). Without these params the SDK would silently strip a stale finalize=true
          // and create a draft while the caller believed it issued a binding document.
          finalize: jsonBool(z.boolean().optional()).describe(
            `MOVED — create-draft-${doc.key} no longer finalizes. Use create-finalized-${doc.key} (finalize tier) to issue a legally-binding document.`,
          ),
          confirm_finalize: jsonBool(z.boolean().optional()).describe(
            `MOVED — see create-finalized-${doc.key}.`,
          ),
          additionalFields: additionalFieldsParam,
        },
        annotations: WRITE,
      },
      async ({ precedingSalesVoucherId, additionalFields, finalize, confirm_finalize, ...input }) => {
        if (finalize || confirm_finalize !== undefined) {
          throw new Error(
            `create-draft-${doc.key} does not finalize (that moved to a separate tool). To issue a ` +
              `legally-binding ${doc.label}, use create-finalized-${doc.key} — requires LEXWARE_ENABLE_FINALIZE.`,
          );
        }
        const query: Record<string, string | boolean> = {};
        if (precedingSalesVoucherId) query.precedingSalesVoucherId = precedingSalesVoucherId;
        const body = mergeBody(input, additionalFields);
        const created = await client.post<{ id: string }>(`/v1/${doc.path}`, body, query);
        return {
          structuredContent: { ...created, finalized: false },
          content: text(`Created DRAFT ${doc.label} ${created.id} (not finalized).`),
        };
      },
    );
  }

  // NOTE: there is deliberately no update-draft-<doctype> tool. The Lexware Office
  // REST API exposes only GET and POST for invoices/quotations/credit-notes/
  // order-confirmations/delivery-notes/dunnings — no PUT — so a draft document
  // cannot be patched after creation (a PUT returns 404). Set every field (incl.
  // paymentConditions) at creation via create-draft-*; to change a draft, recreate
  // it and delete the old one in the web app. (Contacts/articles/vouchers DO have
  // PUT and keep their own update tools.)
}

/** Finalizing / legally-binding tools for every finalizable document type. Finalize tier. */
export function registerDocumentFinalizeTools(server: McpServer, client: LexwareClient): void {
  for (const doc of DOC_TYPES) {
    if (!doc.schema || !doc.finalize) continue;
    server.registerTool(
      {
        name: `create-finalized-${doc.key}`,
        description: `Create and FINALIZE a ${doc.label} in one step. This issues a LEGALLY BINDING, IRREVERSIBLE document (it cannot be edited or deleted afterwards). Requires confirm_finalize=true. Prefer create-draft-${doc.key} unless the user explicitly wants to issue it now.`,
        inputSchema: {
          ...optionalShape(doc.schema),
          precedingSalesVoucherId: z
            .string()
            .optional()
            .describe("Create as a follow-up of this preceding sales voucher id."),
          confirm_finalize: jsonBool(z.literal(true)).describe(
            "Must be true to acknowledge this issues a legally binding document.",
          ),
          additionalFields: additionalFieldsParam,
        },
        annotations: WRITE,
      },
      async ({ confirm_finalize: _confirm, precedingSalesVoucherId, additionalFields, ...input }) => {
        const query: Record<string, string | boolean> = { finalize: true };
        if (precedingSalesVoucherId) query.precedingSalesVoucherId = precedingSalesVoucherId;
        const body = mergeBody(input, additionalFields);
        const created = await client.post<{ id: string }>(`/v1/${doc.path}`, body, query);
        return {
          structuredContent: { ...created, finalized: true },
          content: text(`FINALIZED ${doc.label} ${created.id} (legally binding). This cannot be undone.`),
        };
      },
    );
  }
}
