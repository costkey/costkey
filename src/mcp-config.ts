/**
 * A project .mcp.json entry that lets coding agents (Claude Code and others
 * that read .mcp.json) query CostKey. It names ${COSTKEY_TOKEN}, never a
 * token, so the file is safe to commit.
 */
export function costkeyMcpEntry(host: string): Record<string, unknown> {
  return {
    type: "http",
    url: `${host.replace(/\/+$/, "")}/mcp`,
    headers: { Authorization: "Bearer ${COSTKEY_TOKEN}" },
  };
}

/** The file with a costkey server added, or null when it already has one. */
export function withCostkeyMcp(current: Record<string, unknown> | null, host: string): Record<string, unknown> | null {
  const servers = current?.["mcpServers"] && typeof current["mcpServers"] === "object" && !Array.isArray(current["mcpServers"])
    ? current["mcpServers"] as Record<string, unknown>
    : {};
  if (servers["costkey"]) return null;
  return { ...(current ?? {}), mcpServers: { ...servers, costkey: costkeyMcpEntry(host) } };
}
