import { deflateSync } from "node:zlib";

/**
 * Tiny, hand-built PDFs for the readable-content tests, so no binary fixtures live in the
 * repo. Pages are A4 (595×842 pt) unless sized; offsets in the xref table are computed, not guessed.
 */

function buildPdf(objects: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      typeof body === "string" ? Buffer.from(body, "latin1") : body,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

function stream(dict: string, data: Buffer | string): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data, "latin1") : data;
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${bytes.length} >>\nstream\n`),
    bytes,
    Buffer.from("\nendstream"),
  ]);
}

/** Escape a string for a PDF literal. */
function lit(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * A fixture page. Shorthands: a string array is a born-digital page of text lines; "scan" is a
 * page that is only an image. The object form combines them:
 *   - `lines` drawn as text (`invisible`: in render mode 3, like a scanner's OCR layer)
 *   - `image`: the page is covered by the scan image, or only the box [x, y, w, h] in points
 *   - `font: "nul-hyphen"`: a font whose ToUnicode CMap maps "-" to U+0000, as Stripe's
 *     invoice PDFs do for the hyphen, minus sign and dash
 */
export type FixturePage =
  | string[]
  | "scan"
  | {
      lines?: string[];
      image?: true | [number, number, number, number];
      invisible?: boolean;
      font?: "nul-hyphen";
      /** Which image: the small 40×40 scan (default), a 2000×1000 one (a "heavy" file), or an
       * image whose dictionary claims 9000×6000 px (over the decode limit). */
      imageKind?: "small" | "heavy" | "oversized";
      /** Page size in points (default A4). */
      size?: [number, number];
    };

/** A grey checkerboard, standing in for a scanned receipt. */
function scanPixels(w: number, h: number): Buffer {
  const pixels = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      pixels.fill((x + y) % 2 === 0 ? 30 : 220, (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
  }
  return pixels;
}

/** ToUnicode for a simple font: printable ASCII to itself, except "-" (0x2D) to U+0000. */
const NUL_HYPHEN_CMAP = [
  "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
  "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
  "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
  "1 begincodespacerange <00> <FF> endcodespacerange",
  "2 beginbfrange <20> <2C> <0020> <2E> <7E> <002E> endbfrange",
  "1 beginbfchar <2D> <0000> endbfchar",
  "endcmap CMapName currentdict /CMap defineresource pop end end",
].join("\n");

/** A PDF with the given pages (see {@link FixturePage}). */
export function fixturePdf(pages: FixturePage[]): Buffer {
  // 1 catalog, 2 pages, 3 font, 4 the scan image, 5 the NUL-hyphen font, 6 its ToUnicode,
  // 7 the heavy image, 8 the oversized image, then (page, content) pairs.
  const pageIds = pages.map((_, i) => 9 + i * 2);
  const imageOf = (p: FixturePage) => (p === "scan" ? "small" : Array.isArray(p) || !p.image ? undefined : (p.imageKind ?? "small"));
  const uses = (kind: "small" | "heavy" | "oversized") => pages.some((p) => imageOf(p) === kind);
  const objects: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    uses("small")
      ? stream("/Type /XObject /Subtype /Image /Width 40 /Height 40 /ColorSpace /DeviceRGB /BitsPerComponent 8", scanPixels(40, 40))
      : "null",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>",
    stream("", NUL_HYPHEN_CMAP),
    // The large images only when a page draws them: the server reads image sizes from the raw file.
    uses("heavy")
      ? stream(
          "/Type /XObject /Subtype /Image /Width 2000 /Height 1000 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode",
          deflateSync(Buffer.alloc(2000 * 1000, 200)),
        )
      : "null",
    // Only the dictionary matters: pdf.js skips an image over its maxImageSize before reading it.
    uses("oversized")
      ? stream("/Type /XObject /Subtype /Image /Width 9000 /Height 6000 /ColorSpace /DeviceGray /BitsPerComponent 8", Buffer.alloc(16))
      : "null",
  ];
  pages.forEach((p, i) => {
    const page = p === "scan" ? { image: true as const } : Array.isArray(p) ? { lines: p } : p;
    const [pw, ph] = "size" in page && page.size ? page.size : [595, 842];
    const [x, y, w, h] = page.image === true ? [0, 0, pw, ph] : (page.image ?? [0, 0, 0, 0]);
    const font = page.font === "nul-hyphen" ? "/F2" : "/F1";
    const im = { small: "/Im1", heavy: "/Im2", oversized: "/Im3" }[("imageKind" in page && page.imageKind) || "small"];
    const ops = [
      page.image ? `q ${w} 0 0 ${h} ${x} ${y} cm ${im} Do Q` : "",
      ...(page.lines ?? []).map(
        (l, j) => `BT ${page.invisible ? "3 Tr " : ""}${font} 12 Tf 50 ${780 - j * 18} Td (${lit(l)}) Tj ET`,
      ),
    ].filter(Boolean);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 5 0 R >> /XObject << /Im1 4 0 R /Im2 7 0 R /Im3 8 0 R >> >> ` +
        `/Contents ${pageIds[i]! + 1} 0 R >>`,
      stream("", ops.join("\n")),
    );
  });
  return buildPdf(objects);
}

/** A born-digital PDF: one page per entry, each line drawn as real (extractable) text. */
export function textPdf(pages: string[][]): Buffer {
  return fixturePdf(pages);
}

/** A "scanned" PDF: one page that is only an image, with no text at all. */
export function imageOnlyPdf(): Buffer {
  return fixturePdf(["scan"]);
}

/** A 1×1 PNG. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
