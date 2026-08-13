import { describe, expect, it } from "vitest";
import { TicketError, TicketStore } from "../src/uploads/tickets.js";

describe("TicketStore", () => {
  it("creates a ticket with a random id and the configured ttl", () => {
    let now = 1_000;
    const store = new TicketStore(15 * 60_000, () => now);
    const a = store.create({ type: "voucher" });
    const b = store.create({ type: "voucher" });
    expect(a.ticket).not.toBe(b.ticket);
    expect(a.ticket.length).toBeGreaterThanOrEqual(32);
    expect(a.expiresAt).toBe(1_000 + 15 * 60_000);
  });

  it("claims an open ticket and carries its fallbacks", () => {
    const store = new TicketStore(60_000, () => 0);
    const t = store.create({ type: "voucher", filename: "fallback.pdf", mimeType: "application/pdf" });
    const claimed = store.claim(t.ticket);
    expect(claimed.filename).toBe("fallback.pdf");
    expect(claimed.type).toBe("voucher");
  });

  it("rejects a second claim with 410", () => {
    const store = new TicketStore(60_000, () => 0);
    const t = store.create({ type: "voucher" });
    store.claim(t.ticket);
    store.complete(t.ticket, { fileId: "f1", filename: "x.pdf", byteLength: 3 });
    try {
      store.claim(t.ticket);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TicketError);
      expect((e as TicketError).status).toBe(410);
    }
  });

  it("rejects an unknown ticket with 410", () => {
    const store = new TicketStore(60_000, () => 0);
    expect(() => store.claim("does-not-exist")).toThrow(TicketError);
  });

  it("rejects an expired ticket with 410", () => {
    let now = 0;
    const store = new TicketStore(60_000, () => now);
    const t = store.create({ type: "voucher" });
    now = 60_001;
    expect(() => store.claim(t.ticket)).toThrow(TicketError);
  });

  it("still returns the result via peek after the ticket was consumed", () => {
    const store = new TicketStore(60_000, () => 0);
    const t = store.create({ type: "voucher" });
    store.claim(t.ticket);
    store.complete(t.ticket, { fileId: "f9", filename: "beleg.pdf", byteLength: 42 });
    expect(store.peek(t.ticket)?.result).toEqual({ fileId: "f9", filename: "beleg.pdf", byteLength: 42 });
  });

  it("peek returns undefined once the ticket expired", () => {
    let now = 0;
    const store = new TicketStore(60_000, () => now);
    const t = store.create({ type: "voucher" });
    store.claim(t.ticket);
    store.complete(t.ticket, { fileId: "f9", filename: "b.pdf", byteLength: 1 });
    now = 60_001;
    expect(store.peek(t.ticket)).toBeUndefined();
  });

  it("rejects a second claim while the first is still in flight (no complete yet)", () => {
    const store = new TicketStore(60_000, () => 0);
    const t = store.create({ type: "voucher" });
    store.claim(t.ticket);
    try {
      store.claim(t.ticket);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TicketError);
      expect((e as TicketError).status).toBe(410);
    }
  });

  it("allows a fresh claim after release()", () => {
    const store = new TicketStore(60_000, () => 0);
    const t = store.create({ type: "voucher" });
    store.claim(t.ticket);
    store.release(t.ticket);
    const claimed = store.claim(t.ticket);
    expect(claimed.ticket).toBe(t.ticket);
  });

  it("release() on an unknown ticket is a no-op", () => {
    const store = new TicketStore(60_000, () => 0);
    expect(() => store.release("does-not-exist")).not.toThrow();
  });

  // --- expired entries are removed on sight, not only on the next create() -------
  //
  // Retention is not directly observable through the store's public API (the Map is
  // private and both an evicted and a merely hidden entry answer the same way), so
  // these use the injected clock: stepping it BACK past expiresAt — what an NTP
  // correction does to a real one — makes the difference visible. An entry that was
  // only hidden becomes usable again; an entry that was actually deleted stays gone.

  it("peek() deletes the expired entry it reports as gone", () => {
    let now = 0;
    const store = new TicketStore(60_000, () => now);
    const t = store.create({ type: "voucher" });
    now = 60_001;
    expect(store.peek(t.ticket)).toBeUndefined();
    now = 0; // clock steps back
    expect(store.peek(t.ticket)).toBeUndefined();
    expect(() => store.claim(t.ticket)).toThrow(TicketError);
  });

  it("claim() deletes the expired entry it rejects", () => {
    let now = 0;
    const store = new TicketStore(60_000, () => now);
    const t = store.create({ type: "voucher" });
    now = 60_001;
    expect(() => store.claim(t.ticket)).toThrow(TicketError);
    now = 0; // clock steps back
    expect(() => store.claim(t.ticket)).toThrow(TicketError);
    expect(store.peek(t.ticket)).toBeUndefined();
  });

  it("release() after complete() does not make the ticket usable again", () => {
    const store = new TicketStore(60_000, () => 0);
    const t = store.create({ type: "voucher" });
    store.claim(t.ticket);
    store.complete(t.ticket, { fileId: "f1", filename: "x.pdf", byteLength: 3 });
    store.release(t.ticket);
    expect(() => store.claim(t.ticket)).toThrow(TicketError);
  });

  // --- complete() re-arms the TTL: the result outlives the CREATION clock --------

  it("keeps the result readable for a full TTL after COMPLETION, not after creation", () => {
    // The bug this pins down: an upload dropped onto the page at minute 14 left
    // get-upload-result a sub-minute window before the creation-time expiry evicted
    // the entry — the model was told "unknown or expired, issue a new one" for an
    // upload that SUCCEEDED, and the user filed the same receipt twice.
    let now = 0;
    const store = new TicketStore(60_000, () => now);
    const t = store.create({ type: "voucher" }); // creation clock runs out at 60_000
    now = 59_000; // upload lands just before that
    store.claim(t.ticket);
    store.complete(t.ticket, { fileId: "f1", filename: "x.pdf", byteLength: 3 });
    now = 100_000; // creation clock long past — the result must still be readable
    expect(store.peek(t.ticket)?.result?.fileId).toBe("f1");
    now = 119_001; // one full TTL after completion (59_000 + 60_000) — now it may go
    expect(store.peek(t.ticket)).toBeUndefined();
  });

  it("never expiry-evicts an IN-FLIGHT entry: a racing claim reads 'already used' and the result survives", () => {
    let now = 0;
    const store = new TicketStore(60_000, () => now);
    const t = store.create({ type: "voucher" });
    now = 59_999;
    store.claim(t.ticket); // the upload starts just before expiry…
    now = 61_000; // …and its Lexware call is still running past it
    // A second request racing the same ticket must NOT delete the in-flight entry —
    // that would orphan the first request's complete() (result silently lost even
    // though Lexware filed the receipt). It reads "already used", not "expired".
    expect(() => store.claim(t.ticket)).toThrow(/already used/);
    // get-upload-result during that window reads "pending", never "expired".
    expect(store.peek(t.ticket)?.inFlight).toBe(true);
    expect(store.peek(t.ticket)?.result).toBeUndefined();
    // create() → sweep() must not collect it either.
    store.create({ type: "voucher" });
    store.complete(t.ticket, { fileId: "f2", filename: "y.pdf", byteLength: 1 });
    expect(store.peek(t.ticket)?.result?.fileId).toBe("f2");
  });

  it("still collects an expired entry once release() clears the in-flight shield", () => {
    let now = 0;
    const store = new TicketStore(60_000, () => now);
    const t = store.create({ type: "voucher" });
    store.claim(t.ticket);
    now = 61_000;
    store.release(t.ticket); // the upload failed, past expiry
    expect(store.peek(t.ticket)).toBeUndefined(); // expired + not in flight → evicted
  });

  // --- usabilityError: claim()'s single source of truth, read-only ---------------

  it("usabilityError mirrors claim() exactly without ever taking the lock", () => {
    const store = new TicketStore(60_000, () => 0);
    expect(store.usabilityError("nope")?.message).toMatch(/unknown or expired/);
    expect(store.usabilityError("nope")?.status).toBe(410);
    const t = store.create({ type: "voucher" });
    // Checking is read-only: any number of checks, and the ticket still claims.
    expect(store.usabilityError(t.ticket)).toBeUndefined();
    expect(store.usabilityError(t.ticket)).toBeUndefined();
    const claimed = store.claim(t.ticket);
    expect(store.usabilityError(t.ticket)?.message).toMatch(/already used/); // in flight
    store.complete(claimed.ticket, { fileId: "f", filename: "x.pdf", byteLength: 1 });
    expect(store.usabilityError(t.ticket)?.message).toMatch(/already used/); // completed
  });

  // --- the body-read slot (bounds buffering; NOT the single-use lock) ------------

  it("beginBodyRead grants one slot per ticket until endBodyRead releases it", () => {
    const store = new TicketStore(60_000, () => 0);
    expect(store.beginBodyRead("t1")).toBe(true);
    expect(store.beginBodyRead("t1")).toBe(false); // a second concurrent reader is refused
    expect(store.beginBodyRead("t2")).toBe(true); // slots are per ticket
    store.endBodyRead("t1");
    expect(store.beginBodyRead("t1")).toBe(true); // a sequential retry gets the slot back
    store.endBodyRead("t1");
    store.endBodyRead("t1"); // idempotent — the response-close hook may fire late
    expect(store.beginBodyRead("t1")).toBe(true);
  });
});
