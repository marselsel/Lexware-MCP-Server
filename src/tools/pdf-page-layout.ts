/**
 * What a PDF page is made of, read from its pdf.js operator list: how much of the page images
 * cover, how much text is drawn invisibly (an OCR layer over a scan), and how much vector
 * drawing there is. The text layer alone cannot tell a scan from a born-digital page: a scan
 * often carries one real line of text ("Scanned with CamScanner", an inbox stamp, a page
 * number), and an OCR'd scan carries a whole page of text nobody can see.
 *
 * Independent of pdf.js' types on purpose: the operator list is plain arrays, and the OPS
 * table is passed in, so this stays testable without loading a document.
 */

/** The parts of a pdf.js operator list this reads. */
export interface OperatorList {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

export interface PageLayout {
  /** Fraction of the page (0–1) that images cover, measured on a coarse grid. */
  imageCoverage: number;
  /** Non-whitespace characters drawn invisibly (text render mode 3 or 7): an OCR text layer. */
  invisibleChars: number;
  /** Path-construction operations: table rules and logos, or text converted to outlines. */
  pathOps: number;
}

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `inner` applied first, then `outer` — how `cm` concatenates onto the current matrix. */
function multiply(outer: Matrix, inner: ArrayLike<number>): Matrix {
  const [a, b, c, d, e, f] = outer;
  const [a2, b2, c2, d2, e2, f2] = [inner[0]!, inner[1]!, inner[2]!, inner[3]!, inner[4]!, inner[5]!];
  return [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The axis-aligned box around the unit square (where PDF images are drawn) under `m`. */
function unitSquareBox(m: Matrix): Box {
  const [a, b, c, d, e, f] = m;
  const xs = [e, a + e, c + e, a + c + e];
  const ys = [f, b + f, d + f, b + d + f];
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Grid cells per side for the coverage estimate: coarse, but exact enough to tell 5 % from 50 %. */
const GRID = 48;

/** Fraction of `view` ([x0, y0, x1, y1]) the union of `boxes` covers, on a GRID×GRID raster. */
function coverage(boxes: Box[], view: ArrayLike<number>): number {
  const [vx0, vy0, vx1, vy1] = [view[0]!, view[1]!, view[2]!, view[3]!];
  const w = vx1 - vx0;
  const h = vy1 - vy0;
  if (boxes.length === 0 || w <= 0 || h <= 0) return 0;
  const covered = new Uint8Array(GRID * GRID);
  for (const box of boxes) {
    // Cells whose centre lies inside the box.
    const cx0 = Math.max(0, Math.ceil(((box.x0 - vx0) / w) * GRID - 0.5));
    const cx1 = Math.min(GRID - 1, Math.floor(((box.x1 - vx0) / w) * GRID - 0.5));
    const cy0 = Math.max(0, Math.ceil(((box.y0 - vy0) / h) * GRID - 0.5));
    const cy1 = Math.min(GRID - 1, Math.floor(((box.y1 - vy0) / h) * GRID - 0.5));
    for (let y = cy0; y <= cy1; y++) covered.fill(1, y * GRID + cx0, y * GRID + cx1 + 1);
  }
  let n = 0;
  for (const cell of covered) n += cell;
  return n / (GRID * GRID);
}

/** Characters in `s` that are not whitespace, counted as code points. */
export function nonWhitespaceLength(s: string): number {
  return Array.from(s.replace(/\s/g, "")).length;
}

/**
 * Walk an operator list in painting order, tracking the current transform and text render
 * mode, and measure the page's images, invisible text and vector drawing. Content inside a
 * soft mask only modulates transparency and is skipped.
 */
export function pageLayout(opList: OperatorList, OPS: Record<string, number>, view: ArrayLike<number>): PageLayout {
  type State = { m: Matrix; textMode: number };
  let state: State = { m: IDENTITY, textMode: 0 };
  const stack: State[] = [];
  const softMask: boolean[] = [];
  const boxes: Box[] = [];
  let invisibleChars = 0;
  let pathOps = 0;

  const image = (m: Matrix) => {
    if (!softMask.includes(true)) boxes.push(unitSquareBox(m));
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i]!;
    const args = (opList.argsArray[i] ?? []) as unknown[];
    switch (fn) {
      case OPS.save:
        stack.push(state);
        break;
      case OPS.restore:
      case OPS.paintFormXObjectEnd:
      case OPS.endAnnotation:
        state = stack.pop() ?? state;
        break;
      case OPS.transform:
        state = { ...state, m: multiply(state.m, args as number[]) };
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(state);
        const matrix = args[0] as number[] | null | undefined;
        if (matrix) state = { ...state, m: multiply(state.m, matrix) };
        break;
      }
      case OPS.beginAnnotation: {
        // Annotations (stamps, form fields) are drawn in page space, not in the current state.
        stack.push(state);
        const [, , transform, matrix] = args as [unknown, unknown, number[], number[]];
        state = { m: multiply(Array.from(transform ?? IDENTITY) as unknown as Matrix, matrix ?? IDENTITY), textMode: 0 };
        break;
      }
      case OPS.setTextRenderingMode:
        state = { ...state, textMode: Number(args[0]) };
        break;
      case OPS.beginGroup:
        softMask.push(Boolean((args[0] as { smask?: unknown } | undefined)?.smask));
        break;
      case OPS.endGroup:
        softMask.pop();
        break;
      case OPS.showText:
        if (state.textMode === 3 || state.textMode === 7) {
          for (const glyph of (args[0] ?? []) as unknown[]) {
            if (typeof glyph !== "object" || glyph === null) continue; // a number is spacing
            const unicode = (glyph as { unicode?: unknown }).unicode;
            if (typeof unicode === "string") invisibleChars += nonWhitespaceLength(unicode);
          }
        }
        break;
      case OPS.constructPath:
        pathOps++;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
        image(state.m);
        break;
      case OPS.paintImageXObjectRepeat: {
        // [objId, scaleX, scaleY, positions]: one image drawn at many positions.
        const [, sx, sy, positions] = args as [unknown, number, number, ArrayLike<number>];
        for (let p = 0; p + 1 < (positions?.length ?? 0); p += 2) {
          image(multiply(state.m, [sx, 0, 0, sy, positions[p]!, positions[p + 1]!]));
        }
        break;
      }
      case OPS.paintImageMaskXObjectRepeat: {
        // [image, scaleX, skewX, skewY, scaleY, positions]
        const [, sx, kx, ky, sy, positions] = args as [unknown, number, number, number, number, ArrayLike<number>];
        for (let p = 0; p + 1 < (positions?.length ?? 0); p += 2) {
          image(multiply(state.m, [sx, kx, ky, sy, positions[p]!, positions[p + 1]!]));
        }
        break;
      }
      case OPS.paintInlineImageXObjectGroup: {
        // [imgData, map]: many small inline images merged; each entry keeps its own transform.
        for (const entry of (args[1] ?? []) as { transform?: number[] }[]) {
          if (entry?.transform) image(multiply(state.m, entry.transform));
        }
        break;
      }
      case OPS.paintImageMaskXObjectGroup: {
        for (const entry of (args[0] ?? []) as { transform?: number[] }[]) {
          if (entry?.transform) image(multiply(state.m, entry.transform));
        }
        break;
      }
      default:
        break;
    }
  }

  return { imageCoverage: coverage(boxes, view), invisibleChars, pathOps };
}
