import { describe, expect, it, vi } from "vitest";
import type { ReadableContent } from "../src/tools/file-content.js";

// binaryResult's rule for the raw file, with the readable form fixed: whatever `output` and
// the size cap say, a readable form that misses content keeps the raw file attached. In its
// own file, because it mocks readableContent for every test here.
const readable = vi.hoisted(() => ({ value: undefined as unknown as ReadableContent }));
vi.mock("../src/tools/file-content.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/file-content.js")>()),
  readableContent: async () => readable.value,
}));
const { AUTO_RESOURCE_MAX_BYTES, INCOMPLETE_RESOURCE_MAX_BYTES } = await import("../src/tools/file-content.js");
const { binaryResult } = await import("../src/tools/shared.js");

const call = (data: Buffer, output: "auto" | "readable") =>
  binaryResult({ uri: "lexware://files/f1", data, contentType: "application/pdf", structuredContent: {}, message: "m", output });
const stamp: ReadableContent = {
  blocks: [{ type: "text", text: "Extracted PDF text:\n\n--- Page 1 of 1 ---\nScanned with CamScanner" }],
  summary: { kind: "text", pageCount: 1, textPages: [1], renderedPages: [], missingPageImages: [1], truncated: true },
};

describe("binaryResult with pages missing from the readable form", () => {
  it.each(["readable", "auto"] as const)('keeps the raw file in "%s", even above the auto size cap, and says why', async (output) => {
    readable.value = stamp;
    const data = Buffer.alloc(AUTO_RESOURCE_MAX_BYTES + 1, 0x20);
    const res = await call(data, output);
    expect(res.content.at(-1)).toMatchObject({ type: "resource", resource: { blob: data.toString("base64") } });
    expect(res.content.at(-2)).toEqual({
      type: "text",
      text: "[The original file is attached as an embedded resource, because page 1 is not in the readable form above.]",
    });
    expect(res.structuredContent).not.toHaveProperty("resourceOmitted");
  });

  it.each(["readable", "auto"] as const)('caps it at INCOMPLETE_RESOURCE_MAX_BYTES in "%s", with a note', async (output) => {
    readable.value = stamp;
    const atCap = await call(Buffer.alloc(INCOMPLETE_RESOURCE_MAX_BYTES, 0x20), output);
    expect(atCap.content.at(-1)).toMatchObject({ type: "resource" });

    const big = Buffer.alloc(INCOMPLETE_RESOURCE_MAX_BYTES + 1, 0x20);
    const res = await call(big, output);
    expect(res.content.map((c) => c.type)).not.toContain("resource");
    expect(res.content.at(-1)).toEqual({
      type: "text",
      text:
        "[The original file (5.0 MB) is not attached although page 1 is not in the readable form above: files over " +
        '5 MB are only sent with output="resource". Call again with output="resource" to get it.]',
    });
    expect(res.structuredContent).toMatchObject({ resourceOmitted: true });
  });

  it("drops it in readable mode when nothing is missing", async () => {
    readable.value = { ...stamp, summary: { ...stamp.summary, missingPageImages: undefined } };
    const res = await call(Buffer.from("%PDF-1.7"), "readable");
    expect(res.content.map((c) => c.type)).toEqual(["text", "text"]);
  });
});
