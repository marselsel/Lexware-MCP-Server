import express from "express";
import { describe, expect, it } from "vitest";
import { INERT_APP_JSON } from "../src/server-body-parsing.js";

/**
 * Pins the one load-bearing thing skybridge 2.0 does NOT document.
 *
 * `server.ts` hands `INERT_APP_JSON` to Skybridge's `json` config field to neutralize
 * the app-level `express.json()` that Skybridge installs in its constructor, ahead of
 * the auth gate and ahead of the upload routes' own `express.raw()`. Upstream documents
 * `json` only for raising the limit; `type` is a passthrough to Express's own
 * `OptionsJson`. So if a future version stops honouring a `type` predicate, the parser
 * silently comes back to life in front of the auth gate — and these tests fail rather
 * than production quietly regaining a pre-auth body-buffering path.
 */
async function listen(app: express.Express) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("INERT_APP_JSON neutralizes the app-level JSON parser", () => {
  it("leaves the body unparsed for a JSON request", async () => {
    const app = express();
    app.use(express.json(INERT_APP_JSON));
    app.post("/probe", (req, res) => {
      res.json({ type: typeof req.body, isBuffer: Buffer.isBuffer(req.body) });
    });
    const s = await listen(app);
    const res = await fetch(`${s.url}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    // Express 5 defaults req.body to undefined when no parser touched it. The point is
    // that it is NOT the parsed {hello:"world"} object.
    expect((await res.json()).type).not.toBe("object");
    await s.close();
  });

  it("does not enforce a size limit, because it never reads the stream", async () => {
    // The real risk this guards: a parser that still runs pre-auth would reject or
    // buffer a large body before the auth gate ever saw the request.
    const app = express();
    app.use(express.json({ ...INERT_APP_JSON, limit: "1kb" }));
    app.post("/probe", (_req, res) => res.json({ reached: true }));
    const s = await listen(app);
    const res = await fetch(`${s.url}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(50_000) }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: true });
    await s.close();
  });

  it("still lets a later, path-scoped parser do its job", async () => {
    // server.ts mounts express.json({limit}) on /mcp AFTER the auth gate. The inert
    // app-level layer must not stop that one from working.
    const app = express();
    app.use(express.json(INERT_APP_JSON));
    app.use("/mcp", express.json({ limit: "12mb" }));
    app.post("/mcp", (req, res) => res.json({ got: req.body }));
    const s = await listen(app);
    const res = await fetch(`${s.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(await res.json()).toEqual({ got: { hello: "world" } });
    await s.close();
  });

  it("leaves a raw parser the real bytes, whatever the content type claims", async () => {
    // This is Critical-1 in miniature: a JSON-content-typed upload must reach
    // express.raw() as a Buffer, not as a parsed object.
    const app = express();
    app.use(express.json(INERT_APP_JSON));
    app.post("/upload", express.raw({ type: () => true }), (req, res) => {
      res.json({ isBuffer: Buffer.isBuffer(req.body), len: (req.body as Buffer)?.length ?? -1 });
    });
    const s = await listen(app);
    const payload = JSON.stringify({ not: "really json to us" });
    const res = await fetch(`${s.url}/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(await res.json()).toEqual({ isBuffer: true, len: Buffer.byteLength(payload) });
    await s.close();
  });
});
