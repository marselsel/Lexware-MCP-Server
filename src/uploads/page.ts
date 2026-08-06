/**
 * The browser-side filename encoder, kept as its own exported source string for
 * two reasons: it is the only non-trivial logic on the page, and holding it here
 * lets the test suite evaluate the EXACT code the browser runs instead of a
 * hand-copied twin that could drift.
 *
 * Why it exists: `fetch()` rejects any header value containing a character above
 * U+00FF with a TypeError raised BEFORE the request is sent — so `X-Filename:
 * file.name` broke the whole upload for entirely ordinary German filenames like
 * `Beleg – Januar 2026.pdf` (en dash, U+2013) or `Rechnung „Mai“.pdf`, and the
 * page could only show the raw TypeError. base64url of the UTF-8 bytes is pure
 * ASCII, so it always survives the header layer; the server decodes it (see
 * `decodeFilenameB64` in routes.ts).
 *
 * `btoa` takes a "binary string" — one char per byte — so the UTF-8 bytes are
 * widened one at a time rather than via `String.fromCharCode(...bytes)`, whose
 * spread would blow the argument limit on a pathologically long name.
 */
export const FILENAME_B64_SOURCE = `function filenameB64(name) {
    const bytes = new TextEncoder().encode(name);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }`;

/**
 * Minimal drag-and-drop page for the browser path. Deliberately dependency-free
 * and self-contained: it posts the raw File body to its own URL and shows the
 * resulting Lexware file id, which the model then reads via get-upload-result.
 */
export function uploadPageHtml(ticket: string): string {
  const safe = ticket.replace(/[^A-Za-z0-9_-]/g, "");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Upload a file to Lexware Office</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; }
  #drop { border: 2px dashed #999; border-radius: .5rem; padding: 3rem 1rem; text-align: center; cursor: pointer; }
  #drop.over { border-color: #333; background: #f4f4f4; }
  #out { margin-top: 1.5rem; white-space: pre-wrap; }
  code { background: #f0f0f0; padding: .1rem .3rem; border-radius: .2rem; }
</style>
<h1>Upload a file to Lexware Office</h1>
<p>The file goes straight to this server and on to Lexware. It never passes through the model context.</p>
<div id="drop" data-ticket="${safe}">Drop a file here, or click to choose one</div>
<p style="color:#666;font-size:.85em">Ticket <code>${safe}</code> &middot; valid for 15 minutes, single use.</p>
<input id="file" type="file" hidden>
<div id="out"></div>
<script>
  const drop = document.getElementById("drop");
  const input = document.getElementById("file");
  const out = document.getElementById("out");
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); send(e.dataTransfer.files[0]); });
  input.addEventListener("change", () => send(input.files[0]));
  ${FILENAME_B64_SOURCE}
  async function send(file) {
    if (!file) return;
    out.textContent = "Uploading \\u2026";
    try {
      // X-Filename-B64 only, never X-Filename: the raw name is exactly what
      // fetch() refuses for any character above U+00FF (en dash, typographic
      // quotes, emoji), and it would throw here before the request is sent.
      const res = await fetch(location.pathname, {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Filename-B64": filenameB64(file.name),
        },
        body: file,
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        // DOM nodes, never an HTML-string assignment — the same rule the error path
        // below follows. body.fileId is whatever the Lexware API returned, i.e. a value
        // from outside this server's trust boundary; built as a text node it still
        // renders inside <code>, but nothing in it can ever be parsed as markup.
        const id = document.createElement("code");
        id.textContent = body.fileId == null ? "" : String(body.fileId);
        const tool = document.createElement("code");
        tool.textContent = "get-upload-result";
        out.replaceChildren(
          "Done. Lexware file id: ",
          id,
          document.createElement("br"),
          "The model can now pick it up with ",
          tool,
          ".",
        );
      } else {
        // textContent, never an HTML-string assignment: body.error can carry ~2000 chars of raw
        // upstream response text, which must render as literal text, not markup.
        out.textContent = "Failed (HTTP " + res.status + "): " + (body.error || "");
      }
    } catch (err) {
      out.textContent = "Failed: " + err;
    }
  }
</script>
</html>`;
}
