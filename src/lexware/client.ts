import { LexwareApiError, describeErrorBody } from "./errors.js";
import { RateLimiter } from "./rate-limiter.js";

export interface LexwareClientOptions {
  baseUrl: string;
  apiKey: string;
  /** When true, log method/path/status (never bodies or secrets). */
  debug?: boolean;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Jitter source in [0,1). Injectable for deterministic tests. */
  random?: () => number;
  /** Max retry attempts for retryable failures (429 / transient). Default 4. */
  maxRetries?: number;
  /** Abort an in-flight request after this many ms (a hung upstream otherwise blocks forever). Default 30000. */
  requestTimeoutMs?: number;
  rateLimit?: { capacity: number; refillPerSec: number };
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Whether the call is safe to retry on a transport/5xx failure. GETs are
   * idempotent; POSTs that create documents are NOT and must never be replayed
   * on an ambiguous failure (would create duplicates). 429 is always retryable
   * (Lexware does not execute a throttled call) regardless of this flag.
   */
  idempotent: boolean;
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
/** Clamp any retry wait so a hostile/buggy `Retry-After` can't hang a request. */
const MIN_RETRY_WAIT_MS = 250;
const MAX_RETRY_WAIT_MS = 30_000;

/** Thin, rate-limited, retry-aware client for the Lexware Office REST API. */
export class LexwareClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly debug: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly limiter: RateLimiter;

  constructor(opts: LexwareClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.debug = opts.debug ?? false;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.maxRetries = opts.maxRetries ?? 4;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    const rl = opts.rateLimit ?? { capacity: 2, refillPerSec: 2 };
    this.limiter = new RateLimiter(rl.capacity, rl.refillPerSec, opts.now, this.sleep);
  }

  get<T>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>("GET", path, { query, idempotent: true });
  }

  /** POST is treated as non-idempotent: never auto-retried on transport/5xx errors. */
  post<T>(path: string, body: unknown, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>("POST", path, { body, query, idempotent: false });
  }

  async request<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    let bodyText: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyText = JSON.stringify(opts.body);
    }
    const res = await this.sendWithRetry(method, path, {
      query: opts.query,
      headers,
      body: bodyText,
      idempotent: opts.idempotent,
    });
    try {
      return (await this.safeParse(res)) as T;
    } catch (err) {
      throw this.bodyReadError(method, path, err);
    }
  }

  /**
   * GET a binary resource (a rendered document PDF or an uploaded file). GETs are
   * idempotent, so this is retried like {@link get} on 429 / transient failures.
   * Returns the raw bytes plus the response content-type.
   */
  async getBinary(
    path: string,
    accept = "application/pdf",
  ): Promise<{ data: Buffer; contentType: string }> {
    const res = await this.sendWithRetry("GET", path, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: accept },
      idempotent: true,
    });
    try {
      const data = Buffer.from(await res.arrayBuffer());
      return { data, contentType: res.headers.get("content-type") ?? accept };
    } catch (err) {
      throw this.bodyReadError("GET", path, err);
    }
  }

  /**
   * POST a multipart/form-data upload: a single `file` part plus optional string
   * fields. Like {@link post} this is NON-idempotent — never replayed on a
   * transport/5xx failure (a duplicate upload risk); 429 is still retried.
   *
   * IMPORTANT: we deliberately do NOT set a Content-Type header — `fetch` derives
   * the `multipart/form-data; boundary=…` value from the FormData body. Setting it
   * manually drops the boundary and the upload fails.
   */
  async postMultipart<T>(
    path: string,
    file: { bytes: Uint8Array; filename: string; contentType: string },
    fields: Record<string, string> = {},
  ): Promise<T> {
    const form = new FormData();
    // A Uint8Array/Buffer is a valid BlobPart at runtime (Blob copies the view's
    // bytes, honoring byteOffset/length), but the DOM lib types BlobPart as
    // ArrayBuffer-backed only; the cast bridges that without an extra copy.
    const blob = new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.contentType });
    form.set("file", blob, file.filename);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const res = await this.sendWithRetry("POST", path, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      body: form,
      idempotent: false,
    });
    // Same body-read guard as request()/getBinary: a 2xx whose body then fails
    // mid-read surfaces a classified LexwareApiError, not a raw undici transport error.
    try {
      return (await this.safeParse(res)) as T;
    } catch (err) {
      throw this.bodyReadError("POST", path, err);
    }
  }

  /**
   * Shared transport for every verb: rate-limit, fetch with a timeout, retry per
   * policy, and throw {@link LexwareApiError} on a non-OK status. Returns the
   * successful `Response` for the caller to parse (JSON or binary). 429 is always
   * retried; transport/5xx failures are retried only for idempotent calls.
   */
  private async sendWithRetry(
    method: string,
    path: string,
    opts: {
      query?: RequestOptions["query"];
      headers: Record<string, string>;
      body?: BodyInit;
      idempotent: boolean;
    },
  ): Promise<Response> {
    const url = this.buildUrl(path, opts.query);

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await this.limiter.acquire();

      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method,
          headers: opts.headers,
          body: opts.body,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (err) {
        // Transport failure (DNS, reset) or our own request timeout (AbortSignal).
        // The request may or may not have reached Lexware, so only retry idempotent calls.
        if (opts.idempotent && attempt < this.maxRetries) {
          await this.backoff(attempt++);
          continue;
        }
        this.log(method, path, "network-error");
        throw new LexwareApiError(
          0,
          `Network error contacting Lexware${
            opts.idempotent ? "" : " (POST not retried to avoid duplicates)"
          }: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }

      this.log(method, path, String(res.status));

      // 429 is always safe to retry: a throttled call is not executed.
      if (res.status === 429 && attempt < this.maxRetries) {
        const waitMs = this.retryAfterMs(res, attempt);
        await this.drain(res); // release the keep-alive connection before retrying
        await this.sleep(waitMs);
        attempt++;
        continue;
      }
      // Transient upstream errors: retry only idempotent calls.
      if (RETRYABLE_STATUS.has(res.status) && opts.idempotent && attempt < this.maxRetries) {
        await this.drain(res); // release the keep-alive connection before retrying
        await this.backoff(attempt++);
        continue;
      }

      if (!res.ok) {
        // Read the error body defensively: if the body stream fails mid-read we still
        // throw a LexwareApiError carrying the real status (so e.g. a 404 stays a 404
        // and isNotFound() keeps working), just without the parsed detail.
        let body: unknown;
        try {
          body = await this.safeParse(res);
        } catch {
          body = undefined;
        }
        throw new LexwareApiError(res.status, describeErrorBody(res.status, res.statusText, body), body);
      }

      return res;
    }
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /** Discard an abandoned response body so undici can reuse the keep-alive socket. */
  private async drain(res: Response): Promise<void> {
    try {
      await res.body?.cancel();
    } catch {
      // Best-effort: a body already errored/closed is fine to ignore.
    }
  }

  /** Map a failure while reading a response body to a classified network error. */
  private bodyReadError(method: string, path: string, err: unknown): LexwareApiError {
    this.log(method, path, "body-read-error");
    return new LexwareApiError(
      0,
      `Network error reading Lexware response: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  /** Parse a response body as JSON when possible, otherwise return text/undefined. */
  private async safeParse(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return undefined;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  /** Wait per `Retry-After` if present (clamped), else jittered exponential backoff. */
  private retryAfterMs(res: Response, attempt: number): number {
    const header = res.headers.get("retry-after");
    if (header) {
      const trimmed = header.trim();
      let ms: number | undefined;
      if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
        ms = Number(trimmed) * 1000;
      } else {
        const date = Date.parse(trimmed);
        if (!Number.isNaN(date)) ms = date - this.now();
      }
      if (ms !== undefined) {
        // Clamp: never hammer (floor) and never hang for minutes/hours (ceiling).
        return Math.min(MAX_RETRY_WAIT_MS, Math.max(MIN_RETRY_WAIT_MS, ms));
      }
    }
    return this.backoffMs(attempt);
  }

  private backoff(attempt: number): Promise<void> {
    return this.sleep(this.backoffMs(attempt));
  }

  /** Exponential backoff with full jitter, capped at 8s. */
  private backoffMs(attempt: number): number {
    const base = Math.min(8000, 500 * 2 ** attempt);
    return Math.floor(base * (0.5 + this.random() * 0.5));
  }

  private log(method: string, path: string, status: string): void {
    if (this.debug) {
      // Path only — never query (may contain filters), never headers/body.
      console.error(`[lexware] ${method} ${path.split("?")[0]} -> ${status}`);
    }
  }
}
