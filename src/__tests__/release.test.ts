import { afterEach, describe, expect, it, vi } from "vitest";
import { detectSource, normalizeCommit, normalizeRepository, readGit } from "../release.js";
import { Transport } from "../transport.js";
import { wireBody } from "./wireBody";

const SHA = "df48a0a5d924fcdf05626119b9d390b3e1a86aef";

/** An in-memory filesystem: path -> contents. */
function memoryFs(files: Record<string, string>) {
  return {
    existsSync: (path: string) => path in files || Object.keys(files).some((name) => name.startsWith(`${path}/`)),
    readFileSync: (path: string) => {
      if (!(path in files)) throw new Error(`ENOENT ${path}`);
      return files[path]!;
    },
  };
}

describe("commit and repository", () => {
  it("takes the explicit commit, then CostKey's variable, then CI and platform variables", () => {
    expect(detectSource({ commit: SHA.toUpperCase() }, { GITHUB_SHA: "1111111" }, "/app", null).commit).toBe(SHA);
    expect(detectSource({}, { COSTKEY_COMMIT: "abcdef1", GITHUB_SHA: SHA }, "/app", null).commit).toBe("abcdef1");
    expect(detectSource({}, { VERCEL_GIT_COMMIT_SHA: SHA }, "/app", null).commit).toBe(SHA);
    expect(detectSource({}, { RENDER_GIT_COMMIT: SHA }, "/app", null).commit).toBe(SHA);
    expect(detectSource({}, { SOURCE_VERSION: "not a sha" }, "/app", null).commit).toBeUndefined();
  });

  it("finds the repository on GitHub Actions, Vercel and GitLab", () => {
    expect(detectSource({}, { GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "thrive-money/core" }, "/app", null).repository).toBe("https://github.com/thrive-money/core");
    expect(detectSource({}, { VERCEL_GIT_PROVIDER: "gitlab", VERCEL_GIT_REPO_OWNER: "acme", VERCEL_GIT_REPO_SLUG: "app" }, "/app", null).repository).toBe("https://gitlab.com/acme/app");
    expect(detectSource({}, { CI_PROJECT_URL: "https://gitlab.example.com/team/app" }, "/app", null).repository).toBe("https://gitlab.example.com/team/app");
  });

  it("normalises remotes and never keeps credentials", () => {
    expect(normalizeRepository("git@github.com:costkey/platform.git")).toBe("https://github.com/costkey/platform");
    expect(normalizeRepository("https://x-access-token:secret@github.com/costkey/platform.git")).toBe("https://github.com/costkey/platform");
    expect(normalizeRepository("ssh://git@gitlab.com/acme/app.git")).toBe("https://gitlab.com/acme/app");
    expect(normalizeRepository("not a url")).toBeUndefined();
    expect(normalizeCommit("XYZ")).toBeUndefined();
  });

  it("reads HEAD through a branch ref, packed-refs or a detached HEAD, and origin's URL", () => {
    const config = '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:costkey/platform.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
    expect(readGit(memoryFs({ "/repo/.git/HEAD": "ref: refs/heads/main\n", "/repo/.git/refs/heads/main": `${SHA}\n`, "/repo/.git/config": config }), "/repo/packages/app"))
      .toEqual({ commit: SHA, repository: "https://github.com/costkey/platform" });
    expect(readGit(memoryFs({ "/repo/.git/HEAD": "ref: refs/heads/main\n", "/repo/.git/packed-refs": `# pack-refs\n${SHA} refs/heads/main\n` }), "/repo").commit).toBe(SHA);
    expect(readGit(memoryFs({ "/repo/.git/HEAD": `${SHA}\n` }), "/repo").commit).toBe(SHA);
    expect(readGit(memoryFs({}), "/repo")).toEqual({});
  });

  it("falls back to .git only for what the environment didn't say", () => {
    const fs = memoryFs({ "/repo/.git/HEAD": `${SHA}\n`, "/repo/.git/config": '[remote "origin"]\n\turl = https://github.com/costkey/platform\n' });
    expect(detectSource({}, { GITHUB_SHA: "abcdef1" }, "/repo", fs)).toEqual({ commit: "abcdef1", repository: "https://github.com/costkey/platform" });
  });
});

describe("batches carry the deploy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends release, commit and repository with every batch", async () => {
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(wireBody(init));
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const t = new Transport({ endpoint: "https://costkey.dev/api/v1/events", authKey: "k", maxBatchSize: 10, flushInterval: 60_000, debug: false, release: SHA, commit: SHA, repository: "https://github.com/costkey/platform" });
    t.enqueue({ id: "e1", eventType: "call" } as never);
    await t.flush();
    expect(JSON.parse(bodies[0]!)).toMatchObject({ release: SHA, commit: SHA, repository: "https://github.com/costkey/platform" });
  });
});
