import { describe, expect, it } from "vitest";
import { withCostkeyMcp } from "../mcp-config.js";

describe("costkey mcp", () => {
  it("adds CostKey to .mcp.json with a token variable, never a token", () => {
    expect(withCostkeyMcp(null, "https://costkey.example.com/costkey/")).toEqual({
      mcpServers: { costkey: { type: "http", url: "https://costkey.example.com/costkey/mcp", headers: { Authorization: "Bearer ${COSTKEY_TOKEN}" } } },
    });
  });

  it("keeps the servers already there and doesn't add CostKey twice", () => {
    const current = { mcpServers: { other: { command: "x" } } };
    const next = withCostkeyMcp(current, "http://localhost:4100");
    expect(Object.keys(next?.["mcpServers"] as object)).toEqual(["other", "costkey"]);
    expect(withCostkeyMcp(next, "http://localhost:4100")).toBeNull();
  });
});
