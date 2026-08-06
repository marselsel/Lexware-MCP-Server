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
});
