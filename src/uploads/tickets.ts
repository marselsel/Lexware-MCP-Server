import { randomBytes } from "node:crypto";

/** Result of a completed upload, handed back to the model as a short id. */
export type UploadResult = { fileId: string; filename: string; byteLength: number };

export type TicketState = {
  ticket: string;
  /** Lexware file category, fixed when the ticket is issued. */
  type: string;
  /** Fallbacks used only when the upload itself carries no filename/content-type. */
  filename?: string;
  mimeType?: string;
  expiresAt: number;
  /** Set once the upload succeeded; presence also marks the ticket as consumed. */
  result?: UploadResult;
  /**
   * Set synchronously by claim() and held for the (necessarily async) duration of
   * reading the body and calling the Lexware API. Blocks a second claim() on the
   * same ticket — a retried request, a duplicated proxy call, or a leaked ticket —
   * from also writing a voucher. Cleared by release() on failure or by complete()
   * on success.
   */
  inFlight?: boolean;
};

/** Carries the HTTP status the route should answer with. */
export class TicketError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "TicketError";
  }
}

const DEFAULT_TTL_MS = 15 * 60_000;

/**
 * In-memory, single-instance ticket store. A restart drops open tickets, which is
 * acceptable at a 15-minute TTL and surfaces as a clear 410 rather than a hang.
 */
export class TicketStore {
  private readonly tickets = new Map<string, TicketState>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  create(opts: { type: string; filename?: string; mimeType?: string }): TicketState {
    this.sweep();
    const state: TicketState = {
      ticket: randomBytes(24).toString("base64url"),
      type: opts.type,
      filename: opts.filename,
      mimeType: opts.mimeType,
      expiresAt: this.now() + this.ttlMs,
    };
    this.tickets.set(state.ticket, state);
    return state;
  }

  /**
   * Returns the ticket for an upload, or throws 410 when unusable. Marks the ticket
   * as in-flight synchronously (before any `await` in the caller) so a second,
   * overlapping claim() on the same ticket — retry, duplicated proxy request, a
   * leaked ticket — is rejected instead of also writing a voucher. On failure the
   * caller must call release() to allow a retry with the same ticket.
   */
  claim(ticket: string): TicketState {
    const err = this.usabilityError(ticket);
    if (err) throw err;
    // usabilityError() returned undefined, so the entry exists (peek() would have
    // evicted an expired one), is not completed, and is not in flight.
    const state = this.tickets.get(ticket)!;
    state.inFlight = true;
    return state;
  }

  /**
   * Read-only usability check — returns the exact {@link TicketError} that
   * claim() would throw, or `undefined` for a claimable ticket. The single
   * source of truth for the reject conditions AND their messages: claim() and
   * the route layer's two non-claiming call sites (the GET page and the POST
   * pre-body check) all go through here, so they can never drift apart.
   * Delegates to peek(), inheriting its expiry-eviction and its in-flight
   * shield (an expired-but-in-flight entry reads "already used", not
   * "expired" — see peek()).
   */
  usabilityError(ticket: string): TicketError | undefined {
    const state = this.peek(ticket);
    if (!state) return new TicketError("Upload ticket is unknown or expired. Create a new one.", 410);
    if (state.result || state.inFlight) return new TicketError("Upload ticket was already used.", 410);
    return undefined;
  }

  /**
   * Releases the in-flight lock after a failed upload so the same ticket can be
   * claimed again. No-op for an unknown ticket and for one that already completed
   * (result is the lock from that point on; release() must not undo it).
   */
  release(ticket: string): void {
    const state = this.tickets.get(ticket);
    if (state && !state.result) state.inFlight = false;
  }

  complete(ticket: string, result: UploadResult): void {
    // Silent no-op for an unknown ticket: intentional. This method is only ever
    // called with a ticket claim() just returned, so an unknown ticket here means a
    // wiring bug in the route layer, not a normal runtime path worth surfacing to
    // the caller as an exception.
    const state = this.tickets.get(ticket);
    if (state) {
      state.result = result;
      state.inFlight = false;
      // Re-arm the TTL from the moment of COMPLETION. Without this, the result was
      // readable only until the ticket's original creation-time expiry — an upload
      // dropped onto the page at minute 14 left get-upload-result a sub-minute
      // window, after which the model was told "unknown or expired, issue a new
      // one" and the user uploaded the SAME receipt again (duplicate voucher,
      // first file id orphaned). The result now stays readable for a full TTL
      // after the upload finished; the entry is evicted after that as before.
      state.expiresAt = this.now() + this.ttlMs;
    }
  }

  /**
   * Lookup that keeps working after the ticket was consumed. Not entirely read-only:
   * like claim(), it evicts an entry it finds expired (same reason). Return value is
   * unchanged — `undefined`.
   */
  peek(ticket: string): TicketState | undefined {
    const state = this.tickets.get(ticket);
    if (!state) return undefined;
    // An in-flight entry is never expired-evicted (same reasoning as claim()): the
    // upload is happening RIGHT NOW, and callers need the truthful answers — the
    // GET page and the POST pre-check see "already used", get-upload-result sees
    // "pending" — not a false "expired" that races the in-progress complete().
    if (state.expiresAt <= this.now() && !state.inFlight) {
      this.tickets.delete(ticket);
      return undefined;
    }
    return state;
  }

  /**
   * True when this call takes the one body-read slot for `ticket`; false when a
   * request already holds it. NOT the single-use lock (claim() stays that): this
   * bounds how many request BODIES can be buffering for one ticket at a time.
   * Without it, N simultaneous POSTs naming the same valid ticket all passed the
   * (deliberately non-claiming) pre-check and each buffered up to maxBytes before
   * the first claim() won — unbounded memory amplification from one leaked ticket
   * URL. Deliberately keyed in a separate Set rather than on TicketState, so the
   * slot survives the entry being evicted mid-read and is always released by the
   * route's response-close hook, never leaked.
   */
  beginBodyRead(ticket: string): boolean {
    if (this.readingBody.has(ticket)) return false;
    this.readingBody.add(ticket);
    return true;
  }

  /** Releases the body-read slot. Idempotent; called from the response-close hook. */
  endBodyRead(ticket: string): void {
    this.readingBody.delete(ticket);
  }

  private readonly readingBody = new Set<string>();

  /** Bulk cleanup on create(); claim() and peek() additionally evict what they touch. */
  private sweep(): void {
    const t = this.now();
    for (const [key, state] of this.tickets) {
      // Never evict an in-flight entry (see claim()/peek()); release() clears the
      // flag on failure, so a failed expired entry is collected on the next pass.
      if (state.expiresAt <= t && !state.inFlight) this.tickets.delete(key);
    }
  }
}
