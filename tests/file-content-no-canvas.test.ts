import { describe, expect, it, vi } from "vitest";

// A platform without a prebuilt @napi-rs/canvas binary: the optional dependency fails to load.
// In its own file, because the mock replaces the module for every test here.
vi.mock("@napi-rs/canvas", () => {
  throw new Error("Cannot find module '@napi-rs/canvas-linux-x64-gnu'");
});

const { checkPageImages, readableContent } = await import("../src/tools/file-content.js");
const { fixturePdf, TINY_PNG } = await import("./fixtures/pdf.js");
const { binaryResult } = await import("../src/tools/shared.js");

describe("without @napi-rs/canvas", () => {
  it("warns once, clearly, and reports that page images are unavailable", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkPageImages()).toBe(false);
    expect(await checkPageImages()).toBe(false);
    await readableContent(fixturePdf(["scan"]), "application/pdf");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[lexware-mcp\] WARNING: @napi-rs\/canvas could not be loaded/);
    log.mockRestore();
  });

  it("still returns the text, and a note instead of the page image", async () => {
    const { blocks, summary } = await readableContent(
      fixturePdf([["Rechnung Nr. RE-2026-0042", "Brutto 119,00 EUR"], "scan"]),
      "application/pdf",
    );
    expect(blocks.filter((b) => b.type === "image")).toEqual([]);
    expect(summary).toMatchObject({ kind: "text", textPages: [1], renderedPages: [], missingPageImages: [2] });
    expect(summary.note).toMatch(/Page images are unavailable on this server/);
  });

  it('keeps the raw file even with output="readable", since the scan is only in there', async () => {
    const data = fixturePdf([{ image: true, lines: ["Scanned with CamScanner"] }]);
    const res = await binaryResult({
      uri: "lexware://files/f1",
      data,
      contentType: "application/pdf",
      structuredContent: {},
      message: "Downloaded.",
      output: "readable",
    });
    expect(res.content.at(-1)).toMatchObject({ type: "resource", resource: { blob: data.toString("base64") } });
  });

  it("passes a small image through, since nothing needs decoding", async () => {
    const { blocks } = await readableContent(TINY_PNG, "image/png");
    expect(blocks).toEqual([{ type: "image", data: TINY_PNG.toString("base64"), mimeType: "image/png" }]);
  });
});
