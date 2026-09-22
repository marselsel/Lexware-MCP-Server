import type { McpServer } from "skybridge/server";
import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { buildServerInstructions } from "../src/instructions.js";
import type { LexwareClient } from "../src/lexware/client.js";
import { registerTools } from "../src/tools/index.js";
import { TicketStore } from "../src/uploads/tickets.js";

function registeredNames(config: Config): string[] {
  const names: string[] = [];
  const fakeServer = {
    registerTool(cfg: { name: string }) {
      names.push(cfg.name);
      return fakeServer;
    },
  } as unknown as McpServer;
  registerTools(fakeServer, {} as unknown as LexwareClient, config, new TicketStore());
  return names;
}

/** Every tool name the text mentions; a trailing `*` stands for a family (create-draft-*). */
function mentionedTools(text: string): string[] {
  return [
    ...text.matchAll(/\b(?:get|list|create|update|delete|summarize|upload|render|download)-[a-z-]*[a-z*]/g),
  ].map((m) => m[0]);
}

const env = (extra: Record<string, string> = {}) =>
  ({ LEXWARE_API_KEY: "k", MCP_AUTH_TOKEN: "a".repeat(40), ...extra }) as NodeJS.ProcessEnv;

describe("buildServerInstructions", () => {
  for (const [tier, extra] of [
    ["read-only", { LEXWARE_READ_ONLY: "true" }],
    ["default (read + drafts)", {}],
    ["finalize", { LEXWARE_ENABLE_FINALIZE: "true" }],
  ] as const) {
    it(`names only tools the ${tier} tier registers`, () => {
      const config = loadConfig(env(extra));
      const tools = registeredNames(config);
      const mentioned = mentionedTools(buildServerInstructions(config.capabilities));
      expect(mentioned.length).toBeGreaterThan(0);
      for (const name of mentioned) {
        const exists = name.endsWith("*")
          ? tools.some((t) => t.startsWith(name.slice(0, -1)))
          : tools.includes(name);
        expect(exists, `${name} is mentioned but not registered`).toBe(true);
      }
    });
  }

  it("says so when the server cannot write", () => {
    const text = buildServerInstructions(loadConfig(env({ LEXWARE_READ_ONLY: "true" })).capabilities);
    expect(text).toMatch(/read-only/);
    expect(text).not.toMatch(/create-draft/);
  });

  it("warns about finalizing only when the finalize tier is on", () => {
    expect(buildServerInstructions(loadConfig(env()).capabilities)).not.toMatch(/create-finalized/);
    expect(
      buildServerInstructions(loadConfig(env({ LEXWARE_ENABLE_FINALIZE: "true" })).capabilities),
    ).toMatch(/create-finalized-\*.*legally binding/);
  });
});
