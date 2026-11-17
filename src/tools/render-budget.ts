/**
 * Limits on the expensive part of a download: decoding and rendering page images. pdf.js runs
 * in-process (no worker thread on Node), so a large scan decodes and draws on the event loop
 * and holds its full-resolution pixels while it does. Two guards keep one big file from
 * starving the server or running it out of memory:
 *
 *   - a semaphore: at most N pages are decoded/rendered at once across all calls, which bounds
 *     peak memory to roughly N decoded page images
 *   - a deadline per call: a call that runs out of time stops making page images and says so,
 *     instead of holding the tool call open
 */

/** The time budget or a wait for a render slot ran out. */
export class BudgetExceeded extends Error {
  constructor(readonly reason: "time" | "busy") {
    super(reason === "busy" ? "No render slot became free in time." : "The time budget ran out.");
    this.name = "BudgetExceeded";
  }
}

/** A point in time a call has to finish by. */
export class Deadline {
  private readonly at: number;

  constructor(readonly budgetMs: number) {
    this.at = performance.now() + budgetMs;
  }

  /** Milliseconds left, never negative. */
  remaining(): number {
    return Math.max(0, this.at - performance.now());
  }

  get expired(): boolean {
    return this.remaining() <= 0;
  }

  /**
   * `work`, or a BudgetExceeded rejection once the deadline passes. The work itself is not
   * stopped (a caller that can cancel it should); its later result or error is swallowed.
   */
  race<T>(work: Promise<T>): Promise<T> {
    const ms = this.remaining();
    if (ms <= 0) {
      work.catch(() => {});
      return Promise.reject(new BudgetExceeded("time"));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BudgetExceeded("time")), ms);
      timer.unref?.();
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }
}

/** A counting semaphore with a FIFO queue. */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(readonly limit: number) {}

  /** Tasks running right now. */
  get running(): number {
    return this.active;
  }

  /**
   * Run `task` once a slot is free. With a deadline, give up waiting when it passes
   * (BudgetExceeded "busy"); a task that already started is not interrupted.
   */
  async run<T>(task: () => Promise<T>, deadline?: Deadline): Promise<T> {
    await this.acquire(deadline);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(deadline?: Deadline): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grant = () => {
        clearTimeout(timer);
        this.active++;
        resolve();
      };
      this.queue.push(grant);
      if (deadline) {
        timer = setTimeout(() => {
          const i = this.queue.indexOf(grant);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new BudgetExceeded("busy"));
        }, deadline.remaining());
        timer.unref?.();
      }
    });
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}
