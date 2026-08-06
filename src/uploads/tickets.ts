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
    const state = this.tickets.get(ticket);
    if (!state || state.expiresAt <= this.now()) {
      throw new TicketError("Upload ticket is unknown or expired. Create a new one.", 410);
    }
    if (state.result || state.inFlight) {
      throw new TicketError("Upload ticket was already used.", 410);
    }
    state.inFlight = true;
    return state;
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
    }
  }

  /** Read-only lookup that keeps working after the ticket was consumed. */
  peek(ticket: string): TicketState | undefined {
    const state = this.tickets.get(ticket);
    if (!state || state.expiresAt <= this.now()) return undefined;
    return state;
  }

  private sweep(): void {
    const t = this.now();
    for (const [key, state] of this.tickets) {
      if (state.expiresAt <= t) this.tickets.delete(key);
    }
  }
}
