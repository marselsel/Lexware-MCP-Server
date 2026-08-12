/**
 * Longest single path component virtually every filesystem in use accepts (ext4, XFS,
 * APFS, NTFS all stop at 255). Those limits count BYTES, this counts UTF-16 code units,
 * so a name of non-ASCII characters can still exceed 255 bytes downstream — deliberate:
 * the point of the cap is to bound what goes into a multipart field and a log line, not
 * to promise any particular filesystem will take it. Cutting at code units keeps every
 * legitimate name (an umlaut is 1 unit) untouched.
 */
const MAX_FILENAME_LENGTH = 255;

/**
 * Reduces a filename to its basename and drops path separators — this is a trust
 * boundary: the name arrives from a request header (`X-Filename` / `X-Filename-B64`) or
 * the ticket's own fallback and ends up in a multipart field, in the bookkeeping, and in
 * everything that logs it.
 *
 * Also strips C0 control characters and DEL, and only then trims. Trimming alone left
 * anything in the MIDDLE of the name intact — measured:
 * `filename*=UTF-8''evil%0D%0Ainjected.pdf` decodes to `evil\r\ninjected.pdf` and came
 * through with its CRLF, ready to forge a line in any log that writes the name out.
 * The characters are removed rather than replaced, so nothing is invented: a name that
 * consists only of them comes back `undefined` and the caller's fallback chain
 * (ticket value / `upload.bin`) picks a real name.
 *
 * Length is capped at {@link MAX_FILENAME_LENGTH} by truncation rather than rejection —
 * an over-long name is still a usable upload, just a shortened one. A truncation that
 * would split a surrogate pair drops the orphaned half instead of leaving a lone
 * surrogate that encodes as U+FFFD.
 */
export function sanitizeFilename(name: string): string | undefined {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return undefined;
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;
  const cut = cleaned.slice(0, MAX_FILENAME_LENGTH);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return (isHighSurrogate ? cut.slice(0, -1) : cut).trimEnd();
}
