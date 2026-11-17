/**
 * Turn a downloaded file into content blocks a model can read without the embedded
 * resource.
 *
 * Whether the model ever sees an embedded-resource blob depends on the client: Claude Code
 * saves it to a file the model can open, while claude.ai / Cowork drop a PDF blob before the
 * model, so the tool call "succeeds" and the receipt is still unreadable. Text and image
 * blocks reach the model on every client, so the download tools add them next to the blob:
 *
 *   - PDF with a text layer       → the extracted text, one section per page
 *   - PDF pages that are an image → rendered to an image (a scan, a photo saved as PDF), also
 *                                   when they carry a short line of text such as a stamp
 *   - PDF pages pdf.js cannot     → the text with U+FFFD for the lost characters, plus the
 *     fully decode                  page image to read them from
 *   - image/png, jpeg, gif, webp  → the image itself
 *   - XML / JSON / text/*         → the UTF-8 text
 *
 * Everything is capped (pages read, pages rendered, render size, text length) so a 200-page
 * PDF or a 12 MP photo cannot blow up the response. Extraction is best effort: a file it
 * cannot read still downloads, with a note instead of the readable blocks.
 *
 * Independent of Skybridge, like the rest of src/tools. The PDF and canvas libraries load on
 * first use, so a server that never downloads a file pays nothing for them at start-up.
 */

import { z } from "zod";
import { type PageLayout, pageLayout } from "./pdf-page-layout.js";
import { BudgetExceeded, Deadline, Semaphore } from "./render-budget.js";

/** How a download tool returns the file. */
export const FILE_OUTPUT_MODES = ["auto", "resource", "readable"] as const;
export type FileOutput = (typeof FILE_OUTPUT_MODES)[number];

/**
 * The largest file `output="auto"` also attaches as an embedded resource, in bytes (~2 MB as
 * base64). Born-digital invoices are 20–300 KB, so they keep the blob; above this a file is
 * almost always a photo or a scan, whose readable form is already its page images.
 */
export const AUTO_RESOURCE_MAX_BYTES = 1_500_000;

/** The `output` parameter, shared by every download tool. */
export const fileOutputParam = z
  .enum(FILE_OUTPUT_MODES)
  .default("auto")
  .describe(
    'How to return the file. "auto" (default): the readable form — extracted PDF text, page images ' +
      'for scanned pages, the image itself — plus the raw file as an embedded resource if it is at ' +
      `most ${AUTO_RESOURCE_MAX_BYTES / 1_000_000} MB. "readable": only the readable form (the raw ` +
      'file is still sent when nothing readable could be extracted). "resource": only the raw file, ' +
      'at any size, for clients that save embedded resources to disk.',
  );

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };
export type ReadableBlock = TextBlock | ImageBlock;

/** Limits that keep a readable response small. Exported for tests and docs. */
export const READABLE_LIMITS = {
  /** PDF pages whose text is read. Later pages are reported, not read. */
  maxTextPages: 30,
  /** Characters of extracted text returned in total; the rest is cut with a note. */
  maxTextChars: 30_000,
  /** Pages rendered to an image when they have no text layer. */
  maxRenderedPages: 3,
  /**
   * Pixels of a rendered page or a downscaled image. A pixel budget rather than a fixed long
   * side, so a narrow, tall till receipt keeps a legible width: an A4 page comes out about
   * 1300×1840, an 80 mm receipt 1:4 as 640×2576 instead of 400×1600.
   */
  maxImagePixels: 2_400_000,
  /** Longest side, in pixels: the most current Claude models take in without scaling down. */
  maxImageSide: 2576,
  /** Highest render resolution, in dots per inch: a small page is not blown up past this. */
  maxRenderDpi: 300,
  /**
   * Largest image pdf.js decodes, in pixels (its `maxImageSize`); a bigger one is left out with
   * a note. Rendering a page costs about 12 bytes per image pixel at its peak (measured: a
   * 12 MP photo ≈ +160 MB RSS, 24 MP ≈ +330 MB, 48 MP ≈ +600 MB), so 50 MP — a 48 MP phone
   * photo, a 600 dpi A4 scan — is what one render may take on a 1 GiB instance.
   */
  maxDecodePixels: 50_000_000,
  /**
   * A PDF with an image at least this large is "heavy": its pages are decoded and rendered
   * one at a time across all calls (maxConcurrentRenders). Born-digital PDFs (logos, small
   * graphics) stay below it and skip the queue.
   */
  heavyImagePixels: 2_000_000,
  /** Heavy pages decoded or rendered at the same time, across all calls (bounds peak memory). */
  maxConcurrentRenders: 1,
  /** Time one call may spend on layout and page images before it stops and says so. */
  timeBudgetMs: 20_000,
  /** An image attachment above this many bytes is downscaled before it is returned. */
  maxImageBytes: 1_500_000,
  /** A page with fewer visible non-whitespace characters than this has no usable text layer. */
  minPageChars: 20,
  /**
   * A page with at most this many visible characters (per A4 of page area) next to a large
   * image or a lot of vector drawing is a scan: the text is a stamp or a footer line
   * ("Scanned with CamScanner"), not the page's content, so the page is rendered too.
   */
  scanMaxChars: 200,
  /** "A large image": images cover at least this fraction of the page. */
  scanMinImageCoverage: 0.2,
  /** "A lot of vector drawing": at least this many path operations (e.g. text as outlines). */
  scanMinPathOps: 100,
} as const;

/** Summary of what was made readable, for structuredContent. */
export interface ReadableSummary {
  /** What the blocks carry: extracted text, images, both, or nothing usable. */
  kind: "text" | "image" | "text+image" | "none";
  pageCount?: number;
  /** 1-based pages whose text was returned in full. */
  textPages?: number[];
  /** The page whose text was cut off by the text limit, if one was. */
  partialTextPage?: number;
  /** 1-based pages returned as images. */
  renderedPages?: number[];
  /** True when text or pages were left out because of the limits. */
  truncated?: boolean;
  /** Why nothing (or less than expected) could be extracted. */
  note?: string;
}

export interface ReadableContent {
  blocks: ReadableBlock[];
  summary: ReadableSummary;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The bare MIME type, lower-cased, without parameters such as `; charset=utf-8`. */
function baseType(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

function isPdf(data: Buffer, type: string): boolean {
  // Sniff as well: Lexware serves some files as application/octet-stream.
  return type === "application/pdf" || data.subarray(0, 1024).includes("%PDF-");
}

function isTextual(type: string): boolean {
  return (
    type.startsWith("text/") ||
    type === "application/xml" ||
    type === "application/json" ||
    type.endsWith("+xml") ||
    type.endsWith("+json")
  );
}

/** Sniff an image type from magic bytes, for files served as octet-stream. */
function sniffImageType(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

/**
 * Control characters (C0 except tab, line feed and carriage return; DEL; C1). pdf.js emits them
 * for glyphs it cannot map to Unicode — Stripe-generated invoices map the hyphen in the invoice
 * number, the minus sign of a credit and the dash of a date range to U+0000 in their
 * ToUnicode CMap. They must never reach the model or the JSON.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Replace control characters with U+FFFD, counting them. */
export function sanitizeText(text: string): { text: string; replaced: number } {
  let replaced = 0;
  const clean = text.replace(CONTROL_CHARS, () => {
    replaced++;
    return "�";
  });
  return { text: clean, replaced };
}

function textBlock(text: string): TextBlock {
  // The last line of defence: whatever produced the text, no control character leaves here.
  return { type: "text", text: sanitizeText(text).text };
}

function imageBlock(data: Uint8Array, mimeType: string): ImageBlock {
  return { type: "image", data: Buffer.from(data).toString("base64"), mimeType };
}

/** Cut text to `max` characters, reporting whether it was cut. */
function cap(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nonWhitespaceLength(s: string): number {
  return Array.from(s.replace(/\s/g, "")).length;
}

type Canvas = typeof import("@napi-rs/canvas");
let canvasModule: Promise<Canvas | undefined> | undefined;

/**
 * The optional native canvas, or undefined when it is not installed (an optional
 * dependency: a platform without a prebuilt binary still gets text extraction). The first
 * failure is logged once, so a server without page images says so instead of failing quietly.
 */
function loadCanvas(): Promise<Canvas | undefined> {
  canvasModule ??= import("@napi-rs/canvas").catch((err: unknown) => {
    console.error(
      "[lexware-mcp] WARNING: @napi-rs/canvas could not be loaded, so the download tools cannot render " +
        "scanned PDF pages or downscale images; they return text and notes only. Install the optional " +
        `dependency (npm install without --omit=optional) on a platform it ships a binary for. (${errorMessage(err)})`,
    );
    return undefined;
  });
  return canvasModule;
}

/**
 * Load the canvas now, so a missing one is reported when the server starts rather than with
 * the first scanned receipt. Returns whether page images are available.
 */
export async function checkPageImages(): Promise<boolean> {
  return (await loadCanvas()) !== undefined;
}

/**
 * Render slots shared by every call. Exported so tests can watch (and hold) them.
 * @internal
 */
export const renderSlots = new Semaphore(READABLE_LIMITS.maxConcurrentRenders);

const NO_CANVAS_NOTE =
  "Page images are unavailable on this server (the optional @napi-rs/canvas package is not installed).";

/**
 * Readable content blocks for a downloaded file. Never throws: anything it cannot read
 * comes back as a note.
 */
export async function readableContent(
  data: Buffer,
  contentType: string,
  opts: { timeBudgetMs?: number } = {},
): Promise<ReadableContent> {
  const type = baseType(contentType);
  const deadline = new Deadline(opts.timeBudgetMs ?? READABLE_LIMITS.timeBudgetMs);
  try {
    if (isPdf(data, type)) return await readPdf(data, deadline);
    const imageType = IMAGE_TYPES.has(type) ? type : sniffImageType(data);
    if (imageType) return await readImage(data, imageType, deadline);
    if (isTextual(type)) return readText(data);
    return { blocks: [], summary: { kind: "none", note: `No readable form for ${type || "this file type"}.` } };
  } catch (err) {
    const note = `Could not read the file's content: ${errorMessage(err)}`;
    return { blocks: [textBlock(note)], summary: { kind: "none", note } };
  }
}

function readText(data: Buffer): ReadableContent {
  const { text: clean, replaced } = sanitizeText(data.toString("utf8"));
  const { text, truncated } = cap(clean, READABLE_LIMITS.maxTextChars);
  const blocks = [textBlock(text)];
  if (truncated) blocks.push(textBlock(truncationNote()));
  const note = replaced > 0 ? `${replaced} control character${replaced > 1 ? "s were" : " was"} replaced with �.` : undefined;
  if (note) blocks.push(textBlock(`[${note}]`));
  return { blocks, summary: { kind: "text", truncated, ...(note ? { note } : {}) } };
}

/** Where to get what the readable form leaves out: the blob is not always attached. */
const FULL_FILE = 'The full file is available with output="resource".';

function truncationNote(): string {
  return `[Text truncated after ${READABLE_LIMITS.maxTextChars} characters. ${FULL_FILE}]`;
}

/**
 * Width and height from an image file's header, without decoding it (PNG IHDR, JPEG SOF,
 * GIF logical screen, WebP VP8/VP8L/VP8X). Undefined when the header cannot be read.
 */
export function imageDimensions(data: Buffer, mimeType: string): { width: number; height: number } | undefined {
  try {
    if (mimeType === "image/png") return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    if (mimeType === "image/gif") return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    if (mimeType === "image/webp") {
      const chunk = data.subarray(12, 16).toString("latin1");
      if (chunk === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
      if (chunk === "VP8L") {
        const bits = data.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
      }
      return undefined;
    }
    if (mimeType === "image/jpeg") {
      let i = 2;
      while (i + 9 < data.length) {
        if (data[i] !== 0xff) return undefined;
        const marker = data[i + 1]!;
        if (marker === 0xff) {
          i++; // fill byte
          continue;
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
        }
        i += marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) ? 2 : 2 + data.readUInt16BE(i + 2);
      }
    }
  } catch {
    // A truncated header: fall through.
  }
  return undefined;
}

/** Whether `width`×`height` is within the pixel budget and the long-side cap. */
function fitsBudget(width: number, height: number): boolean {
  return width * height <= READABLE_LIMITS.maxImagePixels && Math.max(width, height) <= READABLE_LIMITS.maxImageSide;
}

/**
 * An image attachment as an image block. Passed through untouched when it is small in bytes
 * and in pixels; otherwise decoded once and downscaled into the same pixel budget as a
 * rendered page (a 2550×3300 scan under 1.5 MB is still 8.4 MP), on a white background (JPEG
 * has no transparency). A large image waits for the render slot, like a heavy PDF page.
 */
async function readImage(data: Buffer, mimeType: string, deadline: Deadline): Promise<ReadableContent> {
  const size = imageDimensions(data, mimeType);
  if (data.length <= READABLE_LIMITS.maxImageBytes && size && fitsBudget(size.width, size.height)) {
    return { blocks: [imageBlock(data, mimeType)], summary: { kind: "image" } };
  }
  if (size && size.width * size.height > READABLE_LIMITS.maxDecodePixels) {
    const note =
      `The image is ${size.width}×${size.height} px, more than this server decodes ` +
      `(${READABLE_LIMITS.maxDecodePixels / 1_000_000} MP). ${FULL_FILE}`;
    return { blocks: [textBlock(`[${note}]`)], summary: { kind: "none", note } };
  }
  const canvas = await loadCanvas();
  if (!canvas) {
    if (data.length <= READABLE_LIMITS.maxImageBytes) {
      const note = `Returned at its original size: it could not be downscaled. ${NO_CANVAS_NOTE}`;
      return { blocks: [imageBlock(data, mimeType), textBlock(`[${note}]`)], summary: { kind: "image", note } };
    }
    const note = `The image (${data.length} bytes) is too large to return inline. ${NO_CANVAS_NOTE}`;
    return { blocks: [textBlock(`[${note}]`)], summary: { kind: "none", note } };
  }
  const downscale = async () => {
    const image = await canvas.loadImage(data);
    const scale = Math.min(1, fitScale(image.width, image.height));
    const width = Math.max(1, Math.floor(image.width * scale));
    const height = Math.max(1, Math.floor(image.height * scale));
    const surface = canvas.createCanvas(width, height);
    const ctx = surface.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    const jpeg = await surface.encode("jpeg", 85);
    const note = width === image.width ? "Re-encoded as JPEG." : `Downscaled from ${image.width}×${image.height} to ${width}×${height}.`;
    return { blocks: [imageBlock(jpeg, "image/jpeg")], summary: { kind: "image" as const, note } };
  };
  const heavy = !size || size.width * size.height >= READABLE_LIMITS.heavyImagePixels;
  try {
    return await (heavy ? renderSlots.run(() => deadline.race(downscale()), deadline) : deadline.race(downscale()));
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    const note = `The image could not be downscaled in time (the server is busy). Try again. ${FULL_FILE}`;
    return { blocks: [textBlock(`[${note}]`)], summary: { kind: "none", note } };
  }
}

/** A4 in PDF points, the reference area for the "little text" threshold. */
const A4_AREA = 595 * 842;

/** Why a page is attached as an image. */
type RenderReason = "no-text" | "scan" | "undecodable";

interface PdfPage {
  n: number;
  /** Extracted text, with undecodable characters replaced by U+FFFD. */
  text: string;
  /** Non-whitespace characters in `text`. */
  chars: number;
  /** Characters pdf.js could not map to Unicode (control characters, U+FFFD). */
  undecodable: number;
  /** Most of the text layer is invisible: an OCR layer over a scanned image. */
  ocr: boolean;
  /** Why the page needs an image, if it does. */
  render?: RenderReason;
  /** The page image is in the response. */
  attached: boolean;
}

/**
 * Whether a page has to be looked at rather than read. Its text alone cannot tell: a scan
 * often carries one real line ("Scanned with CamScanner", an inbox stamp, a page number) and
 * an OCR'd scan a whole page of invisible text, so the page's layout decides.
 *
 *   - no-text:     fewer than minPageChars visible characters (a scan, a photo, an OCR'd scan)
 *   - scan:        little visible text (≤ scanMaxChars per A4) next to a large image or a lot
 *                  of vector drawing — the text is a stamp or a footer, the content is a picture
 *   - undecodable: some characters could not be decoded, so the text alone is not reliable
 *
 * Without a layout (past the render cap) only the text-based rules apply.
 */
function renderReason(
  page: { chars: number; undecodable: number },
  layout?: PageLayout,
  view: number[] = [0, 0, 595, 842],
): RenderReason | undefined {
  const visible = Math.max(0, page.chars - (layout?.invisibleChars ?? 0));
  if (visible < READABLE_LIMITS.minPageChars) return "no-text";
  if (layout) {
    const area = Math.abs((view[2]! - view[0]!) * (view[3]! - view[1]!));
    const sparse = visible <= READABLE_LIMITS.scanMaxChars * Math.max(1, area / A4_AREA);
    const pictorial =
      layout.imageCoverage >= READABLE_LIMITS.scanMinImageCoverage || layout.pathOps >= READABLE_LIMITS.scanMinPathOps;
    if (sparse && pictorial) return "scan";
  }
  if (page.undecodable > 0) return "undecodable";
  return undefined;
}

/** "1–3, 5" for [1, 2, 3, 5]. */
function pageList(pages: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    parts.push(j > i ? `${pages[i]}–${pages[j]}` : `${pages[i]}`);
    i = j;
  }
  return parts.join(", ");
}

/** "Page 2" / "Pages 1–3", with the verb forms that go with it. */
function pages(list: number[]): { label: string; is: string; has: string } {
  const many = list.length > 1;
  return { label: `${many ? "Pages" : "Page"} ${pageList(list)}`, is: many ? "are" : "is", has: many ? "have" : "has" };
}

function pageNotes(pdfPages: PdfPage[]): string[] {
  const notes: string[] = [];
  const attached = (reason: RenderReason) => pdfPages.filter((p) => p.attached && p.render === reason).map((p) => p.n);
  const noText = attached("no-text");
  if (noText.length > 0) {
    const p = pages(noText);
    notes.push(`${p.label} ${p.has} little or no visible text (scanned or photographed) and ${p.is} attached as an image.`);
  }
  const scans = attached("scan");
  if (scans.length > 0) {
    const p = pages(scans);
    notes.push(
      `${p.label} ${p.is} mostly an image with only a little text (e.g. a scan with a stamp or a footer line) ` +
        `and ${p.is} attached as an image: read the content from the image, not from the text.`,
    );
  }
  const garbled = pdfPages.filter((p) => p.undecodable > 0);
  if (garbled.length > 0) {
    const shown = garbled.filter((p) => p.attached).map((p) => p.n);
    notes.push(
      `Some characters on ${pages(garbled.map((p) => p.n)).label.toLowerCase()} could not be decoded and are shown as �` +
        (shown.length > 0
          ? `; ${pages(shown).label.toLowerCase()} ${pages(shown).is} attached as an image — read those characters ` +
            `(often a hyphen in an invoice number, a minus sign or a dash) from it.`
          : `. Check those characters against the full file (output="resource").`),
    );
  }
  return notes;
}

/**
 * The render scale for a page of `width`×`height` points: as large as the pixel budget, the
 * long-side cap and the resolution cap allow. Pixel dimensions are floored, so the result
 * never exceeds the budget.
 */
export function renderScale(width: number, height: number): number {
  return Math.min(fitScale(width, height), READABLE_LIMITS.maxRenderDpi / 72);
}

/** The scale that fits `width`×`height` into the pixel budget and the long-side cap. */
function fitScale(width: number, height: number): number {
  return Math.min(
    Math.sqrt(READABLE_LIMITS.maxImagePixels / (width * height)),
    READABLE_LIMITS.maxImageSide / Math.max(width, height),
  );
}

/**
 * The largest image in a PDF, read from the image dictionaries in the raw bytes, before
 * pdf.js decodes anything. An image XObject is a stream, and a stream's dictionary is always
 * a direct object in the file body (never inside a compressed object stream), so its /Width
 * and /Height are there to read. `unknown` when an image's size is not a plain number.
 */
export function largestPdfImage(data: Buffer): { width: number; height: number } | "unknown" | undefined {
  const raw = data.toString("latin1");
  let largest: { width: number; height: number } | "unknown" | undefined;
  for (const match of raw.matchAll(/\/Subtype\s*\/Image\b/g)) {
    // The dictionary around the match: back to its "obj", forward to its "stream".
    const start = Math.max(raw.lastIndexOf(" obj", match.index), match.index - 2048, 0);
    const streamAt = raw.indexOf("stream", match.index);
    const end = Math.min(streamAt < 0 ? raw.length : streamAt, match.index + 2048);
    const dict = raw.slice(start, end);
    const width = /\/Width\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    const height = /\/Height\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    if (!width || !height) {
      largest ??= "unknown";
      continue;
    }
    const size = { width: Number(width[1]), height: Number(height[1]) };
    if (largest === undefined || largest === "unknown" || size.width * size.height > largest.width * largest.height) {
      largest = size;
    }
  }
  return largest;
}

async function readPdf(data: Buffer, deadline: Deadline): Promise<ReadableContent> {
  const { getDocumentProxy, getResolvedPDFJS, registerImageDecoders, renderPageAsImage } = await import("unpdf");
  // JBIG2 / JPEG 2000 decoders: scanners write those, and the layout pass decodes images.
  registerImageDecoders();
  const largest = largestPdfImage(data);
  const largestPixels = largest === undefined ? 0 : largest === "unknown" ? Infinity : largest.width * largest.height;
  const heavy = largestPixels >= READABLE_LIMITS.heavyImagePixels;
  // A copy: PDF.js may take over (detach) the buffer it is handed, and the caller still
  // needs the original bytes for the embedded resource.
  const pdf = await getDocumentProxy(new Uint8Array(data), {
    verbosity: 0,
    maxImageSize: READABLE_LIMITS.maxDecodePixels,
  });
  const { OPS } = await getResolvedPDFJS();
  try {
    const pageCount = pdf.numPages;
    const readPages = Math.min(pageCount, READABLE_LIMITS.maxTextPages);
    const pdfPages: PdfPage[] = [];
    const images: ImageBlock[] = [];
    const notes: string[] = [];
    let truncated = readPages < pageCount;
    let canvasMissing = false;
    let stopped: BudgetExceeded | undefined;

    // Pass 1: the text of every page read. Cheap — no image is decoded for it.
    for (let n = 1; n <= readPages; n++) {
      const page = await pdf.getPage(n);
      const raw = (await page.getTextContent()).items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("");
      const { text: clean, replaced } = sanitizeText(raw);
      const text = clean.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      const chars = nonWhitespaceLength(text);
      const undecodable = replaced + (raw.match(/\uFFFD/g)?.length ?? 0);
      pdfPages.push({ n, text, chars, undecodable, ocr: false, attached: false });
    }

    // Pass 2: layout, and the page image where one is needed — one page at a time, within the
    // call's time budget; a heavy file's pages also wait for the shared render slot.
    //
    // pdf.js never reuses an operator list from getOperatorList() for render() (different
    // cache keys), so a layout pass decodes the page's images once more. A page without text
    // is rendered straight away (it needs an image whatever its layout); the layout is built
    // only for pages with text, where it is cheap unless the page holds a large image.
    // Past the render cap, and once the budget has run out, pages are judged by text alone.
    const renderPage = async (page: Awaited<ReturnType<typeof pdf.getPage>>, info: PdfPage, photo: boolean) => {
      if (images.length >= READABLE_LIMITS.maxRenderedPages || canvasMissing) return;
      if (!(await loadCanvas())) {
        canvasMissing = true;
        return;
      }
      // Rendered once, in a format chosen up front: JPEG for a page that is mostly a picture
      // (a scan or a photo — huge as PNG), PNG for vector text (sharp and small).
      const { width, height } = page.getViewport({ scale: 1 });
      const rendering = renderPageAsImage(pdf, info.n, {
        canvasImport: loadCanvasStrict,
        scale: renderScale(width, height),
        ...(photo ? { format: "jpeg" as const, quality: 0.8 } : {}),
      });
      try {
        images.push(imageBlock(await deadline.race(rendering), photo ? "image/jpeg" : "image/png"));
        info.attached = true;
      } catch (err) {
        // Out of time mid-render: destroying the document cancels the render, and the slot is
        // only released once it has actually stopped, so the memory bound holds.
        if (err instanceof BudgetExceeded) {
          await pdf.loadingTask.destroy().catch(() => {});
          await rendering.catch(() => {});
        }
        throw err;
      }
    };
    for (const info of pdfPages) {
      const wanted = pdfPages.filter((p) => p.render).length;
      if (stopped || wanted >= READABLE_LIMITS.maxRenderedPages) {
        info.render = renderReason(info);
        continue;
      }
      const page = await pdf.getPage(info.n);
      const work = async () => {
        if (info.chars < READABLE_LIMITS.minPageChars) {
          // Almost always a scan or a photo: JPEG, unless the file has no image at all.
          info.render = "no-text";
          await renderPage(page, info, largest !== undefined);
          return;
        }
        const layout = pageLayout(await deadline.race(page.getOperatorList()), OPS, page.view);
        // Free what the layout pass decoded before the render decodes it again.
        page.cleanup();
        info.ocr = layout.invisibleChars >= info.chars / 2;
        info.render = renderReason(info, layout, page.view);
        if (info.render) await renderPage(page, info, layout.imageCoverage >= READABLE_LIMITS.scanMinImageCoverage);
      };
      try {
        await (heavy ? renderSlots.run(work, deadline) : deadline.race(work()));
      } catch (err) {
        if (!(err instanceof BudgetExceeded)) throw err;
        stopped = err;
        info.render ??= renderReason(info);
        continue;
      }
      // Free the decoded images now; the next page must not stack on top of them.
      page.cleanup();
    }

    const blocks: ReadableBlock[] = [];
    const completeText: number[] = [];
    let partialText: number | undefined;
    // The text of every page that has any, the attached ones included: a stamp, an OCR layer or
    // a partly decoded line still helps, and the section header says to check it against the image.
    const withText = pdfPages.filter((p) => p.chars > 0);
    if (withText.length > 0) {
      const sections = withText.map((p) => {
        const tags = [
          p.ocr ? "invisible OCR text layer, may contain recognition errors" : "",
          p.undecodable > 0 ? `${p.undecodable} undecodable character${p.undecodable > 1 ? "s" : ""} shown as \uFFFD` : "",
          p.attached ? "page image attached" : "",
        ].filter(Boolean);
        return `--- Page ${p.n} of ${pageCount}${tags.length > 0 ? ` (${tags.join("; ")})` : ""} ---\n${p.text}`;
      });
      // Whole sections while they fit; the one that does not is cut, and reported as cut.
      let text = "Extracted PDF text:";
      for (const [i, section] of sections.entries()) {
        const piece = `\n\n${section}`;
        if (text.length + piece.length <= READABLE_LIMITS.maxTextChars) {
          text += piece;
          completeText.push(withText[i]!.n);
          continue;
        }
        partialText = withText[i]!.n;
        text += piece.slice(0, READABLE_LIMITS.maxTextChars - text.length);
        const left = withText.slice(i + 1).map((p) => p.n);
        const span = (list: number[]) => pages(list).label.toLowerCase();
        const parts = [
          completeText.length > 0 ? `${span(completeText)} complete` : "",
          `page ${partialText} cut off`,
          left.length > 0 ? `${span(left)} not shown` : "",
        ].filter(Boolean);
        truncated = true;
        blocks.push(textBlock(text));
        blocks.push(
          textBlock(`[Text truncated after ${READABLE_LIMITS.maxTextChars} characters: ${parts.join(", ")}. ${FULL_FILE}]`),
        );
        break;
      }
      if (partialText === undefined) blocks.push(textBlock(text));
    }
    blocks.push(...images);

    notes.push(...pageNotes(pdfPages));
    if (canvasMissing) notes.push(NO_CANVAS_NOTE);
    if (largestPixels > READABLE_LIMITS.maxDecodePixels && largest !== "unknown" && largest !== undefined) {
      truncated = true;
      notes.push(
        `The PDF contains an image of ${largest.width}×${largest.height} px, more than this server decodes ` +
          `(${READABLE_LIMITS.maxDecodePixels / 1_000_000} MP), so it is missing from the page images. ` +
          FULL_FILE,
      );
    }
    const notAttached = pdfPages.filter((p) => p.render && !p.attached).map((p) => p.n);
    if (stopped) {
      truncated = true;
      notes.push(
        (stopped.reason === "busy"
          ? `The server was busy rendering other files and ran out of time for this one`
          : `Rendering ran out of time (${Math.round(deadline.budgetMs / 100) / 10} s per call)`) +
          (notAttached.length > 0 ? `: ${pages(notAttached).label.toLowerCase()} ${pages(notAttached).is} not attached as an image` : "") +
          `. Try again, or get the full file with output="resource".`,
      );
    } else if (notAttached.length > 0 && !canvasMissing) {
      truncated = true;
      notes.push(
        `${pages(notAttached).label} would need a page image too but ${pages(notAttached).is} not attached ` +
          `(at most ${READABLE_LIMITS.maxRenderedPages} page images per call).`,
      );
    }
    if (readPages < pageCount) {
      notes.push(
        `Only pages 1–${readPages} of the ${pageCount}-page PDF are read. ${FULL_FILE}`,
      );
    }
    if (blocks.length === 0 && notes.length === 0) notes.push("The PDF has no extractable text.");
    for (const note of notes) blocks.push(textBlock(`[${note}]`));

    const renderedPages = pdfPages.filter((p) => p.attached).map((p) => p.n);
    const kind =
      withText.length > 0 && renderedPages.length > 0
        ? "text+image"
        : withText.length > 0
          ? "text"
          : renderedPages.length > 0
            ? "image"
            : "none";
    return {
      blocks,
      summary: {
        kind,
        pageCount,
        textPages: completeText,
        ...(partialText !== undefined ? { partialTextPage: partialText } : {}),
        renderedPages,
        ...(truncated ? { truncated } : {}),
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      },
    };
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}

/** loadCanvas for unpdf, which needs the module itself (only called once it is known to load). */
async function loadCanvasStrict(): Promise<Canvas> {
  const canvas = await loadCanvas();
  if (!canvas) throw new Error(NO_CANVAS_NOTE);
  return canvas;
}
