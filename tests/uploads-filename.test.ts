import { describe, expect, it } from "vitest";
import { sanitizeFilename } from "../src/uploads/filename.js";

describe("sanitizeFilename", () => {
  it("removes C0 control characters and DEL wherever they sit, not only at the ends", () => {
    expect(sanitizeFilename("evil\r\ninjected.pdf")).toBe("evilinjected.pdf");
    expect(sanitizeFilename("beleg\u0000.pdf")).toBe("beleg.pdf");
    expect(sanitizeFilename("beleg\u007f.pdf")).toBe("beleg.pdf");
    expect(sanitizeFilename("\u001bBeleg.pdf")).toBe("Beleg.pdf");
    for (const name of ["a\r\nb.pdf", "a\tb.pdf", "a\u0000b.pdf", "\u007f.pdf"]) {
      expect(sanitizeFilename(name)).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });

  it("returns undefined when nothing usable is left, so the caller's fallback applies", () => {
    expect(sanitizeFilename("\u0000")).toBeUndefined();
    expect(sanitizeFilename("\r\n\t")).toBeUndefined();
    expect(sanitizeFilename("\u0000\u007f")).toBeUndefined();
    expect(sanitizeFilename("   ")).toBeUndefined();
    expect(sanitizeFilename("")).toBeUndefined();
  });

  it("caps an over-long name at 255 without splitting a surrogate pair", () => {
    const long = `${"a".repeat(400)}.pdf`;
    const capped = sanitizeFilename(long) as string;
    expect(capped).toHaveLength(255);
    expect(capped).toBe("a".repeat(255));

    // Cut exactly between the two halves of an emoji: the orphaned half must go too,
    // or it encodes as U+FFFD downstream.
    const emojiAtTheCut = `${"a".repeat(254)}🧾tail.pdf`;
    const cut = sanitizeFilename(emojiAtTheCut) as string;
    expect(cut).toBe("a".repeat(254));
    expect(cut).not.toMatch(/[\ud800-\udfff]/);
    expect(Buffer.from(cut, "utf8").toString("utf8")).toBe(cut); // no U+FFFD on the way out
  });

  it("leaves legitimate non-ASCII names completely intact", () => {
    // The counterpart to the stripping above: umlauts, an en dash and an emoji are
    // ordinary filename characters and must survive byte for byte.
    for (const name of [
      "Rechnung Müller.pdf",
      "Beleg – Januar 2026.pdf",
      "Rechnung „Mai“.pdf",
      "Quittung 🧾.pdf",
      "100% Rabatt.pdf",
      "Rechnung, Mai 2026.pdf",
    ]) {
      expect(sanitizeFilename(name)).toBe(name);
    }
    // And the pre-existing behaviour is unchanged.
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("  beleg.pdf  ")).toBe("beleg.pdf");
  });
});
