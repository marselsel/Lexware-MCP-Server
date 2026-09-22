import type { McpServer } from "skybridge/server";
import { z } from "zod";
import type { LexwareClient } from "../lexware/client.js";
import { encodeSearchFilter } from "../lexware/search.js";
import type { Paged } from "../lexware/types.js";
import {
  additionalFieldsParam,
  contactInputShape,
  contactUpdateShape,
  jsonBool,
  jsonNum,
  mergeBody,
  pageParam,
  sizeParam,
  versionParam,
} from "./schemas.js";
import { DESTRUCTIVE, RO, WRITE, deepMergePatch, mergeAddresses, pagedResult, text } from "./shared.js";

/** Read tools for contacts. Always registered. */
export function registerContactReadTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "list-contacts",
      title: "List contacts",
      description:
        "List/search contacts (customers and vendors). Optional filters; results are paged (use page/size).",
      inputSchema: {
        email: z
          .string()
          .min(3)
          .optional()
          .describe(
            "Substring match, min 3 chars. Case-insensitive; Lexware also accepts SQL-style " +
              "wildcards, `_` for one character and `%` for any run.",
          ),
        name: z
          .string()
          .min(3)
          .optional()
          .describe(
            "Substring match, min 3 chars. Case-insensitive; Lexware also accepts SQL-style " +
              "wildcards, `_` for one character and `%` for any run.",
          ),
        number: jsonNum(z.number().int().optional()).describe("Contact number."),
        customer: jsonBool(z.boolean().optional()),
        vendor: jsonBool(z.boolean().optional()),
        page: pageParam,
        size: sizeParam,
      },
      annotations: RO,
    },
    async ({ email, name, number, customer, vendor, page, size }) => {
      const result = await client.get<Paged<Record<string, unknown>>>("/v1/contacts", {
        // `&`, `<` and `>` have to be HTML-encoded on top of the URL encoding the
        // client already applies, or Lexware matches nothing at all. See
        // encodeSearchFilter for the verification. Only these two params are search
        // strings; `number`, `customer` and `vendor` must NOT go through it.
        email: encodeSearchFilter(email),
        name: encodeSearchFilter(name),
        number,
        customer,
        vendor,
        page,
        size,
      });
      return pagedResult(result, "contact(s)");
    },
  );

  server.registerTool(
    {
      name: "get-contact",
      title: "Get contact",
      description: "Get a single contact by id.",
      inputSchema: { id: z.string() },
      annotations: RO,
    },
    async ({ id }) => {
      const contact = await client.get<Record<string, unknown>>(`/v1/contacts/${encodeURIComponent(id)}`);
      return { structuredContent: contact, content: text(`Contact ${id} retrieved.`) };
    },
  );
}

/** Write tools: create/update a contact. Registered only when the drafts tier is enabled. */
export function registerContactDraftTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "create-contact",
      title: "Create contact",
      description:
        "Create a new contact (customer and/or vendor). Provide roles plus either a person (lastName required) or a company (name required).",
      inputSchema: { ...contactInputShape, additionalFields: additionalFieldsParam },
      annotations: WRITE,
    },
    async ({ additionalFields, ...input }) => {
      if (!input.person && !input.company) {
        throw new Error("Provide either a person (with lastName) or a company (with name).");
      }
      // `version` must be 0 when creating.
      const created = await client.post<{ id: string }>("/v1/contacts", {
        version: 0,
        ...mergeBody(input, additionalFields),
      });
      return { structuredContent: created, content: text(`Created contact ${created.id}.`) };
    },
  );

  server.registerTool(
    {
      name: "update-contact",
      title: "Update contact",
      description:
        "Update a contact. Read-modify-write: the current contact is fetched and your fields are merged over it, " +
        "so existing addresses, emailAddresses and roles are preserved — lexoffice PUT otherwise replaces the whole " +
        "contact. Nested objects like `company` are merged, so you can set just company.vatRegistrationId (without " +
        "resending the name), or a single address field like addresses.billing[0].countryCode — partial addresses " +
        "are merged into the existing one (street/zip/city are kept). Pass `version` for optimistic locking; omit " +
        "to use the latest.",
      inputSchema: {
        id: z.string(),
        version: versionParam("get-contact"),
        ...contactUpdateShape,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ id, version, ...fields }) => {
      // Read-modify-write: load the current contact and merge the caller's fields over
      // it, so omitted addresses/emailAddresses/roles aren't wiped by the full PUT.
      const current = await client.get<Record<string, unknown>>(`/v1/contacts/${encodeURIComponent(id)}`);
      const { addresses: addressPatch, ...rest } = fields;
      const body = deepMergePatch(current, {
        ...rest,
        version: version ?? (current.version as number),
      });
      // Addresses merge by index — deepMergePatch would replace the billing array
      // wholesale, so a partial billing[0] (e.g. just countryCode) must keep street/zip/city.
      if (addressPatch !== undefined) {
        body.addresses = mergeAddresses(current.addresses, addressPatch);
      }
      const updated = await client.request<{ id: string; version: number }>(
        "PUT",
        `/v1/contacts/${encodeURIComponent(id)}`,
        { body, idempotent: false },
      );
      return {
        structuredContent: updated,
        content: text(`Updated contact ${id} (now version ${updated.version}).`),
      };
    },
  );
}
