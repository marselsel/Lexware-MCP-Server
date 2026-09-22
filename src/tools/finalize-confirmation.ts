import { createHash, randomBytes } from "node:crypto";
import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputRequired,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { FinalizeElicitation } from "../config.js";
import { text } from "./shared.js";

/**
 * What travels in `requestState` between the two rounds of a confirmed finalize.
 * Signed, not encrypted — the client can read it — so it carries no document data,
 * only a digest of it.
 */
interface ConfirmationState {
  /** The tool and the exact arguments the human was asked about. */
  digest: string;
  /** Burned when the finalize goes ahead, so one approval issues one document. */
  nonce: string;
}

const ConfirmAnswer = z.object({
  confirm: z.boolean().describe("Issue it — legally binding, cannot be edited or deleted afterwards"),
});

/** How long a confirmation form stays answerable; also the codec's state TTL. */
const CONFIRMATION_TTL_SECONDS = 600;

/** A tool result the finalize handler returns instead of issuing the document. */
export type ConfirmationOutcome =
  | ({ content: [] } & ReturnType<typeof inputRequired>)
  | { content: ReturnType<typeof text>; isError: true };

export interface FinalizeConfirmation {
  readonly mode: Exclude<FinalizeElicitation, "off">;
  /** For `ServerOptions.requestState.verify`: the SDK runs it on every retried round, before the handler. */
  verify: (state: string, ctx: ServerContext) => Promise<unknown>;
  /**
   * Whether a create-finalized-* call may issue now. `undefined` means go ahead;
   * anything else is the result to return in its place — the confirmation form, or an
   * error when the human declined or the client cannot ask them.
   */
  check(
    tool: string,
    args: Record<string, unknown>,
    ctx: ServerContext,
    message: string,
  ): Promise<ConfirmationOutcome | undefined>;
}

/** JSON with object keys sorted, so equal arguments always digest equally. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestOf(tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson({ tool, args })).digest("base64url");
}

/**
 * True when the client declared form-mode elicitation on this request. Read from the
 * 2026-07-28 per-request envelope: a 2025-11-25 client on this stateless server has no
 * capabilities to read, and sending an elicitation it did not declare is a protocol error.
 * `elicitation: {}` means form only; once modes are listed, form must be among them.
 */
function supportsFormElicitation(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
    | { elicitation?: { form?: unknown; url?: unknown } }
    | undefined;
  const elicitation = capabilities?.elicitation;
  if (!elicitation) return false;
  return elicitation.form !== undefined || elicitation.url === undefined;
}

function refuse(message: string): ConfirmationOutcome {
  return { content: text(message), isError: true };
}

/**
 * Human confirmation for create-finalized-*, through MCP elicitation. `undefined` when
 * the mode is off.
 *
 * Round one answers with a confirmation form and a signed `requestState` holding a
 * digest of the tool and its arguments. The client shows the form and retries the same
 * call with the answer; the SDK verifies the state (HMAC, expiry, same signed-in user)
 * before the handler runs, and the handler issues only if the arguments still match the
 * digest, the answer is yes, and the approval has not been used before.
 *
 * This guards against the MODEL finalizing on its own — `confirm_finalize` is a value it
 * sets itself. It does not guard against a hostile client, which can answer the form
 * itself; nothing a server sends can.
 *
 * Module-scope state (the used-approval set) makes it single-instance, like the upload
 * tickets — which is what this server is deployed as.
 */
export function createFinalizeConfirmation(
  mode: FinalizeElicitation,
  key: string | undefined,
): FinalizeConfirmation | undefined {
  if (mode === "off") return undefined;

  const codec = createRequestStateCodec<ConfirmationState>({
    key: key ?? randomBytes(32),
    ttlSeconds: CONFIRMATION_TTL_SECONDS,
    // An approval given by one signed-in user cannot be replayed under another.
    bind: (ctx) => {
      const auth = ctx.http?.authInfo;
      const sub = typeof auth?.extra?.sub === "string" ? auth.extra.sub : "";
      return `${ctx.mcpReq.method}\0${auth?.clientId ?? ""}\0${sub}`;
    },
  });

  // nonce -> expiry (ms). Entries outlive the state's TTL by nothing: once the state has
  // expired the codec refuses it anyway, so the entry has nothing left to guard.
  const used = new Map<string, number>();
  const burn = (nonce: string) => {
    const now = Date.now();
    for (const [n, expiry] of used) if (expiry <= now) used.delete(n);
    used.set(nonce, now + CONFIRMATION_TTL_SECONDS * 1000);
  };

  return {
    mode,
    verify: (state, ctx) => codec.verify(state, ctx),
    async check(tool, args, ctx, message) {
      const digest = digestOf(tool, args);
      const state = ctx.mcpReq.requestState<ConfirmationState>();

      // A retried round about THESE arguments: the human has answered.
      if (typeof state === "object" && state !== null && state.digest === digest) {
        const answer = acceptedContent(ctx.mcpReq.inputResponses, "confirm", ConfirmAnswer);
        if (!answer?.confirm) {
          return refuse("Not issued: the user did not confirm finalizing this document.");
        }
        if (used.has(state.nonce)) {
          return refuse("Not issued: that confirmation was already used. Call the tool again to ask the user anew.");
        }
        burn(state.nonce);
        return undefined;
      }

      if (!supportsFormElicitation(ctx)) {
        return mode === "required"
          ? refuse(
              "Not issued: this server requires the user to confirm finalizing in a form (MCP elicitation), " +
                "and this client cannot show one. Create a draft instead and finalize it in the Lexware web app.",
            )
          : undefined;
      }

      // First round — or the arguments changed since the form was shown: ask about these.
      return {
        ...inputRequired({
          inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema: ConfirmAnswer }) },
          requestState: await codec.mint({ digest, nonce: randomBytes(16).toString("base64url") }, ctx),
        }),
        content: [],
      };
    },
  };
}
