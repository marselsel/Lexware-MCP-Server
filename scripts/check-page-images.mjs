// Checks that page images work in a built server: @napi-rs/canvas (an optional dependency with
// a native binary) loads, and a PDF page renders through the server's own code path. CI runs it
// inside the Docker image; it also works on a checkout after `npm run build`:
//
//   docker run --rm -v "$PWD/scripts:/checks:ro" lexware-mcp:ci node /checks/check-page-images.mjs
//   node scripts/check-page-images.mjs
//
// Exits non-zero, with the reason, when either fails.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { checkPageImages, readableContent } = await import(pathToFileURL(resolve("dist/tools/file-content.js")).href);

if (!(await checkPageImages())) {
  console.error("FAIL: @napi-rs/canvas does not load, so scanned receipts cannot be rendered.");
  process.exit(1);
}

// A one-page PDF drawn with vector paths only — no text layer, so it must come back as an image.
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >>",
];
const content = "0 0 0.6 rg 20 20 160 260 re f 1 1 1 rg 40 40 120 30 re f";
objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
let pdf = "%PDF-1.4\n";
const offsets = objects.map((body, i) => {
  const at = pdf.length;
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  return at;
});
const xref = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const { blocks, summary } = await readableContent(Buffer.from(pdf, "latin1"), "application/pdf");
const image = blocks.find((b) => b.type === "image");
if (!image || summary.renderedPages?.[0] !== 1) {
  console.error(`FAIL: the page was not rendered: ${JSON.stringify(summary)}`);
  process.exit(1);
}
const bytes = Buffer.from(image.data, "base64");
console.log(`OK: @napi-rs/canvas loads; page 1 rendered as ${image.mimeType}, ${bytes.length} bytes.`);
