import { CLIENT_CAPABILITIES_META_KEY, type ServerContext } from "@modelcontextprotocol/server";
import type { McpServer } from "skybridge/server";
import { describe, expect, it, vi } from "vitest";
import type { LexwareClient } from "../src/lexware/client.js";
import { registerDocumentFinalizeTools } from "../src/tools/documents.js";
import { createFinalizeConfirmation, type FinalizeConfirmation } from "../src/tools/finalize-confirmation.js";

const KEY = "k".repeat(32);
const TOOL = "create-finalized-invoice";
const ARGS = { confirm_finalize: true, voucherDate: "2026-09-22T00:00:00.000+02:00", address: { name: "Acme GmbH" } };

/** A tool-call context as the SDK builds it: capabilities, the answers, and the verified state. */
function ctx(opts: {
  elicitation?: Record<string, unknown> | false;
  state?: unknown;
  answer?: unknown;
  sub?: string;
} = {}): ServerContext {
  const capabilities = opts.elicitation === false ? {} : { elicitation: opts.elicitation ?? {} };
  return {
    mcpReq: {
      method: "tools/call",
      envelope: { [CLIENT_CAPABILITIES_META_KEY]: capabilities },
      inputResponses: opts.answer === undefined ? undefined : { confirm: opts.answer },
      requestState: () => opts.state,
    },
    http: { authInfo: { token: "t", clientId: "claude", scopes: [], extra: { sub: opts.sub ?? "user-1" } } },
  } as unknown as ServerContext;
}

const accept = (confirm: boolean) => ({ action: "accept", content: { confirm } });

/** Round one against a form-capable client: the form, and the state the client must echo. */
async function askFirst(confirmation: FinalizeConfirmation, args: Record<string, unknown> = ARGS) {
  const outcome = (await confirmation.check(TOOL, args, ctx(), "Issue it?")) as unknown as {
    resultType: string;
    inputRequests: Record<string, { method: string; params: { mode?: string; message: string } }>;
    requestState: string;
  };
  // What the SDK's verify hook hands the handler on the retried round.
  const state = await confirmation.verify(outcome.requestState, ctx());
  return { outcome, state };
}

describe("createFinalizeConfirmation", () => {
  it("is off by default — no confirmation object at all", () => {
    expect(createFinalizeConfirmation("off", KEY)).toBeUndefined();
  });

  it("asks a form-capable client first, with a signed state and nothing issued", async () => {
    const confirmation = createFinalizeConfirmation("when-supported", KEY)!;
    const { outcome } = await askFirst(confirmation);
    expect(outcome.resultType).toBe("input_required");
    expect(outcome.inputRequests.confirm.method).toBe("elicitation/create");
    expect(outcome.inputRequests.confirm.params.message).toBe("Issue it?");
    expect(outcome.requestState).toMatch(/^v1\./);
  });

  it("lets the call through once the human confirmed these exact arguments", async () => {
    const confirmation = createFinalizeConfirmation("when-supported", KEY)!;
    const { state } = await askFirst(confirmation);
    await expect(confirmation.check(TOOL, ARGS, ctx({ state, answer: accept(true) }), "?")).resolves.toBeUndefined();
  });

  it("uses an approval once: the same answer replayed issues nothing", async () => {
    const confirmation = createFinalizeConfirmation("when-supported", KEY)!;
    const { state } = await askFirst(confirmation);
    await confirmation.check(TOOL, ARGS, ctx({ state, answer: accept(true) }), "?");
    const replay = await confirmation.check(TOOL, ARGS, ctx({ state, answer: accept(true) }), "?");
    expect(replay).toMatchObject({ isError: true });
  });

  it("refuses when the human said no, declined or cancelled", async () => {
    const confirmation = createFinalizeConfirmation("when-supported", KEY)!;
    for (const answer of [accept(false), { action: "decline" }, { action: "cancel" }]) {
      const { state } = await askFirst(confirmation);
      const outcome = await confirmation.check(TOOL, ARGS, ctx({ state, answer }), "?");
      expect(outcome, JSON.stringify(answer)).toMatchObject({ isError: true });
    }
  });

  it("asks again, instead of issuing, when the arguments changed after the form was shown", async () => {
    // The approval covers the document the human saw — not whatever the retry carries.
    const confirmation = createFinalizeConfirmation("when-supported", KEY)!;
    const { state } = await askFirst(confirmation);
    const changed = { ...ARGS, address: { name: "Someone Else" } };
    const outcome = await confirmation.check(TOOL, changed, ctx({ state, answer: accept(true) }), "?");
    expect(outcome).toMatchObject({ resultType: "input_required" });
  });

  it("rejects a tampered state, or one echoed back by a different signed-in user", async () => {
    const confirmation = createFinalizeConfirmation("when-supported", KEY)!;
    const { outcome } = await askFirst(confirmation);
    const [v, body, mac] = outcome.requestState.split(".");
    const forged = `${v}.${body}x.${mac}`;
    await expect(confirmation.verify(forged, ctx())).rejects.toThrow();
    await expect(confirmation.verify(outcome.requestState, ctx({ sub: "user-2" }))).rejects.toThrow();
  });

  it("finalizes as before on a client that cannot show a form, in when-supported mode", async () => {
    const confirmation = createFinalizeConfirmation("when-supported", KEY)!;
    await expect(confirmation.check(TOOL, ARGS, ctx({ elicitation: false }), "?")).resolves.toBeUndefined();
    // URL-only elicitation is not a form either.
    await expect(confirmation.check(TOOL, ARGS, ctx({ elicitation: { url: {} } }), "?")).resolves.toBeUndefined();
  });

  it("refuses on a client that cannot show a form, in required mode", async () => {
    const confirmation = createFinalizeConfirmation("required", KEY)!;
    const outcome = await confirmation.check(TOOL, ARGS, ctx({ elicitation: false }), "?");
    expect(outcome).toMatchObject({ isError: true });
  });
});

describe("create-finalized-* with confirmation on", () => {
  function finalizeTool(confirmation: FinalizeConfirmation) {
    const post = vi.fn(async () => ({ id: "inv-1" }));
    const client = { post } as unknown as LexwareClient;
    let handler: ((args: Record<string, unknown>, extra: unknown) => Promise<unknown>) | undefined;
    const server = {
      registerTool(cfg: { name: string }, h: typeof handler) {
        if (cfg.name === TOOL) handler = h;
        return server;
      },
    } as unknown as McpServer;
    registerDocumentFinalizeTools(server, client, confirmation);
    return { post, call: handler! };
  }

  it("issues nothing on the first round, and exactly once after the human confirmed", async () => {
    const confirmation = createFinalizeConfirmation("when-supported", KEY)!;
    const { post, call } = finalizeTool(confirmation);

    const first = (await call(ARGS, ctx())) as { resultType: string; requestState: string };
    expect(first.resultType).toBe("input_required");
    expect(post).not.toHaveBeenCalled();

    const state = await confirmation.verify(first.requestState, ctx());
    await call(ARGS, ctx({ state, answer: accept(true) }));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/v1/invoices", expect.anything(), { finalize: true });
  });

  it("names the recipient and date in the question put to the human", async () => {
    const { call } = finalizeTool(createFinalizeConfirmation("when-supported", KEY)!);
    const first = (await call(ARGS, ctx())) as {
      inputRequests: { confirm: { params: { message: string } } };
    };
    expect(first.inputRequests.confirm.params.message).toMatch(/invoice \(for Acme GmbH, dated 2026-09-22\).*legally binding/);
  });
});
