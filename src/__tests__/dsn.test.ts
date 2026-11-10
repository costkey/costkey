import { describe, it, expect } from "vitest";
import { parseDSN } from "../dsn.js";

describe("DSN Parsing", () => {
  it("parses a valid DSN", () => {
    const dsn = parseDSN("https://ck_abc123@costkey.dev/my-project");
    expect(dsn).toEqual({
      authKey: "ck_abc123",
      host: "costkey.dev",
      projectId: "my-project",
      endpoint: "https://costkey.dev/api/v1/events",
    });
  });

  it("parses DSN with custom host", () => {
    const dsn = parseDSN("https://key@localhost:4100/proj_123");
    expect(dsn.host).toBe("localhost:4100");
    expect(dsn.endpoint).toBe("https://localhost:4100/api/v1/events");
  });

  it("throws on invalid URL with dashboard link", () => {
    expect(() => parseDSN("not-a-url")).toThrow("Invalid DSN");
    expect(() => parseDSN("not-a-url")).toThrow("Settings, Projects");
  });

  it("throws on missing auth key with dashboard link", () => {
    expect(() => parseDSN("https://costkey.dev/my-project")).toThrow("missing auth key");
    expect(() => parseDSN("https://costkey.dev/my-project")).toThrow("Settings, Projects");
  });

  it("throws on missing project ID with dashboard link", () => {
    expect(() => parseDSN("https://key@costkey.dev/")).toThrow("missing project ID");
    expect(() => parseDSN("https://key@costkey.dev/")).toThrow("Settings, Projects");
    expect(() => parseDSN("https://key@costkey.dev")).toThrow("missing project ID");
  });

  it("keeps the path CostKey is served under", () => {
    const parsed = parseDSN("https://ck_abc@portal-dev.example.com/costkey/proj_123");
    expect(parsed.projectId).toBe("proj_123");
    expect(parsed.endpoint).toBe("https://portal-dev.example.com/costkey/api/v1/events");
    const nested = parseDSN("http://k@localhost:4300/tools/costkey/proj_9/");
    expect(nested.projectId).toBe("proj_9");
    expect(nested.endpoint).toBe("http://localhost:4300/tools/costkey/api/v1/events");
  });
});
