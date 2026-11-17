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

/** Resolves once `work` settles or `ms` pass, whichever comes first. Never rejects. */
export function settleWithin(work: PromiseLike<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    Promise.resolve(work).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/**
 * Run `work` within `deadline`, holding a slot of `slots` while it runs (if given).
 *
 * The returned promise settles with the work's result, or rejects with BudgetExceeded as soon
 * as the deadline passes ("time") or no slot frees up before it ("busy"): the caller never
 * waits on work it has given up on. On a timeout `cancel` is called, and the slot stays taken
 * until the work has really settled — but at most `graceMs` longer. A cancelled pdf.js render
 * that is still decoding keeps counting against the memory bound; one that never settles (its
 * document was destroyed before the render started) cannot keep the slot for good. The slot is
 * released by Semaphore.run's finally on every path.
 */
export function runWithin<T>(
  work: () => Promise<T>,
  opts: { deadline: Deadline; graceMs: number; slots?: Semaphore; cancel?: () => unknown },
): Promise<T> {
  const { deadline, graceMs, slots, cancel } = opts;
  return new Promise<T>((resolve, reject) => {
    let answered = false;
    const answer = (settle: () => void) => {
      if (!answered) {
        answered = true;
        settle();
      }
    };
    const task = async () => {
      // A slot that frees up after the deadline must not start a decode nobody will wait for.
      if (deadline.expired) {
        answer(() => reject(new BudgetExceeded("time")));
        return;
      }
      const running = work();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((done) => {
        timer = setTimeout(() => done("timeout"), deadline.remaining());
        timer.unref?.();
      });
      const outcome = await Promise.race([
        running.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
        timedOut,
      ]);
      clearTimeout(timer);
      if (outcome !== "timeout") {
        answer(() => ("error" in outcome ? reject(outcome.error) : resolve(outcome.value)));
        return;
      }
      answer(() => reject(new BudgetExceeded("time")));
      const cancelling = (async () => cancel?.())();
      await settleWithin(Promise.allSettled([cancelling, running]), graceMs);
    };
    (slots ? slots.run(task, deadline) : task()).catch((err: unknown) => answer(() => reject(err)));
  });
}
