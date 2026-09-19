import { defineConfig } from "vite";

/**
 * Vitest's config. This server registers no views — there is no `.tsx` anywhere in
 * `src/`, and nothing imports `skybridge/views` or `skybridge/web` — so there is no
 * front-end bundle to build and nothing for a Skybridge Vite plugin to do.
 *
 * skybridge 1.x shipped one at `skybridge/vite` and this file loaded it; 2.0 dropped
 * that entry point entirely (its `exports` are `./server`, `./web`, `./views` and the
 * tsconfig). Since the plugin was inert here anyway, it is simply gone rather than
 * replaced. The file stays because `vitest` reads it.
 */
export default defineConfig({});
