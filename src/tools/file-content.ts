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

/** How a download tool returns the file. */
export const FILE_OUTPUT_MODES = ["auto", "resource", "readable"] as const;
export type FileOutput = (typeof FILE_OUTPUT_MODES)[number];

/** The `output` parameter, shared by every download tool. */
export const fileOutputParam = z
  .enum(FILE_OUTPUT_MODES)
  .default("auto")
  .describe(
    'How to return the file. "auto" (default): the readable form — extracted PDF text, page images ' +
      'for scanned pages, the image itself — plus the raw file as an embedded resource. "readable": ' +
      'only the readable form (smaller; the raw file is still sent when nothing readable could be ' +
      'extracted). "resource": only the raw file, for clients that save embedded resources to disk.',
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
  /** Longest side of a rendered page or a downscaled image, in pixels. */
  maxImageSide: 1600,
  /** A rendered PNG above this many bytes is re-encoded as JPEG (photos compress badly as PNG). */
  maxPngBytes: 1_000_000,
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
  /** 1-based pages whose text was returned. */
  textPages?: number[];
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
 * dependency: a platform without a prebuilt binary still gets text extraction).
 */
function loadCanvas(): Promise<Canvas | undefined> {
  canvasModule ??= import("@napi-rs/canvas").catch(() => undefined);
  return canvasModule;
}

const NO_CANVAS_NOTE =
  "Page images are unavailable on this server (the optional @napi-rs/canvas package is not installed).";

/**
 * Readable content blocks for a downloaded file. Never throws: anything it cannot read
 * comes back as a note.
 */
export async function readableContent(data: Buffer, contentType: string): Promise<ReadableContent> {
  const type = baseType(contentType);
  try {
    if (isPdf(data, type)) return await readPdf(data);
    const imageType = IMAGE_TYPES.has(type) ? type : sniffImageType(data);
    if (imageType) return await readImage(data, imageType);
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

function truncationNote(): string {
  return (
    `[Text truncated after ${READABLE_LIMITS.maxTextChars} characters. ` +
    `The full file is in the embedded resource (output="resource").]`
  );
}

async function readImage(data: Buffer, mimeType: string): Promise<ReadableContent> {
  if (data.length <= READABLE_LIMITS.maxImageBytes) {
    return { blocks: [imageBlock(data, mimeType)], summary: { kind: "image" } };
  }
  const canvas = await loadCanvas();
  if (!canvas) {
    const note = `The image (${data.length} bytes) is too large to return inline. ${NO_CANVAS_NOTE}`;
    return { blocks: [textBlock(note)], summary: { kind: "none", note } };
  }
  const image = await canvas.loadImage(data);
  const scale = Math.min(1, READABLE_LIMITS.maxImageSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const surface = canvas.createCanvas(width, height);
  surface.getContext("2d").drawImage(image, 0, 0, width, height);
  const jpeg = await surface.encode("jpeg", 85);
  return {
    blocks: [imageBlock(jpeg, "image/jpeg")],
    summary: { kind: "image", note: `Downscaled from ${image.width}×${image.height} to ${width}×${height}.` },
  };
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
  /** No text, image or drawing at all. */
  blank: boolean;
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
  layout: PageLayout | undefined,
  view: number[],
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
          : ". Check those characters against the original file (output=\"resource\")."),
    );
  }
  const blank = pdfPages.filter((p) => p.blank).map((p) => p.n);
  if (blank.length > 0) notes.push(`${pages(blank).label} ${pages(blank).is} blank.`);
  return notes;
}

async function readPdf(data: Buffer): Promise<ReadableContent> {
  const { getDocumentProxy, getResolvedPDFJS, registerImageDecoders, renderPageAsImage } = await import("unpdf");
  // JBIG2 / JPEG 2000 decoders: scanners write those, and the layout pass decodes images.
  registerImageDecoders();
  // A copy: PDF.js may take over (detach) the buffer it is handed, and the caller still
  // needs the original bytes for the embedded resource.
  const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
  const { OPS } = await getResolvedPDFJS();
  try {
    const pageCount = pdf.numPages;
    const readPages = Math.min(pageCount, READABLE_LIMITS.maxTextPages);
    const pdfPages: PdfPage[] = [];
    const images: ImageBlock[] = [];
    const notes: string[] = [];
    let truncated = readPages < pageCount;
    let canvasMissing = false;

    for (let n = 1; n <= readPages; n++) {
      const page = await pdf.getPage(n);
      const raw = (await page.getTextContent()).items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("");
      const { text: clean, replaced } = sanitizeText(raw);
      const text = clean.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      const chars = nonWhitespaceLength(text);
      const undecodable = replaced + (raw.match(/�/g)?.length ?? 0);

      // The layout costs an operator list, which decodes the page's images, so it is only
      // built while a page could still be rendered; later pages are judged by their text.
      const wanted = pdfPages.filter((p) => p.render).length;
      const layout =
        wanted < READABLE_LIMITS.maxRenderedPages ? pageLayout(await page.getOperatorList(), OPS, page.view) : undefined;
      const blank =
        chars === 0 && layout !== undefined && layout.imageCoverage === 0 && layout.pathOps === 0 && layout.visibleGlyphs === 0;
      const render = blank ? undefined : renderReason({ chars, undecodable }, layout, page.view);
      const info: PdfPage = {
        n,
        text,
        chars,
        undecodable,
        ocr: chars > 0 && (layout?.invisibleChars ?? 0) >= chars / 2,
        blank,
        render,
        attached: false,
      };
      pdfPages.push(info);

      if (render && images.length < READABLE_LIMITS.maxRenderedPages && !canvasMissing) {
        if (!(await loadCanvas())) {
          canvasMissing = true;
        } else {
          const { width, height } = page.getViewport({ scale: 1 });
          const scale = Math.min(READABLE_LIMITS.maxImageSide / Math.max(width, height), 3);
          const png = await renderPageAsImage(pdf, n, { canvasImport: loadCanvasStrict, scale });
          if (png.length <= READABLE_LIMITS.maxPngBytes) {
            images.push(imageBlock(png, "image/png"));
          } else {
            const jpeg = await renderPageAsImage(pdf, n, { canvasImport: loadCanvasStrict, scale, format: "jpeg", quality: 0.85 });
            images.push(imageBlock(jpeg, "image/jpeg"));
          }
          info.attached = true;
        }
      }
      page.cleanup();
    }

    const blocks: ReadableBlock[] = [];
    // The text of every page that has any, the attached ones included: a stamp, an OCR layer or
    // a partly decoded line still helps, and the section header says to check it against the image.
    const withText = pdfPages.filter((p) => p.chars > 0);
    if (withText.length > 0) {
      const sections = withText.map((p) => {
        const tags = [
          p.ocr ? "invisible OCR text layer, may contain recognition errors" : "",
          p.undecodable > 0 ? `${p.undecodable} undecodable character${p.undecodable > 1 ? "s" : ""} shown as �` : "",
          p.attached ? "page image attached" : "",
        ].filter(Boolean);
        return `--- Page ${p.n} of ${pageCount}${tags.length > 0 ? ` (${tags.join("; ")})` : ""} ---\n${p.text}`;
      });
      const capped = cap(`Extracted PDF text:\n\n${sections.join("\n\n")}`, READABLE_LIMITS.maxTextChars);
      blocks.push(textBlock(capped.text));
      if (capped.truncated) {
        truncated = true;
        blocks.push(textBlock(truncationNote()));
      }
    }
    blocks.push(...images);

    notes.push(...pageNotes(pdfPages));
    if (canvasMissing) notes.push(NO_CANVAS_NOTE);
    const notAttached = pdfPages.filter((p) => p.render && !p.attached).map((p) => p.n);
    if (notAttached.length > 0 && !canvasMissing) {
      truncated = true;
      notes.push(
        `${pages(notAttached).label} would need a page image too but ${pages(notAttached).is} not attached ` +
          `(at most ${READABLE_LIMITS.maxRenderedPages} page images per call).`,
      );
    }
    if (readPages < pageCount) {
      notes.push(
        `Only pages 1–${readPages} of the ${pageCount}-page PDF are read. The full file is in the embedded resource (output="resource").`,
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
        textPages: withText.map((p) => p.n),
        renderedPages,
        ...(truncated ? { truncated } : {}),
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      },
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** loadCanvas for unpdf, which needs the module itself (only called once it is known to load). */
async function loadCanvasStrict(): Promise<Canvas> {
  const canvas = await loadCanvas();
  if (!canvas) throw new Error(NO_CANVAS_NOTE);
  return canvas;
}
