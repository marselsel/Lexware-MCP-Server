import express from "express";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { LexwareApiError } from "../src/lexware/errors.js";
import { deferBodyParsingFor, isUploadPath } from "../src/server-body-parsing.js";
import { TicketStore } from "../src/uploads/tickets.js";
import { FILENAME_B64_SOURCE, uploadPageHtml } from "../src/uploads/page.js";
import { decodeFilenameB64, headerString, registerUploadRoutes } from "../src/uploads/routes.js";

/**
 * Builds an app shaped like the real production stack: a global `express.json()`
 * pre-applied at router-stack index 0 (mirroring skybridge's own setup), then the
 * SAME `deferBodyParsingFor` swap `server.ts` uses to keep it off `/upload`. A
 * naked `express()` — what this file used before — cannot reproduce Critical-1
 * (a JSON-content-typed upload silently becoming an empty file): with no global
 * JSON parser in the stack to begin with, `express.raw()` always saw the real
 * bytes, so the bug was invisible here even though it fired in production.
 */
function makeApp(store: TicketStore, uploaded: unknown[] = [], maxBytes?: number) {
  const app = express();
  app.use(express.json());
  const configured = deferBodyParsingFor(app, isUploadPath);
  if (!configured) {
    throw new Error("deferBodyParsingFor could not locate the json layer — test setup no longer matches production");
  }
  registerUploadRoutes(
    app,
    store,
    async (args) => {
      uploaded.push(args);
      return { id: "file-123" };
    },
    maxBytes,
  );
  return app;
}

/** A naked app with NO global JSON parser at all — reproduces the pre-server.ts-fix
 * precondition (global parser still active on /upload) so routes.ts's own
 * `Buffer.isBuffer` guard can be exercised in isolation, without relying on the
 * server.ts-side fix also being correct. */
function makeAppWithoutBodyParsingFix(store: TicketStore, uploaded: unknown[] = []) {
  const app = express();
  app.use(express.json()); // deliberately NOT deferred for /upload — simulates the bug's precondition
  registerUploadRoutes(app, store, async (args) => {
    uploaded.push(args);
    return { id: "file-123" };
  });
  return app;
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("upload routes", () => {
  it("serves an HTML page for an open ticket", async () => {
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    const app = makeApp(store);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain(t.ticket);
    await s.close();
  });

  it("answers 410 for an unknown ticket", async () => {
    const app = makeApp(new TicketStore());
    const s = await listen(app);
    expect((await fetch(`${s.url}/upload/nope`)).status).toBe(410);
    await s.close();
  });

  it("accepts a raw body, forwards it and returns the file id", async () => {
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "beleg.pdf" },
      body: new Uint8Array([37, 80, 68, 70]),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fileId: "file-123", filename: "beleg.pdf", byteLength: 4 });
    expect(uploaded).toEqual([
      { bytes: new Uint8Array([37, 80, 68, 70]), filename: "beleg.pdf", contentType: "application/pdf", type: "voucher" },
    ]);
    await s.close();
  });

  it("rejects a second upload on the same ticket with 410", async () => {
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    const app = makeApp(store);
    const s = await listen(app);
    const send = () =>
      fetch(`${s.url}/upload/${t.ticket}`, {
        method: "POST",
        headers: { "content-type": "application/pdf", "x-filename": "a.pdf" },
        body: new Uint8Array([1]),
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(410);
    await s.close();
  });

  it("rejects an oversized body with 413, without naming the wrong limit", async () => {
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    const app = makeApp(store, [], 10);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "a.pdf" },
      body: new Uint8Array(64),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).not.toMatch(/\d{2,}/); // no byte-count baked into the message
    await s.close();
  });

  it("releases the ticket when the upload fails, so a retry works", async () => {
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    let attempt = 0;
    // makeApp's own upload fn always succeeds, so this needs its own app wired to a
    // failing-then-succeeding upload fn.
    const app = express();
    app.use(express.json());
    if (!deferBodyParsingFor(app, isUploadPath)) throw new Error("setup drifted");
    registerUploadRoutes(app, store, async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("lexware exploded");
      return { id: "file-after-retry" };
    });
    const s = await listen(app);
    const send = () =>
      fetch(`${s.url}/upload/${t.ticket}`, {
        method: "POST",
        headers: { "content-type": "application/pdf", "x-filename": "a.pdf" },
        body: new Uint8Array([1]),
      });
    const first = await send();
    expect(first.status).toBe(502);
    expect(first.headers.get("content-type")).toMatch(/application\/json/);
    const firstBody = await first.json();
    expect(typeof firstBody.error).toBe("string");
    const second = await send();
    expect(second.status).toBe(200);
    expect((await second.json()).fileId).toBe("file-after-retry");
    await s.close();
  });

  it("falls back to the ticket filename when the upload carries none", async () => {
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher", filename: "fallback.pdf", mimeType: "application/pdf" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([9]),
    });
    expect((uploaded[0] as { filename: string }).filename).toBe("fallback.pdf");
    await s.close();
  });

  // --- The global JSON parser must not touch /upload ---------------------------

  it("uploads a JSON-content-typed body byte-accurately in the production-like stack (root-cause fix)", async () => {
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const payload = JSON.stringify({ hello: "world" });
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-filename": "data.json" },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Must equal the JSON text's own byte length, not 0 — the historical bug
    // silently produced a 0-byte "successful" upload for exactly this request.
    expect(body.byteLength).toBe(Buffer.byteLength(payload));
    expect(uploaded).toHaveLength(1);
    expect((uploaded[0] as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array(Buffer.from(payload)));
    await s.close();
  });

  it("rejects an already-parsed JSON object body as empty, without consuming the ticket (defense in depth)", async () => {
    // Uses makeAppWithoutBodyParsingFix: the global JSON parser is deliberately
    // left active on /upload, reproducing the exact precondition of the original
    // bug. This proves routes.ts's own Buffer.isBuffer guard alone — independent
    // of the server.ts-side fix — turns "silent empty success" into a loud,
    // recoverable error.
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher" });
    const app = makeAppWithoutBodyParsingFix(store, uploaded);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-filename": "data.json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).not.toBe(200);
    expect(uploaded).toHaveLength(0);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    // Ticket must still be usable — a real (non-JSON) retry succeeds.
    const retry = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "a.pdf" },
      body: new Uint8Array([1]),
    });
    expect(retry.status).toBe(200);
    await s.close();
  });

  // --- An invalid ticket must reject before the body is read -------------------

  it("answers 410 for an unknown ticket without reading the request body", async () => {
    // A Fetch API ReadableStream body is the wrong tool here: undici drains it into
    // its own internal buffer eagerly, independent of real socket backpressure, so
    // a `pull()` counter mostly measures undici's buffering, not the server. Node's
    // raw `http.request` doesn't have that problem — `req.write()`'s boolean return
    // value IS the real Writable-stream/socket backpressure signal. If the server
    // responds without ever consuming the request body, the OS receive/send buffers
    // fill up and writing stalls after a small, bounded amount — regardless of how
    // much more data is available to send.
    const app = makeApp(new TicketStore());
    const s = await listen(app);
    const url = new URL(`${s.url}/upload/nope`);
    const chunk = Buffer.alloc(65536, 1); // 64 KiB
    const totalAvailable = 800; // 50 MB available, if the server actually read it all

    const { status, chunksWrittenBeforeResponse } = await new Promise<{ status: number; chunksWrittenBeforeResponse: number }>(
      (resolve, reject) => {
        let chunksWritten = 0;
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: { "content-type": "application/pdf", "x-filename": "a.pdf" },
          },
          (res) => {
            const chunksAtResponse = chunksWritten;
            res.resume();
            res.on("end", () => {
              // The request is still mid-write (backpressured, hundreds of chunks
              // short of totalAvailable) at this point — destroy it explicitly.
              // Without this, the still-open client socket keeps the server's
              // `close()` (below) waiting forever for a connection that neither
              // side is going to finish, and the WHOLE TEST hangs to its timeout
              // even though the 410 was received correctly.
              req.destroy();
              resolve({ status: res.statusCode ?? 0, chunksWrittenBeforeResponse: chunksAtResponse });
            });
          },
        );
        req.on("error", reject);
        function writeNext() {
          if (chunksWritten >= totalAvailable) {
            req.end();
            return;
          }
          chunksWritten += 1;
          if (req.write(chunk)) setImmediate(writeNext);
          else req.once("drain", writeNext);
        }
        writeNext();
      },
    );

    expect(status).toBe(410);
    // Generous bound: real runs land around 40 chunks (~2.5 MB); asserting well
    // below the 800 available (50 MB) is what actually distinguishes "rejected
    // early" from "read the whole body first".
    expect(chunksWrittenBeforeResponse).toBeLessThan(100);
    await s.close();
  });

  // --- An empty body must release the ticket -----------------------------------

  it("releases the ticket when the body is empty, so a retry with real bytes works", async () => {
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    const app = makeApp(store);
    const s = await listen(app);
    const empty = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "a.pdf" },
      body: new Uint8Array(0),
    });
    expect(empty.status).toBe(400);
    const retry = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "a.pdf" },
      body: new Uint8Array([1]),
    });
    expect(retry.status).toBe(200);
    await s.close();
  });

  // --- || not ??, and Content-Type is trimmed ----------------------------------

  it("falls back to the ticket filename when X-Filename is empty", async () => {
    // Exercises resolveFilename's ONE fallback decision point directly: an empty
    // header sanitizes to `undefined` (sanitizeFilename never returns ""), so the
    // `?? fromTicket` step is what has to fire here — not a `||`-vs-`??` distinction
    // (sanitizeFilename's return type rules "" out entirely, making that distinction
    // moot for filenames; see resolveFilename's doc comment).
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher", filename: "fromticket.pdf", mimeType: "image/png" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(200);
    expect((uploaded[0] as { filename: string }).filename).toBe("fromticket.pdf");
    await s.close();
  });

  it("falls back to the ticket content-type when Content-Type is empty", async () => {
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher", filename: "fromticket.pdf", mimeType: "image/png" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "", "x-filename": "a.pdf" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(200);
    expect((uploaded[0] as { contentType: string }).contentType).toBe("image/png");
    await s.close();
  });

  it("falls back to the ticket content-type when Content-Type is only a charset parameter", async () => {
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher", filename: "fromticket.pdf", mimeType: "image/png" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": ";charset=utf-8", "x-filename": "a.pdf" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(200);
    expect((uploaded[0] as { contentType: string }).contentType).toBe("image/png");
    await s.close();
  });

  // --- A TicketError from claim() must not release the lock --------------------

  it("a second concurrent claim (TicketError) does not release the ticket the first request is holding", async () => {
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    let resolveUpload!: (v: { id: string }) => void;
    const uploadPromise = new Promise<{ id: string }>((resolve) => {
      resolveUpload = resolve;
    });
    const app = express();
    app.use(express.json());
    if (!deferBodyParsingFor(app, isUploadPath)) throw new Error("setup drifted");
    registerUploadRoutes(app, store, async () => uploadPromise);
    const s = await listen(app);

    const first = fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "a.pdf" },
      body: new Uint8Array([1]),
    });
    // Give the first request time to claim() synchronously and reach the (pending) upload() call.
    await new Promise((r) => setTimeout(r, 100));

    const second = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "b.pdf" },
      body: new Uint8Array([2]),
    });
    expect(second.status).toBe(410);

    // If the second request's failed claim() had wrongly released the lock, a
    // third request could claim it too even though the first is still holding it.
    const third = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "c.pdf" },
      body: new Uint8Array([3]),
    });
    expect(third.status).toBe(410);

    resolveUpload({ id: "file-first" });
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect((await firstRes.json()).fileId).toBe("file-first");
    await s.close();
  });

  // --- Default limit ------------------------------------------------------------

  it("enforces the default 20 MB limit when maxBytes is not passed explicitly", async () => {
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    const app = express();
    app.use(express.json());
    if (!deferBodyParsingFor(app, isUploadPath)) throw new Error("setup drifted");
    registerUploadRoutes(app, store, async () => ({ id: "x" })); // no maxBytes -> default applies
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "a.pdf" },
      body: new Uint8Array(20 * 1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    await s.close();
  });

  // --- GET on a consumed ticket -------------------------------------------------

  it("answers 410 for GET on an already-consumed ticket", async () => {
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    const app = makeApp(store);
    const s = await listen(app);
    const upload = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "a.pdf" },
      body: new Uint8Array([1]),
    });
    expect(upload.status).toBe(200);
    const page = await fetch(`${s.url}/upload/${t.ticket}`);
    expect(page.status).toBe(410);
    await s.close();
  });

  // --- Every failure closes off as clean JSON, never a stack trace -------------

  it("returns a clean JSON error, not a stack trace, when the raw body parser itself fails", async () => {
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    const app = makeApp(store);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "a.pdf", "content-encoding": "gzip" },
      body: new Uint8Array([1, 2, 3]), // not actually gzip-compressed; inflate:false rejects it outright
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error).not.toMatch(/node_modules|\.ts:\d+:\d+|at [A-Za-z]/);
    await s.close();
  });

  // --- X-Filename sanitization --------------------------------------------------

  it("strips directory components from X-Filename (path traversal)", async () => {
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/x-sh", "x-filename": "../../../../etc/cron.d/evil.sh" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(200);
    expect((uploaded[0] as { filename: string }).filename).toBe("evil.sh");
    await s.close();
  });

  it("passes a comma-containing filename through unmangled, including Node's own folding of a doubled header", async () => {
    // Round-1 fix-round-2 regression: an earlier version split X-Filename on ","
    // to "take the first of a duplicated header" — but a comma is a completely
    // legal filename character (the browser page sends `file.name` verbatim),
    // and Node folds a genuinely REPEATED header into exactly this shape
    // ("a.pdf, b.pdf") at the HTTP layer. The old code could not tell "one
    // legitimate filename containing a comma" from "two duplicated headers"
    // and silently truncated the former. Both must now survive whole.
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "Rechnung, Mai 2026.pdf" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(200);
    expect((uploaded[0] as { filename: string }).filename).toBe("Rechnung, Mai 2026.pdf");
    await s.close();
  });

  it("preserves a doubled X-Filename header's Node-folded comma-joined value as-is (not the pre-comma prefix)", async () => {
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const headers = new Headers();
    headers.append("content-type", "application/pdf");
    headers.append("x-filename", "a.pdf");
    headers.append("x-filename", "b.pdf");
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers,
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(200);
    // Node folds the two headers into "a.pdf, b.pdf" before Express ever sees it;
    // that whole string is what routes.ts now uses (a comma-truncating "fix"
    // would instead produce "a.pdf" here — this assertion is what catches it).
    expect((uploaded[0] as { filename: string }).filename).toBe("a.pdf, b.pdf");
    await s.close();
  });

  it("headerString() takes the first element when a header value arrives as an array (Node API, not comma-related)", () => {
    // Node's IncomingHttpHeaders types every ordinary header as string | string[]
    // | undefined, but in real HTTP traffic only a handful of special headers
    // (Set-Cookie chief among them) are ever actually delivered as an array — a
    // genuinely doubled X-Filename folds into ONE string (see the two tests
    // above), so this branch is unreachable via a real request and is tested
    // directly instead.
    expect(headerString(["first.pdf", "second.pdf"])).toBe("first.pdf");
    expect(headerString("plain.pdf")).toBe("plain.pdf");
    expect(headerString(undefined)).toBeUndefined();
  });

  // --- Case-insensitive routing vs. the body-parsing swap ----------------------

  it("treats an uppercase /UPLOAD path the same as /upload for the body-parsing swap", async () => {
    // Express itself routes /UPLOAD/:ticket to the same handler as /upload/:ticket
    // (case-insensitive routing is Express's default) — but isUploadPath used to
    // compare case-sensitively, so the swap in server-body-parsing.ts silently did
    // NOT skip the global JSON parser for the uppercase spelling, reopening a
    // bounded slice of Critical 2 on that path. This exercises the full stack
    // exactly like the lowercase Critical-1 test: a JSON-content-typed body must
    // still arrive as real, byte-accurate raw bytes, not get parsed-then-ignored.
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const payload = JSON.stringify({ hello: "world" });
    const res = await fetch(`${s.url}/UPLOAD/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-filename": "data.json" },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byteLength).toBe(Buffer.byteLength(payload));
    await s.close();
  });

  // --- inflate: false regression ------------------------------------------------

  it("rejects a gzip-encoded body without inflating it, and leaves the ticket unclaimed for a retry", async () => {
    // Regression test for `inflate: false` on the raw parser: with the default
    // (inflate: true), a non-gzip body sent with Content-Encoding: gzip ALSO
    // fails, just via a different path (zlib decompression error) — so a test
    // that only checks "some 4xx happened" would stay green even if `inflate:
    // false` were removed. Asserting the SPECIFIC 415 that body-parser's own
    // `contentstream()` throws synchronously (before reading any bytes, see
    // node_modules/body-parser/lib/read.js) is what actually distinguishes the
    // two: remove `inflate: false` and this becomes a different status.
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    const app = makeApp(store);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "a.pdf", "content-encoding": "gzip" },
      body: new Uint8Array([1, 2, 3]), // not actually gzip-compressed
    });
    expect(res.status).toBe(415);
    // The rejection happens in express.raw(), before store.claim() ever runs —
    // the ticket was never touched, so a normal retry must succeed outright.
    const retry = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "a.pdf" },
      body: new Uint8Array([1]),
    });
    expect(retry.status).toBe(200);
    await s.close();
  });
});

/**
 * Builds an app whose upload fn always throws `err`, so the route's error mapping
 * can be exercised on its own. Mirrors makeApp's production-like body-parsing
 * stack (global express.json() + deferral) so nothing else differs.
 */
function makeFailingApp(store: TicketStore, err: unknown) {
  const app = express();
  app.use(express.json());
  if (!deferBodyParsingFor(app, isUploadPath)) throw new Error("setup drifted");
  registerUploadRoutes(app, store, async () => {
    throw err;
  });
  return app;
}

// --- A Lexware rejection is not a server failure --------------------------------

describe("upload error mapping", () => {
  it("forwards a LexwareApiError's own status instead of reporting 502", async () => {
    // Measured before the fix: a 406 from Lexware ("unsupported file type" — a JPG
    // or an oversized PDF dropped onto the page) reached the browser as 502. The
    // operator's runbook reads 502 on /lexoffice as "container is not running", so
    // a user error sent them hunting for an outage that did not exist.
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    const app = makeFailingApp(store, new LexwareApiError(406, "Lexware API 406: unsupported file type"));
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "x-filename": "foto.jpg" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(406);
    // The original wording must survive verbatim, not be replaced by a generic text.
    expect((await res.json()).error).toBe("Lexware API 406: unsupported file type");
    await s.close();
  });

  it("forwards other 4xx rejections too, and still releases the ticket", async () => {
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    const app = makeFailingApp(store, new LexwareApiError(413, "Lexware API 413: file too large"));
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "gross.pdf" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(413);
    // Forwarding the status must not skip the release() path: the ticket stays
    // usable, so a corrected retry can still go through.
    expect(store.peek(t.ticket)?.inFlight).toBe(false);
    await s.close();
  });

  it("keeps 502 for a transport failure reaching Lexware (status 0)", async () => {
    // A LexwareApiError with status 0 means the request never got an HTTP answer.
    // That IS a gateway problem and must stay 502 — status 0 is also not a value
    // res.status() could send.
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    const app = makeFailingApp(store, new LexwareApiError(0, "Lexware API request failed: connect ECONNREFUSED"));
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "a.pdf" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(502);
    await s.close();
  });

  it("keeps 502 for a non-Lexware error", async () => {
    const store = new TicketStore();
    const t = store.create({ type: "voucher" });
    const app = makeFailingApp(store, new Error("something else exploded"));
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "a.pdf" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(502);
    await s.close();
  });
});

// --- Filenames above U+00FF via X-Filename-B64 ----------------------------------

/**
 * Evaluates the page's OWN encoder source, so these tests drive the exact code the
 * browser runs rather than a hand-copied twin that could silently drift from it.
 */
const filenameB64 = new Function(`${FILENAME_B64_SOURCE}; return filenameB64;`)() as (name: string) => string;

/** The names measured in the review, plus an emoji: all real, everyday German filenames. */
const NAMES = [
  "Rechnung Müller.pdf", // U+00FC — the only one that worked before
  "Beleg – Januar 2026.pdf", // U+2013 en dash — TypeError, "8211 > 255"
  "Rechnung „Mai“.pdf", // U+201E / U+201C German quotes — TypeError
  "Quittung 🧾.pdf", // astral plane, surrogate pair
];

describe("X-Filename-B64", () => {
  it("reproduces the failure the encoding exists for: the raw name cannot go in a header", () => {
    // Node's fetch stack raises the very same TypeError the browser does ("value
    // of 8211 which is greater than 255"), thrown BEFORE the request is sent —
    // which is why the page showed a raw TypeError and no request ever left.
    expect(() => new Headers({ "X-Filename": "Beleg – Januar 2026.pdf" })).toThrow(TypeError);
    expect(() => new Headers({ "X-Filename": "Rechnung „Mai“.pdf" })).toThrow(TypeError);
    // The encoded form is pure ASCII, so the same header layer accepts it.
    for (const name of NAMES) {
      expect(filenameB64(name)).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(() => new Headers({ "X-Filename-B64": filenameB64(name) })).not.toThrow();
    }
  });

  for (const name of NAMES) {
    it(`round-trips ${JSON.stringify(name)} from the page encoder through the server`, async () => {
      const store = new TicketStore();
      const uploaded: unknown[] = [];
      const t = store.create({ type: "voucher" });
      const app = makeApp(store, uploaded);
      const s = await listen(app);
      const res = await fetch(`${s.url}/upload/${t.ticket}`, {
        method: "POST",
        headers: { "content-type": "application/pdf", "x-filename-b64": filenameB64(name) },
        body: new Uint8Array([1]),
      });
      expect(res.status).toBe(200);
      expect((uploaded[0] as { filename: string }).filename).toBe(name);
      await s.close();
    });
  }

  it("prefers X-Filename-B64 over a simultaneously sent X-Filename", async () => {
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "x-filename": "ascii-ersatz.pdf",
        "x-filename-b64": filenameB64("Beleg – Januar 2026.pdf"),
      },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(200);
    expect((uploaded[0] as { filename: string }).filename).toBe("Beleg – Januar 2026.pdf");
    await s.close();
  });

  it("falls back to X-Filename when X-Filename-B64 is not valid base64url (no throw, no 500)", async () => {
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "x-filename": "echt.pdf",
        "x-filename-b64": "not base64!!",
      },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(200);
    expect((uploaded[0] as { filename: string }).filename).toBe("echt.pdf");
    await s.close();
  });

  it("falls back to the ticket filename when X-Filename-B64 is undecodable and no X-Filename is sent", async () => {
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher", filename: "fromticket.pdf" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename-b64": "=" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(200);
    expect((uploaded[0] as { filename: string }).filename).toBe("fromticket.pdf");
    await s.close();
  });

  it("strips directory components from a decoded X-Filename-B64 (path traversal)", async () => {
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-sh",
        "x-filename-b64": filenameB64("../../../../etc/cron.d/evil.sh"),
      },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(200);
    expect((uploaded[0] as { filename: string }).filename).toBe("evil.sh");
    await s.close();
  });

  it("decodeFilenameB64 accepts the padded and unpadded forms alike", () => {
    expect(decodeFilenameB64(filenameB64("Rechnung Müller.pdf"))).toBe("Rechnung Müller.pdf");
    expect(decodeFilenameB64(Buffer.from("Beleg – Januar.pdf", "utf8").toString("base64url"))).toBe(
      "Beleg – Januar.pdf",
    );
    // Standard-base64 padding kept by a hand-rolled client.
    const padded = Buffer.from("abc.pdf", "utf8").toString("base64");
    expect(padded.endsWith("=")).toBe(true);
    expect(decodeFilenameB64(padded)).toBe("abc.pdf");
  });

  it("decodeFilenameB64 rejects a value that is pure alphabet but not a whole encoding (round-trip lock)", () => {
    // "QUJDQ" is five characters, all inside the base64url alphabet, so the
    // alphabet check passes — but it is not a complete encoding of anything.
    // Buffer.from() silently drops the orphan fifth character and hands back
    // "ABC", a name the caller never sent. ONLY the re-encode comparison catches
    // this: the U+FFFD and control-character checks see nothing wrong with "ABC".
    expect(Buffer.from("QUJDQ", "base64url").toString("utf8")).toBe("ABC"); // what leniency yields
    expect(decodeFilenameB64("QUJDQ")).toBeUndefined(); // what we must answer
    // Same shape, one character further along: also incomplete, also rejected.
    expect(decodeFilenameB64("UmVjaG51bmc")).toBe("Rechnung"); // 11 chars = a whole 8-byte group
    expect(decodeFilenameB64("UmVjaG51bmdz")).toBe("Rechnungs"); // 12 chars, still whole
    expect(decodeFilenameB64("UmVjaG51bmdzQ")).toBeUndefined(); // 13: one orphan char
  });

  it("falls back to X-Filename for a pure-alphabet but incomplete X-Filename-B64", async () => {
    const store = new TicketStore();
    const uploaded: unknown[] = [];
    const t = store.create({ type: "voucher" });
    const app = makeApp(store, uploaded);
    const s = await listen(app);
    const res = await fetch(`${s.url}/upload/${t.ticket}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-filename": "echt.pdf", "x-filename-b64": "QUJDQ" },
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(200);
    // Without the round-trip lock this would silently be "ABC".
    expect((uploaded[0] as { filename: string }).filename).toBe("echt.pdf");
    await s.close();
  });

  it("decodeFilenameB64 rejects rather than mangles: bad alphabet, truncation, bad UTF-8, control chars", () => {
    // Buffer.from(…, "base64url") is lenient — it silently drops stray characters
    // and tolerates a truncated group — so without the alphabet check and the
    // re-encode round-trip these would each yield a WRONG name, not an error.
    expect(decodeFilenameB64("not base64!!")).toBeUndefined();
    expect(decodeFilenameB64("a")).toBeUndefined(); // truncated: a single base64 char is <1 byte
    expect(decodeFilenameB64("")).toBeUndefined();
    expect(decodeFilenameB64("   ")).toBeUndefined();
    // 0xFF 0xFE is not valid UTF-8: Node substitutes U+FFFD instead of throwing.
    expect(decodeFilenameB64(Buffer.from([0xff, 0xfe]).toString("base64url"))).toBeUndefined();
    // Control characters are the one thing base64 could smuggle past the header layer.
    expect(decodeFilenameB64(Buffer.from("a\r\nb.pdf", "utf8").toString("base64url"))).toBeUndefined();
    expect(decodeFilenameB64(Buffer.from("a\u0001b.pdf", "utf8").toString("base64url"))).toBeUndefined();
  });

  it("the served page never assigns innerHTML — the file id is built as a text node", () => {
    // body.fileId is whatever the Lexware API returned; interpolating it into
    // innerHTML made a value from a foreign API the source of this page's markup.
    // The <code> styling is kept, the parsing is not.
    const html = uploadPageHtml("abc123");
    expect(html).not.toContain("innerHTML");
    expect(html).toContain('document.createElement("code")');
    expect(html).toContain("id.textContent = ");
    // No hand-built markup around the id anywhere on the success path either.
    expect(html).not.toContain("<code>\" + body.fileId");
  });

  it("the served page sends the encoded header and never the raw filename", () => {
    const html = uploadPageHtml("abc123");
    expect(html).toContain("X-Filename-B64");
    expect(html).toContain("filenameB64(file.name)");
    // The old line `"X-Filename": file.name` is what threw in the browser.
    expect(html).not.toContain('"X-Filename": file.name');
  });
});
