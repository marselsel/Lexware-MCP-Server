import { describe, expect, it } from "vitest";
import {
  configureFileRendering,
  imageDimensions,
  READABLE_LIMITS,
  readableContent,
  type ReadableBlock,
} from "../src/tools/file-content.js";
import { binaryResult, withJsonText } from "../src/tools/shared.js";
import { fixturePdf, imageOnlyPdf, pngHeader, textPdf, TINY_JPEG, TINY_PNG } from "./fixtures/pdf.js";

// @napi-rs/canvas is an optional dependency: without it, the tests that need page images or a
// downscaled image are skipped rather than failing (tests/file-content-no-canvas.test.ts covers
// that case).
const canvas = await import("@napi-rs/canvas").catch(() => undefined);
const withCanvas = it.skipIf(!canvas);

const texts = (blocks: ReadableBlock[]) => blocks.filter((b) => b.type === "text").map((b) => b.text);
const images = (blocks: ReadableBlock[]) => blocks.filter((b) => b.type === "image");

/** Width and height of a PNG (its IHDR chunk) or a JPEG (its SOF segment). */
function imageSize(base64: string): { width: number; height: number } {
  const b = Buffer.from(base64, "base64");
  if (b[0] === 0x89) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  for (let i = 2; i < b.length; i += 2 + b.readUInt16BE(i + 2)) {
    const marker = b[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    }
  }
  throw new Error("not a PNG or JPEG");
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

  it("truncates very long text, reporting the last complete page, and reads at most maxTextPages pages", async () => {
    // 40 lines of 65 characters: about 2,650 characters a page, so the cut falls in page 12.
    const line = "Position 0001 Beratungsleistung November 2026 1.234,56 EUR netto";
    const pages = Array.from({ length: READABLE_LIMITS.maxTextPages + 5 }, () => Array.from({ length: 40 }, () => line));
    const { blocks, summary } = await readableContent(textPdf(pages), "application/pdf");
    const [text, ...notes] = texts(blocks);
    expect(text!.length).toBe(READABLE_LIMITS.maxTextChars);
    expect(text).toContain("--- Page 12 of 35 ---");
    expect(text).not.toContain("--- Page 13 of 35 ---");
    expect(notes[0]).toBe(
      '[Text truncated after 30000 characters: pages 1–11 complete, page 12 cut off, pages 13–30 not shown. ' +
        'The full file is available with output="resource".]',
    );
    expect(notes.join(" ")).toMatch(/Only pages 1–30 of the 35-page PDF are read/);
    expect(summary).toMatchObject({ truncated: true, textPages: Array.from({ length: 11 }, (_, i) => i + 1), partialTextPage: 12 });
  });
});

describe.skipIf(!canvas)("readableContent: PDF without a text layer (scan)", () => {
  it("renders the page to a JPEG within the pixel budget", async () => {
    const { blocks, summary } = await readableContent(imageOnlyPdf(), "application/pdf");
    const [image] = images(blocks);
    expect(image).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    const { width, height } = imageSize(image!.data);
    expect(width * height).toBeLessThanOrEqual(READABLE_LIMITS.maxImagePixels);
    expect(width * height).toBeGreaterThan(READABLE_LIMITS.maxImagePixels * 0.95); // uses the budget
    expect(width).toBeGreaterThan(1250); // A4 at ~160 dpi: legible, not a thumbnail
    expect(texts(blocks).join(" ")).toMatch(/Page 1 has little or no visible text/);
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

  it("renders a scan that carries a short line of text, such as a scanner app's stamp", async () => {
    const { blocks, summary } = await readableContent(
      fixturePdf([{ image: true, lines: ["Scanned with CamScanner"] }]),
      "application/pdf",
    );
    expect(images(blocks)).toHaveLength(1);
    // The stamp is still returned, but marked: the content is in the image.
    expect(texts(blocks)[0]).toContain("--- Page 1 of 1 (page image attached) ---\nScanned with CamScanner");
    expect(texts(blocks).join(" ")).toMatch(/Page 1 is mostly an image with only a little text/);
    expect(summary).toMatchObject({ kind: "text+image", textPages: [1], renderedPages: [1] });
  });

  it("renders a photo that covers only part of the page, next to an inbox stamp", async () => {
    const { blocks, summary } = await readableContent(
      fixturePdf([{ image: [100, 200, 300, 450], lines: ["Eingegangen 17.11.2026", "Buchhaltung"] }]),
      "application/pdf",
    );
    expect(images(blocks)).toHaveLength(1);
    expect(summary.renderedPages).toEqual([1]);
  });

  it("renders a scan whose text layer is invisible OCR, and keeps the OCR text", async () => {
    const ocr = Array.from({ length: 12 }, (_, i) => `Position ${i + 1} Bueromaterial 12,50 EUR`);
    const { blocks, summary } = await readableContent(
      fixturePdf([{ image: true, lines: ocr, invisible: true }]),
      "application/pdf",
    );
    expect(images(blocks)).toHaveLength(1);
    expect(texts(blocks)[0]).toContain("invisible OCR text layer, may contain recognition errors; page image attached");
    expect(texts(blocks)[0]).toContain("Position 12 Bueromaterial 12,50 EUR");
    expect(summary).toMatchObject({ kind: "text+image", renderedPages: [1] });
  });

  it("does not render a born-digital page with little text and a small logo", async () => {
    const { blocks, summary } = await readableContent(
      fixturePdf([{ image: [450, 760, 100, 50], lines: ["Seite 2 von 2", "Vielen Dank fuer Ihren Auftrag."] }]),
      "application/pdf",
    );
    expect(images(blocks)).toEqual([]);
    expect(summary).toMatchObject({ kind: "text", renderedPages: [] });
  });

  it("keeps an A4-ish page in one image, within the pixel budget", async () => {
    // 80 mm × 280 mm (1:3.5): below tallAspect, one image.
    const { blocks } = await readableContent(fixturePdf([{ image: true, size: [227, 794] }]), "application/pdf");
    expect(images(blocks)).toHaveLength(1);
    const { width, height } = imageSize(images(blocks)[0]!.data);
    expect(width * height).toBeLessThanOrEqual(READABLE_LIMITS.maxImagePixels);
    expect(height).toBeLessThanOrEqual(READABLE_LIMITS.maxImageSide);
  });

  it("splits a very tall till receipt into two overlapping halves, each within the budget", async () => {
    // 80 mm × 640 mm (1:8). As one image it would be held to 2576 px tall, i.e. 322 px wide.
    const { blocks, summary } = await readableContent(fixturePdf([{ image: true, size: [227, 1814] }]), "application/pdf");
    const tiles = images(blocks);
    expect(tiles).toHaveLength(2);
    const [top, bottom] = tiles.map((t) => imageSize(t.data));
    for (const tile of [top!, bottom!]) {
      expect(tile.width * tile.height).toBeLessThanOrEqual(READABLE_LIMITS.maxImagePixels);
      expect(tile.height).toBeLessThanOrEqual(READABLE_LIMITS.maxImageSide);
      expect(tile.width).toBeGreaterThanOrEqual(600);
    }
    expect(top!.height).toBe(bottom!.height);
    expect(summary).toMatchObject({ renderedPages: [1] });
    expect(summary.note).toMatch(/Page 1 is very tall \(e\.g\. a till receipt\) and is attached as two overlapping images/);
  });

  it("renders a page without text as PNG when the PDF holds no image (vector drawing)", async () => {
    const { blocks } = await readableContent(fixturePdf([[]]), "application/pdf");
    expect(images(blocks)).toEqual([expect.objectContaining({ mimeType: "image/png" })]);
  });

  it("flags the stamped scan pages past the page-image cap as missing, and keeps the raw file", async () => {
    // A 5-page scan from a scanner app: every page an image with the app's stamp line.
    const data = fixturePdf(Array.from({ length: 5 }, () => ({ image: true as const, lines: ["Scanned with CamScanner"] })));
    const { summary } = await readableContent(data, "application/pdf");
    expect(summary).toMatchObject({ renderedPages: [1, 2, 3], missingPageImages: [4, 5], truncated: true });
    expect(summary.note).toMatch(
      /Pages 4–5 are not attached as an image although they need one \(at most 3 page images per call\); pages 4–5 have little text in a file with images and are assumed to be scanned/,
    );
    const res = await binaryResult({
      uri: "lexware://files/f1",
      data,
      contentType: "application/pdf",
      structuredContent: {},
      message: "Downloaded.",
      output: "readable",
    });
    expect(res.content.at(-1)).toMatchObject({ type: "resource" });
  });

  it("renders at most maxRenderedPages pages", async () => {
    const pages = Array.from({ length: READABLE_LIMITS.maxRenderedPages + 2 }, () => "scan" as const);
    const { blocks, summary } = await readableContent(fixturePdf(pages), "application/pdf");
    expect(images(blocks)).toHaveLength(READABLE_LIMITS.maxRenderedPages);
    expect(summary.renderedPages).toEqual([1, 2, 3]);
    expect(summary.truncated).toBe(true);
  });
});

describe("readableContent: characters pdf.js cannot decode", () => {
  // Stripe-generated invoices map the hyphen, minus sign and dash to U+0000 in their ToUnicode
  // CMap: an invoice number "AB12CD34-0003" came out as "AB12CD34\u00000003", a credit lost its minus.
  const garbled = () =>
    fixturePdf([{ lines: ["Invoice number AB12CD34-0003", "Credit -12.34 EUR", "Oct 24-Nov 24, 2026"], font: "nul-hyphen" }]);

  withCanvas("replaces them with U+FFFD, says so, and attaches the page image to read them from", async () => {
    const { blocks, summary } = await readableContent(garbled(), "application/pdf");
    const [text] = texts(blocks);
    expect(text).toContain("Invoice number AB12CD34\uFFFD0003");
    expect(text).toContain("Credit \uFFFD12.34 EUR");
    expect(text).toContain("(3 undecodable characters shown as \uFFFD; page image attached)");
    expect(texts(blocks).join(" ")).toMatch(/Some characters on page 1 could not be decoded .* page 1 is attached as an image/);
    expect(images(blocks)).toHaveLength(1);
    expect(summary).toMatchObject({ kind: "text+image", textPages: [1], renderedPages: [1] });
  });

  it("never lets a control character reach the content or its JSON", async () => {
    const result = withJsonText(
      await binaryResult({
        uri: "lexware://files/f1",
        data: garbled(),
        contentType: "application/pdf",
        structuredContent: { fileId: "f1" },
        message: "Downloaded.",
      }),
    );
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/\\u000[0-8bcef]|\\u001[0-9a-f]/);
    for (const block of result.content) {
      if (block.type === "text") expect(block.text).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/);
    }
  });

  it("sanitizes control characters in text files too", async () => {
    const { blocks, summary } = await readableContent(Buffer.from("<ID>RE\u00001</ID>\r\n"), "application/xml");
    expect(texts(blocks)[0]).toBe("<ID>RE\uFFFD1</ID>\r\n");
    expect(summary.note).toBe("1 control character was replaced with \uFFFD.");
  });
});

describe("readableContent: image attachments", () => {
  it("returns a PNG as-is", async () => {
    const { blocks, summary } = await readableContent(TINY_PNG, "image/png");
    expect(blocks).toEqual([{ type: "image", data: TINY_PNG.toString("base64"), mimeType: "image/png" }]);
    expect(summary).toEqual({ kind: "image" });
  });

  it("returns a JPEG as-is", async () => {
    const { blocks } = await readableContent(TINY_JPEG, "image/jpeg");
    expect(blocks).toEqual([{ type: "image", data: TINY_JPEG.toString("base64"), mimeType: "image/jpeg" }]);
  });

  withCanvas("downscales an image that is small in bytes but large in pixels, onto white", async () => {
    const { createCanvas, loadImage } = canvas!;
    // A 2550×3300 scan (8.4 MP) on a transparent background compresses to well under 1.5 MB.
    const scan = createCanvas(2550, 3300);
    const ctx = scan.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.font = "60px sans-serif";
    for (let y = 200; y < 3200; y += 120) ctx.fillText("Artikel 4711 Menge 1 Preis 12,50 EUR", 150, y);
    const png = await scan.encode("png");
    expect(png.length).toBeLessThan(READABLE_LIMITS.maxImageBytes);

    const { blocks, summary } = await readableContent(png, "image/png");
    expect(blocks).toEqual([expect.objectContaining({ type: "image", mimeType: "image/jpeg" })]);
    const out = await loadImage(Buffer.from((blocks[0] as { data: string }).data, "base64"));
    expect(out.width * out.height).toBeLessThanOrEqual(READABLE_LIMITS.maxImagePixels);
    expect(summary.note).toBe(`Downscaled from 2550×3300 to ${out.width}×${out.height}.`);
    // Transparency became white, not black.
    const corner = createCanvas(1, 1);
    corner.getContext("2d").drawImage(out, 0, 0, 1, 1, 0, 0, 1, 1);
    expect(corner.getContext("2d").getImageData(0, 0, 1, 1).data[0]).toBeGreaterThan(240);
  });

  it("takes a lower decode limit from the deployment (LEXWARE_MAX_DECODE_MP)", async () => {
    configureFileRendering({ maxDecodePixels: 5_000_000 });
    try {
      const { summary } = await readableContent(pngHeader(2550, 3300), "image/png");
      expect(summary).toMatchObject({ kind: "none", note: expect.stringMatching(/more than this server decodes \(5 MP\)/) });
    } finally {
      configureFileRendering({});
    }
    const { summary } = await readableContent(pngHeader(9000, 6000), "image/png");
    expect(summary.note).toMatch(/\(50 MP\)/);
  });

  it("does not decode an image over the decode limit", async () => {
    const { blocks, summary } = await readableContent(pngHeader(9000, 6000), "image/png");
    expect(texts(blocks)[0]).toMatch(/The image is 9000×6000 px, more than this server decodes \(50 MP\)/);
    expect(summary.kind).toBe("none");
  });

  it("reads image sizes from their headers", () => {
    expect(imageDimensions(pngHeader(2550, 3300), "image/png")).toEqual({ width: 2550, height: 3300 });
    expect(imageDimensions(TINY_JPEG, "image/jpeg")).toEqual({ width: 20, height: 10 });
    const gif = Buffer.from("GIF89a\x64\x00\x32\x00", "latin1");
    expect(imageDimensions(gif, "image/gif")).toEqual({ width: 100, height: 50 });
    const vp8x = Buffer.alloc(30);
    vp8x.write("RIFF", 0, "latin1");
    vp8x.write("WEBPVP8X", 8, "latin1");
    vp8x.writeUIntLE(1999, 24, 3);
    vp8x.writeUIntLE(2999, 27, 3);
    expect(imageDimensions(vp8x, "image/webp")).toEqual({ width: 2000, height: 3000 });
    expect(imageDimensions(Buffer.from("not an image"), "image/png")).toBeUndefined();
  });

  it("sniffs an image served as application/octet-stream", async () => {
    const { blocks } = await readableContent(TINY_PNG, "application/octet-stream");
    expect(blocks).toEqual([{ type: "image", data: TINY_PNG.toString("base64"), mimeType: "image/png" }]);
  });

  withCanvas("splits a very tall receipt photo into two overlapping halves", async () => {
    const { createCanvas } = canvas!;
    const photo = createCanvas(900, 7200); // 1:8
    const ctx = photo.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 900, 7200);
    ctx.fillStyle = "#000";
    ctx.font = "40px sans-serif";
    for (let y = 100; y < 7200; y += 80) ctx.fillText("Artikel 4711   1 x 2,49 EUR", 40, y);
    const jpeg = await photo.encode("jpeg", 80);
    const { blocks, summary } = await readableContent(jpeg, "image/jpeg");
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const { width, height } = imageSize((block as { data: string }).data);
      expect(width * height).toBeLessThanOrEqual(READABLE_LIMITS.maxImagePixels);
      expect(height).toBeLessThanOrEqual(READABLE_LIMITS.maxImageSide);
      expect(width).toBeGreaterThanOrEqual(600); // one image would be 322 px wide
    }
    expect(summary.note).toMatch(/^A tall image \(900×7200\), split into two overlapping images \d+ px wide, top half first/);
  });

  withCanvas("downscales an oversized image to a JPEG within the size cap", async () => {
    const { createCanvas } = canvas!;
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
    expect(summary.note).toBe("Downscaled from 3000×2000 to 1897×1264.");
    expect(1897 * 1264).toBeLessThanOrEqual(READABLE_LIMITS.maxImagePixels);
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
