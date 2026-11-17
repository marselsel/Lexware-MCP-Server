import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pdfImageSizes,
  READABLE_LIMITS,
  readableContent,
  renderScale,
  renderSlots,
  type ReadableBlock,
} from "../src/tools/file-content.js";
import { BudgetExceeded, Deadline, runWithin, Semaphore, settleWithin } from "../src/tools/render-budget.js";
import { fixturePdf } from "./fixtures/pdf.js";

// Count page renders without changing them, and on demand make one that never settles (what a
// pdf.js render can do once its document is destroyed under it), or an image decode that is
// slow. In its own file: the mocks replace "unpdf" and the canvas for every test here.
const renders = vi.hoisted(() => [] as { page: number; options: Record<string, unknown> }[]);
const faults = vi.hoisted(() => ({
  hangRender: false,
  slowDecodeMs: 0,
  failRenderPage: 0,
  failTextPage: 0,
}));
vi.mock("unpdf", async (importOriginal) => {
  const unpdf = await importOriginal<typeof import("unpdf")>();
  return {
    ...unpdf,
    renderPageAsImage: (pdf: never, page: number, options: Record<string, unknown>) => {
      renders.push({ page, options });
      if (faults.hangRender) return new Promise(() => {});
      if (faults.failRenderPage === page) return Promise.reject(new Error("render failed"));
      return unpdf.renderPageAsImage(pdf, page, options as never);
    },
    getDocumentProxy: async (...args: Parameters<typeof unpdf.getDocumentProxy>) => {
      const pdf = await unpdf.getDocumentProxy(...args);
      const getPage = pdf.getPage.bind(pdf);
      pdf.getPage = async (n: number) => {
        const page = await getPage(n);
        if (n === faults.failTextPage) page.getTextContent = () => Promise.reject(new Error("bad text stream"));
        return page;
      };
      return pdf;
    },
  };
});
vi.mock("@napi-rs/canvas", async (importOriginal) => {
  const canvas = await importOriginal<typeof import("@napi-rs/canvas")>();
  return {
    ...canvas,
    loadImage: async (...args: Parameters<typeof canvas.loadImage>) => {
      if (faults.slowDecodeMs) await new Promise((r) => setTimeout(r, faults.slowDecodeMs));
      return canvas.loadImage(...args);
    },
  };
});

const canvas = await import("@napi-rs/canvas").catch(() => undefined);
const texts = (blocks: ReadableBlock[]) => blocks.filter((b) => b.type === "text").map((b) => b.text);
const images = (blocks: ReadableBlock[]) => blocks.filter((b) => b.type === "image");

/** A heavy file: page 1 a born-digital invoice page, page 2 a scan with a 2000×1000 image. */
const INVOICE_PAGE = [
  "Rechnung Nr. RE-2026-0042 vom 17.11.2026",
  "Leistungszeitraum Oktober 2026, Kundennummer 10042",
  "Pos. 1 Beratung 8 Std. a 100,00 EUR = 800,00 EUR",
  "Pos. 2 Reisekosten pauschal = 100,00 EUR",
  "Nettobetrag 900,00 EUR, USt 19 % 171,00 EUR",
  "Bruttobetrag 1.071,00 EUR, zahlbar bis 01.12.2026",
];
const heavyPdf = () => fixturePdf([INVOICE_PAGE, { image: true, imageKind: "heavy" }]);

afterEach(() => {
  renders.length = 0;
  faults.hangRender = false;
  faults.slowDecodeMs = 0;
  faults.failRenderPage = 0;
  faults.failTextPage = 0;
  vi.restoreAllMocks();
});

/** Resolves once no render slot is taken, or rejects after `ms`. */
async function slotsFree(ms: number): Promise<void> {
  const end = performance.now() + ms;
  while (renderSlots.running > 0) {
    if (performance.now() > end) throw new Error(`render slot still taken after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Semaphore", () => {
  it("runs at most `limit` tasks at once, in arrival order", async () => {
    const slots = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        slots.run(async () => {
          active++;
          peak = Math.max(peak, active);
          order.push(i);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(slots.running).toBe(0);
  });

  it("gives up waiting at the deadline, and the slot stays usable", async () => {
    const slots = new Semaphore(1);
    let release!: () => void;
    const holder = slots.run(() => new Promise<void>((r) => (release = r)));
    await expect(slots.run(async () => "never", new Deadline(20))).rejects.toEqual(new BudgetExceeded("busy"));
    release();
    await holder;
    await expect(slots.run(async () => "next")).resolves.toBe("next");
  });
});

describe("Deadline.race", () => {
  it("rejects with BudgetExceeded once the time is up", async () => {
    await expect(new Deadline(10).race(new Promise(() => {}))).rejects.toBeInstanceOf(BudgetExceeded);
    await expect(new Deadline(0).race(Promise.resolve(1))).rejects.toBeInstanceOf(BudgetExceeded);
    await expect(new Deadline(1000).race(Promise.resolve(1))).resolves.toBe(1);
  });
});

describe("runWithin", () => {
  const later = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

  it("returns the work's result, and frees the slot", async () => {
    const slots = new Semaphore(1);
    await expect(runWithin(() => later(5, "done"), { deadline: new Deadline(1000), graceMs: 100, slots })).resolves.toBe(
      "done",
    );
    expect(slots.running).toBe(0);
  });

  it("answers at the deadline, cancels, and keeps the slot until the work has stopped", async () => {
    const slots = new Semaphore(1);
    const cancel = vi.fn();
    const started = performance.now();
    await expect(
      runWithin(() => later(150, "late"), { deadline: new Deadline(20), graceMs: 1000, slots, cancel }),
    ).rejects.toEqual(new BudgetExceeded("time"));
    expect(performance.now() - started).toBeLessThan(120);
    expect(cancel).toHaveBeenCalledOnce();
    expect(slots.running).toBe(1); // the work is still running: it still counts
    await slotsFreeOf(slots, 500);
  });

  it("frees the slot after the grace period when the work never settles", async () => {
    const slots = new Semaphore(1);
    await expect(
      runWithin(() => new Promise(() => {}), { deadline: new Deadline(10), graceMs: 50, slots }),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    await slotsFreeOf(slots, 500);
    await expect(runWithin(async () => "next", { deadline: new Deadline(100), graceMs: 50, slots })).resolves.toBe("next");
  });

  it("does not start work once the deadline has passed, even with a slot free", async () => {
    const slots = new Semaphore(1);
    const work = vi.fn(async () => "decoded");
    await expect(runWithin(work, { deadline: new Deadline(0), graceMs: 50, slots })).rejects.toEqual(
      new BudgetExceeded("time"),
    );
    expect(work).not.toHaveBeenCalled();
    expect(slots.running).toBe(0);
  });

  it("frees the slot when the work fails", async () => {
    const slots = new Semaphore(1);
    await expect(
      runWithin(async () => Promise.reject(new Error("boom")), { deadline: new Deadline(100), graceMs: 50, slots }),
    ).rejects.toThrow("boom");
    expect(slots.running).toBe(0);
  });

  it("does not wait on a cancel that hangs", async () => {
    const slots = new Semaphore(1);
    await expect(
      runWithin(() => new Promise(() => {}), {
        deadline: new Deadline(10),
        graceMs: 50,
        slots,
        cancel: () => new Promise(() => {}),
      }),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    await slotsFreeOf(slots, 500);
  });

  it("settleWithin never rejects and never waits longer than asked", async () => {
    await expect(settleWithin(Promise.reject(new Error("x")), 1000)).resolves.toBeUndefined();
    const started = performance.now();
    await settleWithin(new Promise(() => {}), 30);
    expect(performance.now() - started).toBeLessThan(500);
  });

  async function slotsFreeOf(slots: Semaphore, ms: number) {
    const end = performance.now() + ms;
    while (slots.running > 0) {
      if (performance.now() > end) throw new Error("slot still taken");
      await new Promise((r) => setTimeout(r, 5));
    }
  }
});

describe("render size", () => {
  it("fits a page into the pixel budget, the long-side cap and 300 dpi", () => {
    const a4 = renderScale(595, 842);
    expect(Math.floor(595 * a4) * Math.floor(842 * a4)).toBeLessThanOrEqual(READABLE_LIMITS.maxImagePixels);
    const receipt = renderScale(227, 2268); // 80 mm × 800 mm
    expect(2268 * receipt).toBeLessThanOrEqual(READABLE_LIMITS.maxImageSide);
    expect(renderScale(100, 100)).toBeCloseTo(300 / 72); // a stamp-sized page is not blown up
  });
});

describe("pdfImageSizes", () => {
  const imageObject = (n: number, dict: string) => `${n} 0 obj\n<< /Type /XObject /Subtype /Image ${dict} >>\nstream\nxx\nendstream\nendobj\n`;

  it("reads the largest image's size from the raw file", () => {
    expect(pdfImageSizes(heavyPdf())).toEqual({ largest: { width: 2000, height: 1000 }, unknown: false });
    expect(pdfImageSizes(fixturePdf([["text only"]]))).toEqual({ unknown: false });
  });

  it("reports a size given as an indirect reference as unknown, not as its first digit", () => {
    const pdf = Buffer.from(`%PDF-1.4\n${imageObject(4, "/Width 12 0 R /Height 7 0 R")}`, "latin1");
    expect(pdfImageSizes(pdf)).toEqual({ unknown: true });
  });

  it("keeps an unknown size on record next to a known small one", () => {
    const pdf = Buffer.from(
      `%PDF-1.4\n${imageObject(4, "/Width 12 0 R /Height 13 0 R")}${imageObject(5, "/Width 120 /Height 40")}`,
      "latin1",
    );
    expect(pdfImageSizes(pdf)).toEqual({ largest: { width: 120, height: 40 }, unknown: true });
  });
});

describe.skipIf(!canvas)("rendering cost", () => {
  it("renders each page once, with the format and scale chosen up front", async () => {
    const { blocks, summary } = await readableContent(heavyPdf(), "application/pdf");
    expect(renders).toEqual([{ page: 2, options: expect.objectContaining({ format: "jpeg", scale: renderScale(595, 842) }) }]);
    expect(images(blocks)).toEqual([expect.objectContaining({ mimeType: "image/jpeg" })]);
    expect(summary.renderedPages).toEqual([2]);
  });

  it("renders a heavy file's pages one at a time across concurrent calls", async () => {
    let active = 0;
    let peak = 0;
    const run = renderSlots.run.bind(renderSlots);
    vi.spyOn(renderSlots, "run").mockImplementation((task, deadline) =>
      run(async () => {
        active++;
        peak = Math.max(peak, active);
        try {
          return await task();
        } finally {
          active--;
        }
      }, deadline),
    );
    const results = await Promise.all(Array.from({ length: 4 }, () => readableContent(heavyPdf(), "application/pdf")));
    expect(peak).toBe(READABLE_LIMITS.maxConcurrentRenders);
    for (const { summary } of results) expect(summary.renderedPages).toEqual([2]);
  });

  it("keeps the text but makes no page image when no render slot frees up in time", async () => {
    let release!: () => void;
    const holder = renderSlots.run(() => new Promise<void>((r) => (release = r)));
    try {
      const { blocks, summary } = await readableContent(heavyPdf(), "application/pdf", { timeBudgetMs: 100 });
      expect(texts(blocks)[0]).toContain("RE-2026-0042");
      expect(images(blocks)).toEqual([]);
      expect(summary.note).toMatch(
        /Page 2 is not attached as an image although it needs one \(the server was busy rendering other files/,
      );
      expect(summary).toMatchObject({ truncated: true, missingPageImages: [2] });
    } finally {
      release();
      await holder;
    }
  });

  it("keeps the other pages when one page fails to render", async () => {
    faults.failRenderPage = 2;
    const { blocks, summary } = await readableContent(
      fixturePdf([INVOICE_PAGE, { image: true, imageKind: "heavy" }, "scan"]),
      "application/pdf",
    );
    expect(texts(blocks)[0]).toContain("RE-2026-0042");
    expect(images(blocks)).toHaveLength(1);
    expect(summary).toMatchObject({ kind: "text+image", textPages: [1], renderedPages: [3], missingPageImages: [2] });
    expect(summary.note).toMatch(/Page 2 could not be rendered \(render failed\)\./);
  });

  it("keeps the other pages when one page's text cannot be read", async () => {
    faults.failTextPage = 1;
    const { blocks, summary } = await readableContent(fixturePdf([["unreadable page"], INVOICE_PAGE]), "application/pdf");
    expect(texts(blocks)[0]).toContain("RE-2026-0042");
    expect(summary).toMatchObject({ kind: "text", textPages: [2], missingPageImages: [1] });
    expect(summary.note).toMatch(/Page 1 could not be read \(bad text stream\)\./);
  });

  it("reports pages it had no time to read at all as missing", async () => {
    const { blocks, summary } = await readableContent(heavyPdf(), "application/pdf", { timeBudgetMs: 0 });
    expect(images(blocks)).toEqual([]);
    expect(summary).toMatchObject({ kind: "none", missingPageImages: [1, 2], truncated: true });
    expect(summary.note).toBe("Pages 1–2 could not be read in time.");
  });

  it("flags a stamped scan that got no image because the server was busy", async () => {
    let release!: () => void;
    const holder = renderSlots.run(() => new Promise<void>((r) => (release = r)));
    try {
      const data = fixturePdf([{ image: true, imageKind: "heavy", lines: ["Scanned with CamScanner"] }]);
      const { summary } = await readableContent(data, "application/pdf", { timeBudgetMs: 100 });
      // binaryResult attaches the raw file for any missingPageImages (tests/binary-result-incomplete.test.ts).
      expect(summary).toMatchObject({ kind: "text", renderedPages: [], missingPageImages: [1], truncated: true });
      expect(summary.note).toMatch(
        /Page 1 is not attached as an image although it needs one \(the server was busy .*\); page 1 has little text in a file with images and is assumed to be scanned/,
      );
    } finally {
      release();
      await holder;
    }
  });

  it("does not count a page whose image is over the decode limit as rendered", async () => {
    const pagesWithOversized = [
      { image: true, imageKind: "oversized" },
      { image: true, imageKind: "oversized", lines: ["Scanned with CamScanner"] },
      // A small logo pdf.js does keep must not make the page count as rendered.
      { image: true, imageKind: "oversized", logo: [450, 760, 100, 50] },
    ] as const;
    for (const page of pagesWithOversized) {
      const { summary } = await readableContent(fixturePdf([INVOICE_PAGE, page]), "application/pdf");
      expect(summary).toMatchObject({ textPages: [1, ...("lines" in page ? [2] : [])], renderedPages: [], missingPageImages: [2] });
      expect(summary.note).toMatch(
        /an image of 9000×6000 px, more than this server decodes \(50 MP\): page 2 has no page image here/,
      );
    }
  });

  it("returns at the deadline when a heavy render never settles, and frees the slot after the grace period", async () => {
    faults.hangRender = true;
    const started = performance.now();
    const { blocks, summary } = await readableContent(heavyPdf(), "application/pdf", {
      timeBudgetMs: 300,
      cancelGraceMs: 200,
    });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(texts(blocks)[0]).toContain("RE-2026-0042");
    expect(summary).toMatchObject({ renderedPages: [], missingPageImages: [2] });
    expect(summary.note).toMatch(/\(rendering ran out of time \(0\.3 s per call\)\)/);
    await slotsFree(2000);
    // The instance is not stuck: the next heavy scan renders normally.
    faults.hangRender = false;
    const next = await readableContent(heavyPdf(), "application/pdf");
    expect(next.summary.renderedPages).toEqual([2]);
  });

  it("returns at the deadline when a light render never settles", async () => {
    faults.hangRender = true;
    const started = performance.now();
    const { summary } = await readableContent(fixturePdf(["scan"]), "application/pdf", {
      timeBudgetMs: 300,
      cancelGraceMs: 200,
    });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(summary).toMatchObject({ renderedPages: [], missingPageImages: [1] });
  });

  it("keeps a large image's slot until its decode has finished, even after the call gave up", async () => {
    const big = canvas!.createCanvas(2550, 3300);
    big.getContext("2d").fillRect(100, 100, 200, 200);
    const png = await big.encode("png");
    faults.slowDecodeMs = 400;
    const { summary } = await readableContent(png, "image/png", { timeBudgetMs: 50 });
    expect(summary.kind).toBe("none");
    expect(summary.note).toMatch(/could not be downscaled in time/);
    expect(renderSlots.running).toBe(1); // the decode is still running, and still counted
    await slotsFree(3000);
  });


});
