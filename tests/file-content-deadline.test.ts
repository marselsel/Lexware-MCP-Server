import { describe, expect, it, vi } from "vitest";

// The response time after a timeout, with the default 15 s grace period: the call answers at
// its deadline, and the teardown and the slot release go on in the background. In its own file
// because the render it starts never settles and keeps this module's render slot for 15 s.
// A render that never settles, and a teardown that waits on it — as pdf.js' destroy() does for a
// render task that is stuck.
vi.mock("unpdf", async (importOriginal) => {
  const unpdf = await importOriginal<typeof import("unpdf")>();
  return {
    ...unpdf,
    renderPageAsImage: () => new Promise(() => {}),
    getDocumentProxy: async (...args: Parameters<typeof unpdf.getDocumentProxy>) => {
      const pdf = await unpdf.getDocumentProxy(...args);
      pdf.loadingTask.destroy = () => new Promise(() => {});
      return pdf;
    },
  };
});

const canvas = await import("@napi-rs/canvas").catch(() => undefined);
const { readableContent, READABLE_LIMITS, renderSlots } = await import("../src/tools/file-content.js");
const { fixturePdf } = await import("./fixtures/pdf.js");

describe.skipIf(!canvas)("after a timeout", () => {
  it("answers at the deadline, not after the grace period, and keeps the slot while the render is stuck", async () => {
    expect(READABLE_LIMITS.cancelGraceMs).toBeGreaterThanOrEqual(10_000);
    const started = performance.now();
    const { summary } = await readableContent(fixturePdf([{ image: true, imageKind: "heavy" }]), "application/pdf", {
      timeBudgetMs: 300,
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(summary).toMatchObject({ renderedPages: [], missingPageImages: [1] });
    expect(renderSlots.running).toBe(1); // released in the background, at most cancelGraceMs later
  });
});
