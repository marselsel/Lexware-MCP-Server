/**
 * Tiny, hand-built PDFs for the readable-content tests, so no binary fixtures live in the
 * repo. Each page is A4 (595×842 pt); offsets in the xref table are computed, not guessed.
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
  | { lines?: string[]; image?: true | [number, number, number, number]; invisible?: boolean; font?: "nul-hyphen" };

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

/** A PDF with the given pages (see {@link FixturePage}), A4 each. */
export function fixturePdf(pages: FixturePage[]): Buffer {
  // 1 catalog, 2 pages, 3 font, 4 the scan image, 5 the NUL-hyphen font, 6 its ToUnicode,
  // then (page, content) pairs.
  const pageIds = pages.map((_, i) => 7 + i * 2);
  const objects: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("/Type /XObject /Subtype /Image /Width 40 /Height 40 /ColorSpace /DeviceRGB /BitsPerComponent 8", scanPixels(40, 40)),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>",
    stream("", NUL_HYPHEN_CMAP),
  ];
  pages.forEach((p, i) => {
    const page = p === "scan" ? { image: true as const } : Array.isArray(p) ? { lines: p } : p;
    const [x, y, w, h] = page.image === true ? [0, 0, 595, 842] : (page.image ?? [0, 0, 0, 0]);
    const font = page.font === "nul-hyphen" ? "/F2" : "/F1";
    const ops = [
      page.image ? `q ${w} 0 0 ${h} ${x} ${y} cm /Im1 Do Q` : "",
      ...(page.lines ?? []).map(
        (l, j) => `BT ${page.invisible ? "3 Tr " : ""}${font} 12 Tf 50 ${780 - j * 18} Td (${lit(l)}) Tj ET`,
      ),
    ].filter(Boolean);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 3 0 R /F2 5 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`,
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
