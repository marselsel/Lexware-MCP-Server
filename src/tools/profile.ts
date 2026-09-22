import type { McpServer } from "skybridge/server";
import type { LexwareClient } from "../lexware/client.js";
import { RO, text } from "./shared.js";

/** `get-profile`: organization profile. Also serves as an auth/connectivity smoke test. */
export function registerProfileTools(server: McpServer, client: LexwareClient): void {
  server.registerTool(
    {
      name: "get-profile",
      title: "Get organization profile",
      description:
        "Get the authenticated Lexware organization's profile (company name, tax type, etc.). Useful to verify the connection works.",
      annotations: RO,
    },
    async () => {
      const profile = await client.get<Record<string, unknown>>("/v1/profile");
      const name = (profile.companyName as string) ?? "(unknown)";
      return {
        structuredContent: profile,
        content: text(`Connected to Lexware organization: ${name}.`),
      };
    },
  );
}
