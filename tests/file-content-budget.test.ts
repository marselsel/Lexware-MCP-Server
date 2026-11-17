import { afterEach, describe, expect, it, vi } from "vitest";
import {
  largestPdfImage,
  READABLE_LIMITS,
  readableContent,
  renderScale,
  renderSlots,
  type ReadableBlock,
} from "../src/tools/file-content.js";
import { BudgetExceeded, Deadline, Semaphore } from "../src/tools/render-budget.js";
import { fixturePdf } from "./fixtures/pdf.js";

// Count page renders without changing them. In its own file: the mock replaces "unpdf" for
// every test here.
const renders = vi.hoisted(() => [] as { page: number; options: Record<string, unknown> }[]);
vi.mock("unpdf", async (importOriginal) => {
  const unpdf = await importOriginal<typeof import("unpdf")>();
  return {
    ...unpdf,
    renderPageAsImage: (pdf: never, page: number, options: Record<string, unknown>) => {
      renders.push({ page, options });
      return unpdf.renderPageAsImage(pdf, page, options as never);
    },
  };
});

const canvas = await import("@napi-rs/canvas").catch(() => undefined);
const texts = (blocks: ReadableBlock[]) => blocks.filter((b) => b.type === "text").map((b) => b.text);
const images = (blocks: ReadableBlock[]) => blocks.filter((b) => b.type === "image");

/** A heavy file: page 1 born-digital text, page 2 a scan with a 2000×1000 image. */
const heavyPdf = () =>
  fixturePdf([["Rechnung Nr. RE-2026-0042", "Brutto 119,00 EUR"], { image: true, imageKind: "heavy" }]);

afterEach(() => {
  renders.length = 0;
  vi.restoreAllMocks();
});

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

describe("render size", () => {
  it("fits a page into the pixel budget, the long-side cap and 300 dpi", () => {
    const a4 = renderScale(595, 842);
    expect(Math.floor(595 * a4) * Math.floor(842 * a4)).toBeLessThanOrEqual(READABLE_LIMITS.maxImagePixels);
    const receipt = renderScale(227, 2268); // 80 mm × 800 mm
    expect(2268 * receipt).toBeLessThanOrEqual(READABLE_LIMITS.maxImageSide);
    expect(renderScale(100, 100)).toBeCloseTo(300 / 72); // a stamp-sized page is not blown up
  });
});

describe("largestPdfImage", () => {
  it("reads the largest image's size from the raw file", () => {
    expect(largestPdfImage(heavyPdf())).toEqual({ width: 2000, height: 1000 });
    expect(largestPdfImage(fixturePdf([["text only"]]))).toBeUndefined();
  });

  it("reports an image whose size is an indirect reference as unknown", () => {
    const pdf = Buffer.from("%PDF-1.4\n4 0 obj\n<< /Type /XObject /Subtype /Image /Width 7 0 R /Height 7 0 R >>\nstream\n");
    expect(largestPdfImage(pdf)).toBe("unknown");
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
      expect(summary.note).toMatch(/The server was busy rendering other files .*: page 2 is not attached as an image/);
      expect(summary.truncated).toBe(true);
    } finally {
      release();
      await holder;
    }
  });

  it("stops making page images when the time budget runs out", async () => {
    const { blocks, summary } = await readableContent(heavyPdf(), "application/pdf", { timeBudgetMs: 0 });
    expect(texts(blocks)[0]).toContain("RE-2026-0042");
    expect(images(blocks)).toEqual([]);
    expect(summary.note).toMatch(/Rendering ran out of time .*: page 2 is not attached as an image/);
  });

  it("says so when an image is over the decode limit", async () => {
    const { summary } = await readableContent(fixturePdf([{ image: true, imageKind: "oversized" }]), "application/pdf");
    expect(summary.note).toMatch(/an image of 9000×6000 px, more than this server decodes \(50 MP\)/);
  });
});
