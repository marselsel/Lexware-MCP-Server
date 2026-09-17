/**
 * Encoding for Lexware's search-filter values.
 *
 * Lexware requires `&`, `<` and `>` to be HTML-encoded *in addition to* the ordinary
 * URL encoding, in the search filters of the contacts, vouchers and voucherlist
 * endpoints. Their documented example: searching for `johnson & partner` must go out as
 *
 *     name=johnson%20%26amp%3B%20partner        (i.e. the value "johnson &amp; partner")
 *
 * and NOT as `name=johnson%20%26%20partner`, which is what a plain URL encoder produces.
 * `URLSearchParams` does the URL half; this function does the HTML half, so the two
 * compose into the form above.
 *
 * Verified against the live API with a contact named `ZZZ Encoding Test & Co (...)`:
 *
 *     control, no special character        -> 1 match
 *     plain `&`   (URL encoding only)      -> 0 matches   <- what we used to send
 *     `&amp;`     (HTML + URL encoding)    -> 1 match
 *
 * So a contact whose name contains an ampersand was simply unfindable. The failure is
 * silent, which is the worst part: an empty result set reads as "no such contact"
 * rather than as an encoding problem.
 *
 * This applies ONLY to the documented search filters. It must not be applied to ids,
 * dates, enum values or `sort`, which are not search strings and are documented to
 * break under this encoding ("other endpoints will not yield the expected results when
 * this encoding is used").
 */

/** The three characters Lexware wants HTML-encoded, and nothing else. */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/**
 * HTML-encode a search-filter value for Lexware. Returns the value unchanged when it
 * holds none of the three characters, which is the overwhelmingly common case.
 *
 * A single regex pass, deliberately: the replacements themselves contain `&`, so a
 * naive sequence of `replace` calls would re-encode its own output (`&` -> `&amp;` ->
 * `&amp;amp;`). One pass never revisits inserted text.
 */
export function encodeSearchFilter(value: string): string;
export function encodeSearchFilter(value: undefined): undefined;
export function encodeSearchFilter(value: string | undefined): string | undefined;
export function encodeSearchFilter(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/[&<>]/g, (char) => HTML_ESCAPES[char] ?? char);
}
