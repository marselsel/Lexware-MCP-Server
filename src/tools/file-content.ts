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
 *   - PDF pages without text      → rendered to an image (a scan, a photo saved as PDF)
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
  /** A page with fewer non-whitespace characters than this counts as having no text layer. */
  minPageChars: 20,
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

function textBlock(text: string): TextBlock {
  return { type: "text", text };
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
  const { text, truncated } = cap(data.toString("utf8"), READABLE_LIMITS.maxTextChars);
  const blocks = [textBlock(text)];
  if (truncated) blocks.push(textBlock(truncationNote()));
  return { blocks, summary: { kind: "text", truncated } };
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

async function readPdf(data: Buffer): Promise<ReadableContent> {
  const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
  // A copy: PDF.js may take over (detach) the buffer it is handed, and the caller still
  // needs the original bytes for the embedded resource.
  const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
  try {
    const pageCount = pdf.numPages;
    const readPages = Math.min(pageCount, READABLE_LIMITS.maxTextPages);
    const pageTexts: string[] = [];
    for (let n = 1; n <= readPages; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      pageTexts.push(
        content.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
          .join("")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      );
    }

    const textPages: number[] = [];
    const textless: number[] = [];
    pageTexts.forEach((t, i) => {
      (t.replace(/\s/g, "").length >= READABLE_LIMITS.minPageChars ? textPages : textless).push(i + 1);
    });

    const blocks: ReadableBlock[] = [];
    let truncated = readPages < pageCount;
    const notes: string[] = [];

    if (textPages.length > 0) {
      const sections = textPages.map((n) => `--- Page ${n} of ${pageCount} ---\n${pageTexts[n - 1]}`);
      const capped = cap(`Extracted PDF text:\n\n${sections.join("\n\n")}`, READABLE_LIMITS.maxTextChars);
      blocks.push(textBlock(capped.text));
      if (capped.truncated) {
        truncated = true;
        blocks.push(textBlock(truncationNote()));
      }
    }

    // Pages without a text layer are scans or photos: render them so the model can look.
    const toRender = textless.slice(0, READABLE_LIMITS.maxRenderedPages);
    const renderedPages: number[] = [];
    if (toRender.length > 0) {
      const canvas = await loadCanvas();
      if (!canvas) {
        notes.push(NO_CANVAS_NOTE);
      } else {
        for (const n of toRender) {
          const page = await pdf.getPage(n);
          const { width, height } = page.getViewport({ scale: 1 });
          const scale = Math.min(READABLE_LIMITS.maxImageSide / Math.max(width, height), 3);
          const png = await renderPageAsImage(pdf, n, { canvasImport: loadCanvasStrict, scale });
          if (png.length <= READABLE_LIMITS.maxPngBytes) {
            blocks.push(imageBlock(png, "image/png"));
          } else {
            const jpeg = await renderPageAsImage(pdf, n, { canvasImport: loadCanvasStrict, scale, format: "jpeg", quality: 0.85 });
            blocks.push(imageBlock(jpeg, "image/jpeg"));
          }
          renderedPages.push(n);
        }
        if (textless.length > toRender.length) truncated = true;
      }
    }

    if (truncated) {
      notes.push(
        `Only part of the ${pageCount}-page PDF is shown here (text of pages 1–${readPages}, ` +
          `at most ${READABLE_LIMITS.maxRenderedPages} page images). The full file is in the embedded resource.`,
      );
    }
    if (blocks.length === 0 && notes.length === 0) notes.push("The PDF has no extractable text.");
    if (renderedPages.length > 0) {
      notes.unshift(
        `Page${renderedPages.length > 1 ? "s" : ""} ${renderedPages.join(", ")} ha${renderedPages.length > 1 ? "ve" : "s"} ` +
          `little or no text layer (scanned or photographed) and ${renderedPages.length > 1 ? "are" : "is"} attached as an image.`,
      );
    }
    for (const note of notes) blocks.push(textBlock(`[${note}]`));

    const kind =
      textPages.length > 0 && renderedPages.length > 0
        ? "text+image"
        : textPages.length > 0
          ? "text"
          : renderedPages.length > 0
            ? "image"
            : "none";
    return {
      blocks,
      summary: {
        kind,
        pageCount,
        textPages,
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
