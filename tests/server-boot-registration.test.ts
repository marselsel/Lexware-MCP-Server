import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";

/**
 * Pins that a broken tool registration still kills the process at BOOT.
 *
 * skybridge 2.0 moved `registerTools` into the per-request `handler`, which looks like it
 * should turn a registration error (a duplicate tool name, a schema the SDK refuses to
 * convert) from a boot failure into a 500 on every /mcp request — with `/status` still
 * answering 200, so Cloud Run's startup probe passes and a revision that cannot serve a
 * single request takes all the traffic.
 *
 * It does not, and the reason is worth pinning because it is nowhere in the docs:
 * `run()` awaits `createApp()`, which awaits `ready()`, which builds ONE sample server —
 * it needs `securitySchemesByTool` to wire OAuth — and it does so before
 * `httpServer.listen()`. The handler therefore runs once during module evaluation, and
 * anything it throws propagates out of the import with no port bound.
 *
 * That is upstream behaviour we depend on but do not control, so this test poisons
 * `registerTools` and asserts the import rejects with that error. `__PORT` points at a
 * socket this test already holds: if a future skybridge ever defers the sample build past
 * `listen()`, the import fails with EADDRINUSE instead and the message assertion below
 * catches it, rather than the suite silently leaking a listening server.
 *
 * In its own file because it mocks a module the rest of the suite uses for real, and
 * because importing `server.ts` is one-shot — module evaluation is cached per worker.
 */
const registerTools = vi.hoisted(() => vi.fn());

vi.mock("../src/tools/index.js", () => ({ registerTools }));

it("aborts module evaluation when tool registration throws, before binding a port", async () => {
  registerTools.mockImplementation(() => {
    throw new Error("registration is broken");
  });

  const occupied = createServer();
  await new Promise<void>((r) => occupied.listen(0, "127.0.0.1", r));
  const { port } = occupied.address() as AddressInfo;

  vi.stubEnv("LEXWARE_API_KEY", "test-key");
  vi.stubEnv("MCP_ALLOW_UNAUTHENTICATED", "true");
  vi.stubEnv("__PORT", String(port));

  let thrown: unknown;
  try {
    await import("../src/server.js");
  } catch (err) {
    thrown = err;
  }

  try {
    expect(thrown, "importing server.ts must reject, not start serving").toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("registration is broken");
    // The sample server ready() builds — one registration pass, during boot.
    expect(registerTools).toHaveBeenCalledTimes(1);
  } finally {
    await new Promise<void>((r) => occupied.close(() => r()));
    vi.unstubAllEnvs();
  }
});
