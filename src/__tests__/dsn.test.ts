import { describe, it, expect } from "vitest";
import { parseDSN } from "../dsn.js";

describe("DSN Parsing", () => {
  it("parses a valid DSN", () => {
    const dsn = parseDSN("https://ck_abc123@app.costkey.dev/my-project");
    expect(dsn).toEqual({
      authKey: "ck_abc123",
      host: "app.costkey.dev",
      projectId: "my-project",
      endpoint: "https://app.costkey.dev/api/v1/events",
    });
  });

  it("parses DSN with custom host", () => {
    const dsn = parseDSN("https://key@localhost:4100/proj_123");
    expect(dsn.host).toBe("localhost:4100");
    expect(dsn.endpoint).toBe("https://localhost:4100/api/v1/events");
  });

  it("throws on invalid URL", () => {
    expect(() => parseDSN("not-a-url")).toThrow("Invalid DSN");
  });

  it("throws on missing auth key", () => {
    expect(() => parseDSN("https://costkey.dev/my-project")).toThrow("missing auth key");
  });

  it("throws on missing project ID", () => {
    expect(() => parseDSN("https://key@app.costkey.dev/")).toThrow("missing project ID");
    expect(() => parseDSN("https://key@costkey.dev")).toThrow("missing project ID");
  });
});
