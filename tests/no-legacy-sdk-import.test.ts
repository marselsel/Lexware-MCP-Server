import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nothing may import `@modelcontextprotocol/sdk` — the 1.x SDK.
 *
 * skybridge 2 runs on `@modelcontextprotocol/server` / `@modelcontextprotocol/express` v2,
 * but it still DEPENDS on the 1.x SDK, so 1.x is hoisted into node_modules and an import of
 * it resolves and typechecks perfectly. Two structurally similar implementations, one of
 * which is dead code at runtime: a helper built on the 1.x router or error class looks
 * right, passes its tests, and pins behaviour the server never executes. That is exactly
 * how `OAuthError` went wrong once already — the 1.x `InvalidTokenError` is not an
 * `instanceof` the v2 `OAuthError`, so `requireBearerAuth` would have answered a bare 500
 * with no `WWW-Authenticate` header.
 *
 * `@modelcontextprotocol/sdk` is no longer a declared dependency, but dropping it from
 * package.json does NOT make it unresolvable — npm keeps the hoisted transitive copy. So
 * the guard has to be this: a check on what the source actually imports.
 *
 * Everything needed is re-exported from `skybridge/server`; where a type is not
 * (`OAuthMetadata`), derive it from one that is.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LEGACY = "@modelcontextprotocol/sdk";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("no imports from the legacy 1.x MCP SDK", () => {
  const files = [...sourceFiles(join(ROOT, "src")), ...sourceFiles(join(ROOT, "tests"))];

  it("scans a non-empty source tree", () => {
    // Or the assertion below would pass by finding nothing at all.
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => f.slice(ROOT.length)))("%s", (relative) => {
    const source = readFileSync(join(ROOT, relative), "utf-8");
    // `from "<specifier>"` / `import("<specifier>")`, not the prose in the comments that
    // explain why this rule exists.
    const offenders = [...source.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)]
      .map((m) => m[1])
      .filter((spec) => spec === LEGACY || spec.startsWith(`${LEGACY}/`));
    expect(offenders, `use skybridge/server instead of ${LEGACY}`).toEqual([]);
  });
});
