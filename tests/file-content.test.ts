import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { READABLE_LIMITS, readableContent, type ReadableBlock } from "../src/tools/file-content.js";
import { fixturePdf, imageOnlyPdf, textPdf, TINY_PNG } from "./fixtures/pdf.js";

const texts = (blocks: ReadableBlock[]) => blocks.filter((b) => b.type === "text").map((b) => b.text);
const images = (blocks: ReadableBlock[]) => blocks.filter((b) => b.type === "image");

/** Width and height from a PNG's IHDR chunk. */
function pngSize(base64: string): { width: number; height: number } {
  const png = Buffer.from(base64, "base64");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("readableContent: PDF with a text layer", () => {
  it("returns the invoice's text, page by page, and no images", async () => {
    const { blocks, summary } = await readableContent(
      textPdf([
        ["Rechnung Nr. RE-2026-0042", "Rechnungsdatum 17.11.2026", "USt-IdNr. DE123456789"],
        ["Netto 100,00 EUR", "USt 19 % 19,00 EUR", "Brutto 119,00 EUR"],
      ]),
      "application/pdf",
    );
    expect(images(blocks)).toEqual([]);
    const [text] = texts(blocks);
    for (const field of ["RE-2026-0042", "17.11.2026", "DE123456789", "100,00", "19,00", "119,00"]) {
      expect(text).toContain(field);
    }
    expect(text).toContain("--- Page 1 of 2 ---");
    expect(text).toContain("--- Page 2 of 2 ---");
    expect(summary).toEqual({ kind: "text", pageCount: 2, textPages: [1, 2], renderedPages: [] });
  });

  it("sniffs a PDF served as application/octet-stream", async () => {
    const { summary } = await readableContent(textPdf([["Rechnung Nr. RE-2026-0042 vom 17.11.2026"]]), "application/octet-stream");
    expect(summary.kind).toBe("text");
  });

  it("truncates very long text with a note, and reads at most maxTextPages pages", async () => {
    const line = "Position 0001 Beratungsleistung November 2026 1.234,56 EUR netto";
    const pages = Array.from({ length: READABLE_LIMITS.maxTextPages + 5 }, () => Array.from({ length: 40 }, () => line));
    const { blocks, summary } = await readableContent(textPdf(pages), "application/pdf");
    const [text, ...notes] = texts(blocks);
    expect(text!.length).toBeLessThanOrEqual(READABLE_LIMITS.maxTextChars);
    expect(notes.join(" ")).toMatch(/Text truncated after 30000 characters/);
    expect(notes.join(" ")).toMatch(/Only part of the 35-page PDF/);
    expect(summary.truncated).toBe(true);
    expect(summary.textPages).toHaveLength(READABLE_LIMITS.maxTextPages);
  });
});

describe("readableContent: PDF without a text layer (scan)", () => {
  it("renders the page to a PNG image block, capped in size", async () => {
    const { blocks, summary } = await readableContent(imageOnlyPdf(), "application/pdf");
    const [image] = images(blocks);
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    const { width, height } = pngSize(image!.data);
    expect(Math.max(width, height)).toBeLessThanOrEqual(READABLE_LIMITS.maxImageSide);
    expect(Math.max(width, height)).toBeGreaterThan(READABLE_LIMITS.maxImageSide / 2); // legible, not a thumbnail
    expect(texts(blocks).join(" ")).toMatch(/Page 1 has little or no text layer/);
    expect(summary).toMatchObject({ kind: "image", pageCount: 1, textPages: [], renderedPages: [1] });
  });

  it("returns text for text pages and images for scanned pages of the same PDF", async () => {
    const { blocks, summary } = await readableContent(
      fixturePdf([["Rechnung Nr. RE-2026-0042", "Brutto 119,00 EUR"], "scan"]),
      "application/pdf",
    );
    expect(texts(blocks)[0]).toContain("RE-2026-0042");
    expect(images(blocks)).toHaveLength(1);
    expect(summary).toMatchObject({ kind: "text+image", textPages: [1], renderedPages: [2] });
  });

  it("renders at most maxRenderedPages pages", async () => {
    const pages = Array.from({ length: READABLE_LIMITS.maxRenderedPages + 2 }, () => "scan" as const);
    const { blocks, summary } = await readableContent(fixturePdf(pages), "application/pdf");
    expect(images(blocks)).toHaveLength(READABLE_LIMITS.maxRenderedPages);
    expect(summary.renderedPages).toEqual([1, 2, 3]);
    expect(summary.truncated).toBe(true);
  });
});

describe("readableContent: image attachments", () => {
  it("returns a PNG as-is", async () => {
    const { blocks, summary } = await readableContent(TINY_PNG, "image/png");
    expect(blocks).toEqual([{ type: "image", data: TINY_PNG.toString("base64"), mimeType: "image/png" }]);
    expect(summary).toEqual({ kind: "image" });
  });

  it("returns a JPEG as-is", async () => {
    const jpeg = await createCanvas(20, 10).encode("jpeg", 80);
    const { blocks } = await readableContent(jpeg, "image/jpeg");
    expect(blocks).toEqual([{ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" }]);
  });

  it("sniffs an image served as application/octet-stream", async () => {
    const { blocks } = await readableContent(TINY_PNG, "application/octet-stream");
    expect(blocks).toEqual([{ type: "image", data: TINY_PNG.toString("base64"), mimeType: "image/png" }]);
  });

  it("downscales an oversized image to a JPEG within the size cap", async () => {
    const big = createCanvas(3000, 2000);
    const ctx = big.getContext("2d");
    const pixels = ctx.createImageData(3000, 2000);
    // Opaque noise (xorshift32), which PNG cannot compress.
    let seed = 2463534242;
    for (let i = 0; i < pixels.data.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels.data[i] = i % 4 === 3 ? 255 : seed & 0xff;
    }
    ctx.putImageData(pixels, 0, 0);
    const png = await big.encode("png");
    expect(png.length).toBeGreaterThan(READABLE_LIMITS.maxImageBytes);

    const { blocks, summary } = await readableContent(png, "image/png");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(summary.note).toBe("Downscaled from 3000×2000 to 1600×1067.");
  });
});

describe("readableContent: other types", () => {
  it("returns XML as text, without extraction", async () => {
    const xml = "<?xml version='1.0'?><Invoice><ID>RE-1</ID></Invoice>";
    const { blocks, summary } = await readableContent(Buffer.from(xml), "application/xml; charset=utf-8");
    expect(blocks).toEqual([{ type: "text", text: xml }]);
    expect(summary).toEqual({ kind: "text", truncated: false });
  });

  it("returns nothing for a type it cannot read", async () => {
    const { blocks, summary } = await readableContent(Buffer.from("PK\x03\x04"), "application/zip");
    expect(blocks).toEqual([]);
    expect(summary.kind).toBe("none");
  });

  it("never throws on a broken PDF: it returns a note", async () => {
    const { blocks, summary } = await readableContent(Buffer.from("%PDF-1.7 truncated"), "application/pdf");
    expect(texts(blocks)[0]).toMatch(/^Could not read the file's content/);
    expect(summary.kind).toBe("none");
  });
});
