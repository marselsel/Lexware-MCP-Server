import { describe, expect, it } from "vitest";
import { pageLayout } from "../src/tools/pdf-page-layout.js";

// A stand-in for pdf.js' OPS table: pageLayout only compares the numbers.
const OPS = Object.fromEntries(
  [
    "save",
    "restore",
    "transform",
    "paintFormXObjectBegin",
    "paintFormXObjectEnd",
    "beginAnnotation",
    "endAnnotation",
    "setTextRenderingMode",
    "beginGroup",
    "endGroup",
    "showText",
    "constructPath",
    "paintImageXObject",
    "paintInlineImageXObject",
    "paintImageMaskXObject",
    "paintImageXObjectRepeat",
    "paintImageMaskXObjectRepeat",
    "paintInlineImageXObjectGroup",
    "paintImageMaskXObjectGroup",
  ].map((name, i) => [name, i + 1]),
);
const A4 = [0, 0, 595, 842];

function opList(ops: [string, unknown[]][]) {
  return { fnArray: ops.map(([name]) => OPS[name]!), argsArray: ops.map(([, args]) => args) };
}

describe("pageLayout", () => {
  it("measures image coverage through nested transforms, save and restore", () => {
    const layout = pageLayout(
      opList([
        ["save", []],
        ["transform", [2, 0, 0, 2, 0, 0]],
        ["save", []],
        // 2 × (297.5 × 421) = the full A4 page.
        ["transform", [297.5, 0, 0, 421, 0, 0]],
        ["paintImageXObject", ["img_1"]],
        ["restore", []],
        ["restore", []],
      ]),
      OPS,
      A4,
    );
    expect(layout.imageCoverage).toBeCloseTo(1, 1);
  });

  it("covers only the image's part of the page, and nothing after restore", () => {
    const layout = pageLayout(
      opList([
        ["save", []],
        ["transform", [297.5, 0, 0, 421, 0, 0]], // a quarter of the page
        ["paintImageXObject", ["img_1"]],
        ["restore", []],
        ["paintImageXObject", ["img_1"]], // the unit square at the origin: 1 × 1 pt
      ]),
      OPS,
      A4,
    );
    expect(layout.imageCoverage).toBeGreaterThan(0.2);
    expect(layout.imageCoverage).toBeLessThan(0.3);
  });

  it("counts repeated images at each position", () => {
    const layout = pageLayout(
      opList([["paintImageXObjectRepeat", ["img_1", 595, 421, [0, 0, 0, 421]]]]),
      OPS,
      A4,
    );
    expect(layout.imageCoverage).toBeCloseTo(1, 1);
  });

  it("ignores images inside a soft mask", () => {
    const layout = pageLayout(
      opList([
        ["beginGroup", [{ smask: true }]],
        ["transform", [595, 0, 0, 842, 0, 0]],
        ["paintImageXObject", ["img_1"]],
        ["endGroup", []],
      ]),
      OPS,
      A4,
    );
    expect(layout.imageCoverage).toBe(0);
  });

  it("separates invisible (OCR) text from visible glyphs, and counts path operations", () => {
    const glyphs = (s: string) => Array.from(s, (unicode) => ({ unicode, isSpace: unicode === " " }));
    const layout = pageLayout(
      opList([
        ["showText", [glyphs("Total 119,00")]],
        ["save", []],
        ["setTextRenderingMode", [3]],
        ["showText", [[...glyphs("OCR text"), -120]]],
        ["restore", []],
        ["showText", [glyphs("EUR")]],
        ["constructPath", []],
        ["constructPath", []],
      ]),
      OPS,
      A4,
    );
    expect(layout).toMatchObject({ invisibleChars: 7, visibleGlyphs: 14, pathOps: 2 });
  });
});
