import type { McpServer } from "skybridge/server";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildCurlCommand, buildTicketResponse, registerUploadTools } from "../src/tools/uploads.js";
import { TicketStore } from "../src/uploads/tickets.js";

const URL_ = "https://mcp.example.com/lexware/upload/abc123";

/** Reads back what the command actually declares, instead of matching on prose. */
function headerValue(cmd: string, name: string): string | undefined {
  const m = new RegExp(`-H '${name}: ([^']*)'`).exec(cmd);
  return m?.[1];
}

describe("buildTicketResponse", () => {
  it("builds the browser url and a ready-to-run curl command", () => {
    const out = buildTicketResponse(
      { ticket: "abc123", type: "voucher", expiresAt: 1_700_000_000_000 },
      "https://mcp.example.com/lexware",
    );
    expect(out.uploadUrl).toBe(URL_);
    expect(out.curlCommand).toBe(buildCurlCommand(URL_));
    expect(out.curlCommand).toContain(URL_);
    expect(out.expiresAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("does not double a trailing slash on the base url", () => {
    const out = buildTicketResponse(
      { ticket: "t1", type: "voucher", expiresAt: 0 },
      "https://mcp.example.com/lexware/",
    );
    expect(out.uploadUrl).toBe("https://mcp.example.com/lexware/upload/t1");
  });

  it("bakes the ticket's own filename and mimeType into the command", () => {
    // The values the model supplied when issuing the ticket must reach the command
    // — that is the whole point of asking for them. A ticket carrying them and a
    // command without them would silently file the receipt as upload.bin.
    const out = buildTicketResponse(
      {
        ticket: "abc123",
        type: "voucher",
        expiresAt: 0,
        filename: "Rechnung Müller.pdf",
        mimeType: "application/pdf",
      },
      "https://mcp.example.com/lexware",
    );
    expect(headerValue(out.curlCommand, "Content-Type")).toBe("application/pdf");
    const b64 = headerValue(out.curlCommand, "X-Filename-B64");
    expect(b64).toBeDefined();
    expect(Buffer.from(b64 as string, "base64url").toString("utf8")).toBe("Rechnung Müller.pdf");
  });
});

// --- The URL the operator is actually handed ------------------------------------

describe("the public base URL reaching the issued ticket", () => {
  const ticket = { ticket: "abc123", type: "voucher", expiresAt: 0 } as const;
  const staticEnv = (extra: Record<string, string>) =>
    ({ LEXWARE_API_KEY: "k", MCP_AUTH_TOKEN: "a".repeat(40), ...extra }) as NodeJS.ProcessEnv;

  it("uses SERVER_URL in static-token mode — both links, not just one of them", () => {
    // The whole failure was invisible in the config: SERVER_URL was read only in the
    // OAuth branch, so this deployment served a browser URL and a curl command that
    // pointed at the container's own loopback interface.
    const config = loadConfig(staticEnv({ SERVER_URL: "https://mcp.example.com/lexware" }));
    const out = buildTicketResponse(ticket, config.publicBaseUrl);
    expect(out.uploadUrl).toBe("https://mcp.example.com/lexware/upload/abc123");
    expect(out.curlCommand).toContain("https://mcp.example.com/lexware/upload/abc123");
    expect(out.uploadUrl).not.toContain("127.0.0.1");
    expect(out.curlCommand).not.toContain("127.0.0.1");
  });

  it("falls back to loopback on the CONFIGURED port when no public URL is set", () => {
    const config = loadConfig(staticEnv({ PORT: "9443" }));
    const out = buildTicketResponse(ticket, config.publicBaseUrl);
    expect(out.uploadUrl).toBe("http://127.0.0.1:9443/upload/abc123");
    expect(out.curlCommand).toContain("http://127.0.0.1:9443/upload/abc123");
  });
});

// --- One spot to replace, no mangling, no foreign tools -------------------------

describe("buildCurlCommand", () => {
  const full = buildCurlCommand(URL_, { filename: "Rechnung Müller.pdf", mimeType: "application/pdf" });

  it("carries the filename as base64url of its UTF-8 bytes, not as raw bytes", () => {
    // Measured with the shell-derivation form: `-H "X-Filename: $(basename
    // "$FILE")"` put raw bytes in a header, which is Latin-1 on the wire —
    // "Rechnung Müller.pdf" reached Lexware as "Rechnung MÃ¼ller.pdf" and
    // "Beleg – Januar 2026.pdf" as "Beleg â Januar 2026.pdf". Same failure class
    // the browser page already solved; same lock used here.
    const b64 = headerValue(full, "X-Filename-B64");
    expect(b64).toBeDefined();
    expect(b64).toMatch(/^[A-Za-z0-9_-]+$/); // pure ASCII: safe in a header AND in single quotes
    expect(Buffer.from(b64 as string, "base64url").toString("utf8")).toBe("Rechnung Müller.pdf");
    // The raw-byte header must not appear at all.
    expect(full).not.toContain("X-Filename: ");
    expect(full).not.toContain("basename");
  });

  it("round-trips every character class that broke the raw header", () => {
    for (const name of ["Rechnung Müller.pdf", "Beleg – Januar 2026.pdf", "Rechnung „Mai“.pdf", "Quittung 🧾.pdf"]) {
      const cmd = buildCurlCommand(URL_, { filename: name });
      const b64 = headerValue(cmd, "X-Filename-B64") as string;
      expect(Buffer.from(b64, "base64url").toString("utf8")).toBe(name);
    }
  });

  it("needs no file(1): the content type is a fixed value, never a command substitution", () => {
    // Measured on this host: `command -v file` is empty, so
    // `$(file -b --mime-type "$FILE")` printed "file: command not found", the
    // header went out EMPTY and the receipt was filed as application/octet-stream
    // — while curl still reported success with a file id.
    expect(headerValue(full, "Content-Type")).toBe("application/pdf");
    expect(full).not.toContain("file -b");
    expect(full).not.toContain("--mime-type");
    // No command substitution anywhere: nothing in this command runs another program.
    expect(full).not.toContain("$(");
    expect(full).not.toContain("`");
  });

  it("omits the filename header when unknown, but ALWAYS pins Content-Type (real value or explicit unset)", () => {
    const nameOnly = buildCurlCommand(URL_, { filename: "beleg.pdf" });
    expect(headerValue(nameOnly, "X-Filename-B64")).toBeDefined();
    // No VALUED Content-Type — but the unset form must be present (see below).
    expect(nameOnly).not.toMatch(/Content-Type: \S/);
    expect(nameOnly).toContain("-H 'Content-Type:'");

    const typeOnly = buildCurlCommand(URL_, { mimeType: "image/jpeg" });
    expect(headerValue(typeOnly, "Content-Type")).toBe("image/jpeg");
    expect(typeOnly).not.toContain("X-Filename-B64");

    // Neither known: the command still pins `-H 'Content-Type:'` — curl's syntax for
    // REMOVING an internally generated header. Measured: without it, --data-binary
    // silently declares 'application/x-www-form-urlencoded', a truthy value that wins
    // over the server's fallback chain and files every headerless upload under a
    // false type. With the header stripped, nothing is declared and the server's
    // ticket-mimeType / application/octet-stream fallback actually decides.
    const bare = buildCurlCommand(URL_);
    expect(bare).toBe(`FILE="/path/to/file.pdf"; curl -sS -X POST '${URL_}' -H 'Content-Type:' --data-binary @"$FILE"`);
    expect(headerValue(bare, "Content-Type")).toBeUndefined(); // unset form carries no value
  });

  it("leaves exactly ONE spot to replace: the FILE= path", () => {
    for (const cmd of [full, buildCurlCommand(URL_), buildCurlCommand(URL_, { filename: "a.pdf" })]) {
      expect(cmd.startsWith('FILE="/path/to/file.pdf"; curl ')).toBe(true);
      expect(cmd.split("/path/to/file.pdf")).toHaveLength(2);
      expect(cmd).toContain('--data-binary @"$FILE"');
    }
  });

  it("quotes the FILE placeholder so real paths with spaces AND apostrophes survive the naive edit", () => {
    // Quoted at all, because an UNQUOTED `FILE=/path with spaces/file.pdf` fails
    // at the ASSIGNMENT ("spaces/file.pdf: command not found") before curl ever
    // starts. DOUBLE-quoted, because an apostrophe pasted into SINGLE quotes ends
    // the quote and breaks the whole command line — and `O'Brien` paths are far
    // more common than `$` in paths (which inside double quotes merely expands to
    // nothing and fails visibly as file-not-found).
    for (const p of ["/home/user/receipts/Rechnung Müller.pdf", "/home/user/O'Brien/Rechnung 2026.pdf"]) {
      const edited = full.replace("/path/to/file.pdf", p);
      const assignment = edited.slice(0, edited.indexOf("; curl "));
      expect(assignment).toBe(`FILE="${p}"`);
      // Only a real shell can prove this property, so ask one.
      const seenByShell = execFileSync("sh", ["-c", `${assignment}; printf %s "$FILE"`], { encoding: "utf8" });
      expect(seenByShell).toBe(p);
    }
  });

  it("keeps the url single-quoted so a ticket value can never break out", () => {
    expect(full).toContain(`'${URL_}'`);
    expect(full).not.toContain(`"${URL_}"`);
    const other = buildCurlCommand("https://example.test/lexoffice/upload/ZmFrZS10aWNrZXQ");
    expect(other).toContain("'https://example.test/lexoffice/upload/ZmFrZS10aWNrZXQ'");
  });

  it("refuses a mimeType that could break out of its single quotes", () => {
    // The value comes from the model and the result is a command a human is told
    // to run. A quote in it must not end up in the command line at all — dropping
    // to the fixed unset form is the safe outcome, the server's fallback applies.
    const hostile = buildCurlCommand(URL_, { mimeType: "application/pdf'; rm -rf ~; echo '" });
    expect(hostile).not.toContain("rm -rf");
    expect(hostile).not.toMatch(/Content-Type: \S/); // nothing of the hostile value survives
    expect(hostile).toBe(`FILE="/path/to/file.pdf"; curl -sS -X POST '${URL_}' -H 'Content-Type:' --data-binary @"$FILE"`);
    // A legitimate type with parameters is not a bare token either — dropped, not mangled.
    expect(buildCurlCommand(URL_, { mimeType: "text/plain; charset=utf-8" })).not.toMatch(/Content-Type: \S/);
    // Ordinary types still pass.
    expect(headerValue(buildCurlCommand(URL_, { mimeType: "image/jpeg" }), "Content-Type")).toBe("image/jpeg");
  });

  it("treats a blank filename or mimeType as absent", () => {
    const blank = buildCurlCommand(URL_, { filename: "   ", mimeType: "  " });
    expect(blank).not.toContain("X-Filename-B64");
    expect(blank).not.toMatch(/Content-Type: \S/);
    expect(blank).toContain("-H 'Content-Type:'"); // absent type still pins the unset form
  });
});

// --- Tool annotations -------------------------------------------------------------

describe("upload tool annotations", () => {
  it("marks get-upload-result as a local read; create-upload-ticket stays a write", () => {
    const defs: { name: string; annotations: Record<string, boolean> }[] = [];
    const fake = {
      registerTool(def: { name: string; annotations: Record<string, boolean> }) {
        defs.push(def);
        return fake;
      },
    } as unknown as McpServer;
    registerUploadTools(fake, new TicketStore(), "https://mcp.example.test");
    const byName = Object.fromEntries(defs.map((d) => [d.name, d.annotations]));
    // get-upload-result only peeks the in-memory store, and it is DESIGNED to be
    // polled after a browser upload — a WRITE hint made approval-prompting clients
    // confirm every poll iteration, and a client enforcing a read-only policy
    // blocked the one tool that retrieves the fileId.
    expect(byName["get-upload-result"]).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    // Issuing a ticket arms an (unauthenticated, single-use) write path: WRITE.
    expect(byName["create-upload-ticket"]).toMatchObject({ readOnlyHint: false });
  });
});
