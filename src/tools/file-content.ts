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
 * first use, so a server that never downloads a file pays nothing for them at start-up; at
 * start-up the server only checks that the canvas is installed (resolved, not loaded).
 */

import { z } from "zod";
import { createRequire } from "node:module";
import { nonWhitespaceLength, type PageLayout, pageLayout } from "./pdf-page-layout.js";
import { BudgetExceeded, Deadline, runWithin, Semaphore, settleWithin } from "./render-budget.js";

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
  /**
   * A page or image taller than this many times its width (a till receipt) is split into two
   * overlapping images, each within the pixel budget and the long-side cap. One image would
   * be held to 2576 px tall, so a 1:8 receipt would come out 322 px wide; two come out ~640.
   */
  tallAspect: 4.5,
  /** Rows (in output pixels) the two halves of a tall page share, so no line is cut in two. */
  tileOverlap: 48,
  /** Highest render resolution, in dots per inch: a small page is not blown up past this. */
  maxRenderDpi: 300,
  /**
   * Largest image pdf.js decodes, in pixels (its `maxImageSize`); a bigger one is left out with
   * a note. Rendering a page costs about 12 bytes per image pixel at its peak (measured: a
   * 12 MP photo ≈ +160 MB RSS, 24 MP ≈ +330 MB, 48 MP ≈ +600 MB), so 50 MP — a 48 MP phone
   * photo, a 600 dpi A4 scan — is what one render may take on a 1 GiB instance. Set
   * LEXWARE_MAX_DECODE_MP to lower it (20 for a 512 MiB instance).
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
  /**
   * Time one call may spend on layout and page images before it stops and says so
   * (LEXWARE_RENDER_TIME_BUDGET_MS).
   */
  timeBudgetMs: 20_000,
  /**
   * After a timeout, how long a cancelled render may keep its slot while it winds down (a
   * decode in progress cannot be interrupted). The call itself has already answered.
   */
  cancelGraceMs: 15_000,
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

/**
 * The limits a deployment can change (env vars, read and validated in src/config.ts): a
 * 512 MiB instance lowers the decode limit, a slow one raises the time budget.
 */
const settings: { maxDecodePixels: number; timeBudgetMs: number } = {
  maxDecodePixels: READABLE_LIMITS.maxDecodePixels,
  timeBudgetMs: READABLE_LIMITS.timeBudgetMs,
};

/** Apply the deployment's limits; unset ones keep their defaults (READABLE_LIMITS). */
export function configureFileRendering(next: { maxDecodePixels?: number; timeBudgetMs?: number }): void {
  settings.maxDecodePixels = next.maxDecodePixels ?? READABLE_LIMITS.maxDecodePixels;
  settings.timeBudgetMs = next.timeBudgetMs ?? READABLE_LIMITS.timeBudgetMs;
}

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
  /**
   * Pages whose content the readable form lacks: they need an image to be read (a scan,
   * undecodable characters, an image over the decode limit) but have none — the page-image
   * cap, the time budget, a missing canvas — or their text could not be read in time. Their
   * content is only in the raw file, so the download tools then attach it whatever `output`
   * says.
   */
  missingPageImages?: number[];
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

/** Declared types that say nothing about the content, so the bytes decide. */
const VAGUE_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-download"]);

function isPdf(data: Buffer, type: string): boolean {
  if (type === "application/pdf" || data.subarray(0, 5).toString("latin1") === "%PDF-") return true;
  // Lexware serves some files as application/octet-stream, and a PDF may have a little junk
  // before its header. Only then search the first 1 KB: a text, XML or JSON file that merely
  // mentions "%PDF-" is not a PDF.
  return VAGUE_TYPES.has(type) && data.subarray(0, 1024).includes("%PDF-");
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
 * Load the canvas and say whether page images work: loads the native module, so it is for
 * checks (scripts/check-page-images.mjs in CI), not for start-up.
 */
export async function checkPageImages(): Promise<boolean> {
  return (await loadCanvas()) !== undefined;
}

/**
 * Whether @napi-rs/canvas and a native binary for this platform are installed — resolved,
 * not loaded: loading costs ~0.25 s and ~30 MB, which only the first scanned page should pay.
 * The server checks this at start-up to warn early; a binary that is there but fails to load
 * is reported (once) on first use.
 */
export function pageImagesInstalled(
  resolve: (id: string, from: string) => string = (id, from) => createRequire(from).resolve(id),
): boolean {
  let main: string;
  try {
    main = resolve("@napi-rs/canvas", import.meta.url);
  } catch {
    return false;
  }
  // The binary is a per-platform optional dependency of the canvas package, e.g.
  // @napi-rs/canvas-linux-x64-gnu: resolve it from the canvas package, where npm put it.
  const base = `@napi-rs/canvas-${process.platform}-${process.arch}`;
  return ["", "-gnu", "-musl", "-msvc", "-gnueabihf"].some((abi) => {
    try {
      resolve(`${base}${abi}/package.json`, main);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Render slots shared by every call. Exported so tests can watch (and hold) them.
 * @internal
 */
export const renderSlots = new Semaphore(READABLE_LIMITS.maxConcurrentRenders);

const NO_CANVAS_NOTE =
  "Page images are unavailable on this server (the optional @napi-rs/canvas package is not installed).";

/** One call's time budget, and how long cancelled work may keep its render slot. */
interface Budget {
  deadline: Deadline;
  graceMs: number;
}

/**
 * Readable content blocks for a downloaded file. Never throws: anything it cannot read
 * comes back as a note. Always returns within the time budget (plus the time to extract
 * the text layer), however a render ends.
 */
export async function readableContent(
  data: Buffer,
  contentType: string,
  opts: { timeBudgetMs?: number; cancelGraceMs?: number } = {},
): Promise<ReadableContent> {
  const type = baseType(contentType);
  const budget: Budget = {
    deadline: new Deadline(opts.timeBudgetMs ?? settings.timeBudgetMs),
    graceMs: opts.cancelGraceMs ?? READABLE_LIMITS.cancelGraceMs,
  };
  try {
    if (isPdf(data, type)) return await readPdf(data, budget);
    // The bytes, not the declared type, say what an image is: a JPEG served as image/png must
    // go out as image/jpeg, or the model's API rejects the whole tool result.
    const imageType = sniffImageType(data);
    if (imageType) return await readImage(data, imageType, budget);
    if (IMAGE_TYPES.has(type)) {
      const note = `The file is declared as ${type}, but its content is not a PNG, JPEG, GIF or WebP image. ${FULL_FILE}`;
      return { blocks: [textBlock(`[${note}]`)], summary: { kind: "none", note } };
    }
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
async function readImage(data: Buffer, mimeType: string, budget: Budget): Promise<ReadableContent> {
  const size = imageDimensions(data, mimeType);
  if (data.length <= READABLE_LIMITS.maxImageBytes && size && fitsBudget(size.width, size.height)) {
    return { blocks: [imageBlock(data, mimeType)], summary: { kind: "image" } };
  }
  if (!size || size.width * size.height > settings.maxDecodePixels) {
    // An unreadable header could hide any size: it is not handed to the decoder either.
    const note = size
      ? `The image is ${size.width}×${size.height} px, more than this server decodes ` +
        `(${settings.maxDecodePixels / 1_000_000} MP). ${FULL_FILE}`
      : `The image's size cannot be read from its header, so it is not decoded. ${FULL_FILE}`;
    return { blocks: [textBlock(`[${note}]`)], summary: { kind: "none", note } };
  }
  const canvas = await loadCanvas();
  if (!canvas) {
    // Unscaled, but only within what the model's API accepts at all (8000 px a side).
    if (data.length <= READABLE_LIMITS.maxImageBytes && Math.max(size.width, size.height) <= 8000) {
      const note = `Returned at its original size: it could not be downscaled. ${NO_CANVAS_NOTE}`;
      return { blocks: [imageBlock(data, mimeType), textBlock(`[${note}]`)], summary: { kind: "image", note } };
    }
    const note = `The image (${data.length} bytes) is too large to return inline. ${NO_CANVAS_NOTE}`;
    return { blocks: [textBlock(`[${note}]`)], summary: { kind: "none", note } };
  }
  const downscale = async () => {
    const image = await canvas.loadImage(data);
    try {
      return await drawDownscaled(image);
    } finally {
      release(image);
    }
  };
  const drawDownscaled = async (image: InstanceType<Canvas["Image"]>) => {
    if (isTall(image.width, image.height)) {
      const scale = Math.min(1, tiledScale(image.width, image.height));
      const width = Math.max(1, Math.floor(image.width * scale));
      const height = Math.max(1, Math.floor(image.height * scale));
      const note =
        `A tall image (${image.width}×${image.height}), split into two overlapping images ${width} px wide, ` +
        "top half first, to keep it legible.";
      return { blocks: await splitTall(canvas, image, width, height, true), summary: { kind: "image" as const, note } };
    }
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
  // A decode cannot be interrupted: on a timeout the call answers, and a large image keeps its
  // slot until the decode has finished (at most the grace period), so it stays counted.
  const heavy = size.width * size.height >= READABLE_LIMITS.heavyImagePixels;
  try {
    return await runWithin(downscale, { ...budget, slots: heavy ? renderSlots : undefined });
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    const note =
      err.reason === "busy"
        ? `The server was busy with other files and could not downscale this image in time. Try again. ${FULL_FILE}`
        : `The image could not be downscaled in time. ${FULL_FILE}`;
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
  /** Its layout was measured (otherwise it was judged by its text alone). */
  checked: boolean;
  /** It holds an image over the decode limit, which pdf.js leaves out of the render. */
  oversized: boolean;
  /** The page image is in the response. */
  attached: boolean;
  /** A tall page goes out as two images (top and bottom half). */
  tiles?: number;
  /** Why its layout or image failed, when it did (other pages are unaffected). */
  failed?: string;
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
  file: { hasImages: boolean },
  layout?: PageLayout,
  view: number[] = [0, 0, 595, 842],
): RenderReason | undefined {
  const visible = Math.max(0, page.chars - (layout?.invisibleChars ?? 0));
  if (visible < READABLE_LIMITS.minPageChars) return "no-text";
  if (sparseText(visible, view)) {
    // Unmeasured (past the page-image cap, or out of time), little text in a file that has
    // images is assumed to be a scan: treating a scan as text loses the receipt, treating a
    // short born-digital page as a scan only costs attaching the raw file.
    if (!layout && file.hasImages) return "scan";
    const pictorial =
      layout !== undefined &&
      (layout.imageCoverage >= READABLE_LIMITS.scanMinImageCoverage || layout.pathOps >= READABLE_LIMITS.scanMinPathOps);
    if (pictorial) return "scan";
  }
  if (page.undecodable > 0) return "undecodable";
  return undefined;
}

/** At most scanMaxChars visible characters per A4 of page area. */
function sparseText(visible: number, view: number[]): boolean {
  const area = Math.abs((view[2]! - view[0]!) * (view[3]! - view[1]!));
  return visible <= READABLE_LIMITS.scanMaxChars * Math.max(1, area / A4_AREA);
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
  const tall = pdfPages.filter((p) => p.tiles === 2).map((p) => p.n);
  if (tall.length > 0) {
    const p = pages(tall);
    notes.push(
      `${p.label} ${p.is} very tall (e.g. a till receipt) and ${p.is} attached as two overlapping images each, ` +
        "top half first.",
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
 * Free a decoded image's pixels now. @napi-rs/canvas keeps them until V8 collects the object,
 * which it does not hurry to do (it cannot see native memory): the next heavy render would
 * start on top of a 48 MP bitmap nobody uses. An empty `src` releases it at once.
 */
function release(image: InstanceType<Canvas["Image"]>): void {
  try {
    image.src = Buffer.alloc(0);
  } catch {
    // Already released, or a canvas build without this behaviour: the GC will get to it.
  }
}

/** Too tall for one image to keep a legible width: it goes out as two (see tallAspect). */
function isTall(width: number, height: number): boolean {
  return height > width * READABLE_LIMITS.tallAspect;
}

/**
 * The scale for drawing `width`×`height` as two overlapping tiles, each ⌈H/2⌉ + overlap/2
 * rows tall, with every tile within the pixel budget and the long-side cap. (Tile pixels
 * s·w·(s·h/2 + o/2) ≤ budget is a quadratic in s.)
 */
function tiledScale(width: number, height: number): number {
  const half = READABLE_LIMITS.tileOverlap / 2;
  const bySide = (2 * (READABLE_LIMITS.maxImageSide - half - 1)) / height;
  const a = (width * height) / 2;
  const b = half * width;
  const byPixels = (-b + Math.sqrt(b * b + 4 * a * READABLE_LIMITS.maxImagePixels)) / (2 * a);
  return Math.min(bySide, byPixels * 0.999);
}

/**
 * `image` drawn at `width`×`height` and cut into a top and a bottom tile that overlap by
 * tileOverlap rows, on white. Each is encoded on its own; together they are one page.
 */
async function splitTall(
  canvas: Canvas,
  image: InstanceType<Canvas["Image"]>,
  width: number,
  height: number,
  photo: boolean,
): Promise<ImageBlock[]> {
  const tile = Math.min(height, Math.ceil(height / 2) + READABLE_LIMITS.tileOverlap / 2);
  const blocks: ImageBlock[] = [];
  for (const top of [0, height - tile]) {
    const surface = canvas.createCanvas(width, tile);
    const ctx = surface.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, tile);
    ctx.drawImage(image, 0, -top, width, height);
    blocks.push(
      photo ? imageBlock(await surface.encode("jpeg", 85), "image/jpeg") : imageBlock(await surface.encode("png"), "image/png"),
    );
  }
  return blocks;
}

/** What the image dictionaries in a PDF say about its images (see {@link pdfImageSizes}). */
export interface PdfImageSizes {
  /** The largest image whose size could be read. */
  largest?: { width: number; height: number };
  /** Some image's size could not be read (e.g. `/Width 12 0 R`): it may be any size. */
  unknown: boolean;
}

/**
 * The image sizes in a PDF, read from the image dictionaries in the raw bytes, before pdf.js
 * decodes anything. An image XObject is a stream, and a stream's dictionary is always a direct
 * object in the file body (never inside a compressed object stream), so its /Width and
 * /Height are there to read — unless they are indirect references, which make the size
 * `unknown`. An unknown size stays on record whatever else is found: a small logo next to it
 * says nothing about how large it is.
 */
export function pdfImageSizes(data: Buffer): PdfImageSizes {
  const raw = data.toString("latin1");
  const sizes: PdfImageSizes = { unknown: false };
  for (const match of raw.matchAll(/\/Subtype\s*\/Image\b/g)) {
    // The dictionary around the match: back to its "obj", forward to its "stream".
    const start = Math.max(raw.lastIndexOf(" obj", match.index), match.index - 2048, 0);
    const streamAt = raw.indexOf("stream", match.index);
    const end = Math.min(streamAt < 0 ? raw.length : streamAt, match.index + 2048);
    const dict = raw.slice(start, end);
    // \b before the lookahead: without it, "/Width 12 0 R" backtracks to read a width of 1.
    const width = /\/Width\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
    const height = /\/Height\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
    if (!width || !height) {
      sizes.unknown = true;
      continue;
    }
    const size = { width: Number(width[1]), height: Number(height[1]) };
    if (!sizes.largest || size.width * size.height > sizes.largest.width * sizes.largest.height) sizes.largest = size;
  }
  return sizes;
}

async function readPdf(data: Buffer, budget: Budget): Promise<ReadableContent> {
  const { deadline, graceMs } = budget;
  const { getDocumentProxy, getResolvedPDFJS, registerImageDecoders, renderPageAsImage } = await import("unpdf");
  // JBIG2 / JPEG 2000 decoders: scanners write those, and the layout pass decodes images.
  registerImageDecoders();
  const { largest, unknown } = pdfImageSizes(data);
  const largestPixels = largest ? largest.width * largest.height : 0;
  // An image of unknown size may be any size: the file counts as heavy.
  const heavy = unknown || largestPixels >= READABLE_LIMITS.heavyImagePixels;
  // pdf.js leaves an image over the decode limit out of the render, so its page would come out
  // blank: pages that might hold it get a layout first, and are reported instead of rendered.
  const oversized = largestPixels > settings.maxDecodePixels;
  const file = { hasImages: unknown || largest !== undefined };
  // A copy: PDF.js may take over (detach) the buffer it is handed, and the caller still
  // needs the original bytes for the embedded resource.
  const pdf = await getDocumentProxy(new Uint8Array(data), {
    verbosity: 0,
    maxImageSize: settings.maxDecodePixels,
  });
  const { OPS } = await getResolvedPDFJS();
  let stopped: BudgetExceeded | undefined;
  try {
    const pageCount = pdf.numPages;
    const readPages = Math.min(pageCount, READABLE_LIMITS.maxTextPages);
    const pdfPages: PdfPage[] = [];
    const images: ImageBlock[] = [];
    const notes: string[] = [];
    let truncated = readPages < pageCount;
    let canvasMissing = false;

    // Pass 1: the text of every page read. Cheap — no image is decoded for it — but bounded
    // too: pages it does not get to are reported as missing.
    const unread: number[] = [];
    const unreadable: { n: number; error: string }[] = [];
    for (let n = 1; n <= readPages; n++) {
      let items;
      try {
        items = (await deadline.race((async () => (await pdf.getPage(n)).getTextContent())())).items;
      } catch (err) {
        if (err instanceof BudgetExceeded) {
          stopped = err;
          for (let rest = n; rest <= readPages; rest++) unread.push(rest);
          break;
        }
        // One broken page does not cost the others their text.
        unreadable.push({ n, error: errorMessage(err) });
        continue;
      }
      const raw = items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("");
      const { text: clean, replaced } = sanitizeText(raw);
      const text = clean.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      const chars = nonWhitespaceLength(text);
      const undecodable = replaced + (raw.match(/\uFFFD/g)?.length ?? 0);
      pdfPages.push({ n, text, chars, undecodable, ocr: false, checked: false, oversized: false, attached: false });
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
      if (pdfPages.filter((p) => p.attached).length >= READABLE_LIMITS.maxRenderedPages || canvasMissing) return;
      const canvas = await loadCanvas();
      if (!canvas) {
        canvasMissing = true;
        return;
      }
      const { width, height } = page.getViewport({ scale: 1 });
      if (isTall(width, height)) {
        // A till receipt: rendered once (lossless), then cut into two overlapping halves.
        const scale = Math.min(tiledScale(width, height), READABLE_LIMITS.maxRenderDpi / 72);
        const png = await renderPageAsImage(pdf, info.n, { canvasImport: loadCanvasStrict, scale });
        const full = await canvas.loadImage(Buffer.from(png));
        try {
          images.push(...(await splitTall(canvas, full, full.width, full.height, photo)));
        } finally {
          release(full);
        }
        info.tiles = 2;
      } else {
        // Rendered once, in a format chosen up front: JPEG for a page that is mostly a picture
        // (a scan or a photo — huge as PNG), PNG for vector text (sharp and small).
        const bytes = await renderPageAsImage(pdf, info.n, {
          canvasImport: loadCanvasStrict,
          scale: renderScale(width, height),
          ...(photo ? { format: "jpeg" as const, quality: 0.8 } : {}),
        });
        images.push(imageBlock(bytes, photo ? "image/jpeg" : "image/png"));
      }
      info.attached = true;
    };
    for (const info of pdfPages) {
      const wanted = pdfPages.filter((p) => p.render).length;
      if (stopped || wanted >= READABLE_LIMITS.maxRenderedPages) {
        info.render = renderReason(info, file);
        continue;
      }
      const work = async () => {
        const page = await pdf.getPage(info.n);
        if (info.chars < READABLE_LIMITS.minPageChars && !oversized) {
          // Almost always a scan or a photo: JPEG, unless the file has no image at all.
          info.render = "no-text";
          await renderPage(page, info, file.hasImages);
        } else {
          const layout = pageLayout(await page.getOperatorList(), OPS, page.view);
          // Free what the layout pass decoded before the render decodes it again.
          page.cleanup();
          info.checked = true;
          info.ocr = info.chars > 0 && layout.invisibleChars >= info.chars / 2;
          info.render = renderReason(info, file, layout, page.view);
          const visible = Math.max(0, info.chars - layout.invisibleChars);
          if (oversized && layout.imageCoverage < READABLE_LIMITS.scanMinImageCoverage && sparseText(visible, page.view)) {
            // Little text and no large image that pdf.js kept (a logo may be left): the
            // over-limit image is this page's.
            info.oversized = true;
            info.render ??= "scan";
            return;
          }
          if (info.render) await renderPage(page, info, layout.imageCoverage >= READABLE_LIMITS.scanMinImageCoverage);
        }
        // Free the decoded images before the slot goes to the next page.
        page.cleanup();
      };
      try {
        // On a timeout, destroying the document cancels the render; runWithin answers at once
        // and keeps a heavy page's slot until the render has stopped (or the grace period ends).
        await runWithin(work, {
          ...budget,
          slots: heavy ? renderSlots : undefined,
          cancel: () => pdf.loadingTask.destroy(),
        });
      } catch (err) {
        info.render ??= renderReason(info, file);
        if (err instanceof BudgetExceeded) {
          stopped = err;
        } else {
          // A page whose layout or render fails is reported; the other pages are unaffected.
          info.failed = errorMessage(err);
        }
      }
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
    // Every page that needs an image and has none is listed, with the reason: the download
    // tools then attach the raw file whatever `output` says, since that is where its content is.
    const missing = pdfPages.filter((p) => p.render && !p.attached);
    const tooLarge = missing.filter((p) => p.oversized).map((p) => p.n);
    if (oversized && largest) {
      const sized = largest;
      notes.push(
        `The PDF contains an image of ${sized.width}×${sized.height} px, more than this server decodes ` +
          `(${settings.maxDecodePixels / 1_000_000} MP)` +
          (tooLarge.length > 0 ? `: ${pages(tooLarge).label.toLowerCase()} ${pages(tooLarge).has} no page image here.` : "."),
      );
    }
    const failed = missing.filter((p) => p.failed);
    for (const p of failed) notes.push(`Page ${p.n} could not be rendered (${p.failed}).`);
    for (const { n, error } of unreadable) notes.push(`Page ${n} could not be read (${error}).`);
    const unmade = missing.filter((p) => !p.oversized && !p.failed);
    if (unmade.length > 0) {
      const p = pages(unmade.map((page) => page.n));
      const guessed = unmade.filter((page) => !page.checked && page.render === "scan").map((page) => page.n);
      const why = canvasMissing
        ? "page images are unavailable on this server: the optional @napi-rs/canvas package is not installed"
        : stopped?.reason === "busy"
          ? "the server was busy rendering other files and ran out of time for this one"
          : stopped
            ? `rendering ran out of time (${Math.round(deadline.budgetMs / 100) / 10} s per call)`
            : `at most ${READABLE_LIMITS.maxRenderedPages} page images per call`;
      notes.push(
        `${p.label} ${p.is} not attached as an image although ${unmade.length > 1 ? "they need" : "it needs"} one (${why})` +
          (guessed.length > 0
            ? `; ${pages(guessed).label.toLowerCase()} ${pages(guessed).has} little text in a file with images and ` +
              `${pages(guessed).is} assumed to be scanned`
            : "") +
          ".",
      );
    } else if (stopped && unread.length === 0) {
      notes.push(
        stopped.reason === "busy"
          ? "The server was busy rendering other files and ran out of time for this one."
          : `Rendering ran out of time (${Math.round(deadline.budgetMs / 100) / 10} s per call).`,
      );
    }
    if (unread.length > 0) {
      notes.push(`${pages(unread).label} could not be read in time.`);
    }
    const lost = [...unread, ...unreadable.map((u) => u.n)];
    if (missing.length > 0 || lost.length > 0 || stopped) truncated = true;
    if (canvasMissing && unmade.length === 0) notes.push(NO_CANVAS_NOTE);
    if (readPages < pageCount) {
      notes.push(`Only pages 1–${readPages} of the ${pageCount}-page PDF are read. ${FULL_FILE}`);
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
        ...(missing.length > 0 || lost.length > 0
          ? { missingPageImages: [...missing.map((p) => p.n), ...lost].sort((a, b) => a - b) }
          : {}),
        ...(truncated ? { truncated } : {}),
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      },
    };
  } finally {
    // After a timeout the call answers now: pdf.js' teardown can wait on a cancelled render that
    // never settles, so it runs in the background (bounded), while runWithin keeps a heavy
    // page's slot until that render has really stopped. Otherwise it is quick: wait for it.
    const teardown = settleWithin(pdf.loadingTask.destroy(), graceMs);
    if (!stopped) await teardown;
  }
}

/** loadCanvas for unpdf, which needs the module itself (only called once it is known to load). */
async function loadCanvasStrict(): Promise<Canvas> {
  const canvas = await loadCanvas();
  if (!canvas) throw new Error(NO_CANVAS_NOTE);
  return canvas;
}
