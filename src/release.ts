/**
 * Which code is running: the commit SHA and the repository it came from,
 * found once at init from CI and hosting platforms' environment variables,
 * then from the nearest .git directory. Never throws; unknown is undefined.
 */

type Env = Record<string, string | undefined>;

type FsLike = {
  readFileSync(path: string, encoding: "utf8"): string;
  existsSync(path: string): boolean;
};

/** Commit variables, most specific first. */
const COMMIT_VARS = [
  "COSTKEY_COMMIT",
  "GITHUB_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "RAILWAY_GIT_COMMIT_SHA",
  "CF_PAGES_COMMIT_SHA",
  "CI_COMMIT_SHA",
  "BITBUCKET_COMMIT",
  "CIRCLE_SHA1",
  "COMMIT_REF",
  "HEROKU_SLUG_COMMIT",
  "SOURCE_VERSION",
  "CODEBUILD_RESOLVED_SOURCE_VERSION",
  "SOURCE_COMMIT",
  "GIT_COMMIT",
  "GIT_SHA",
  "COMMIT_SHA",
];

const SHA = /^[0-9a-f]{7,40}$/;

export function normalizeCommit(raw: string | undefined | null): string | undefined {
  const value = raw?.trim().toLowerCase();
  return value && SHA.test(value) ? value : undefined;
}

/**
 * An https repository URL without credentials or ".git":
 * git@github.com:org/repo.git and https://token@github.com/org/repo.git
 * both become https://github.com/org/repo.
 */
export function normalizeRepository(raw: string | undefined | null): string | undefined {
  let value = raw?.trim();
  if (!value) return undefined;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(value);
  if (scp) value = `https://${scp[1]}/${scp[2]}`;
  else if (value.startsWith("ssh://")) value = value.replace(/^ssh:\/\/(?:[^@/]+@)?/, "https://");
  else if (!/^https?:\/\//.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
    if (!url.hostname.includes(".") || path.split("/").filter(Boolean).length < 2) return undefined;
    return `https://${url.hostname.replace(/:\d+$/, "")}${path}`;
  } catch {
    return undefined;
  }
}

function repositoryFromEnv(env: Env): string | undefined {
  if (env["COSTKEY_REPOSITORY"]) return normalizeRepository(env["COSTKEY_REPOSITORY"]);
  if (env["GITHUB_REPOSITORY"]) return normalizeRepository(`${env["GITHUB_SERVER_URL"] || "https://github.com"}/${env["GITHUB_REPOSITORY"]}`);
  if (env["VERCEL_GIT_REPO_OWNER"] && env["VERCEL_GIT_REPO_SLUG"]) {
    const host = ({ github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" } as Record<string, string>)[env["VERCEL_GIT_PROVIDER"] ?? "github"] ?? "github.com";
    return normalizeRepository(`https://${host}/${env["VERCEL_GIT_REPO_OWNER"]}/${env["VERCEL_GIT_REPO_SLUG"]}`);
  }
  if (env["RENDER_GIT_REPO_SLUG"]) return normalizeRepository(`https://github.com/${env["RENDER_GIT_REPO_SLUG"]}`);
  if (env["RAILWAY_GIT_REPO_OWNER"] && env["RAILWAY_GIT_REPO_NAME"]) return normalizeRepository(`https://github.com/${env["RAILWAY_GIT_REPO_OWNER"]}/${env["RAILWAY_GIT_REPO_NAME"]}`);
  for (const name of ["CI_PROJECT_URL", "BITBUCKET_GIT_HTTP_ORIGIN", "CIRCLE_REPOSITORY_URL"]) {
    if (env[name]) return normalizeRepository(env[name]);
  }
  return undefined;
}

function nodeFs(): FsLike | null {
  try {
    const g = globalThis as { process?: { versions?: { node?: string }; getBuiltinModule?: (id: string) => unknown }; EdgeRuntime?: unknown };
    if (typeof g.EdgeRuntime === "string" || !g.process?.versions?.node) return null;
    const fs = g.process.getBuiltinModule?.("node:fs") as FsLike | undefined;
    return fs && typeof fs.readFileSync === "function" && typeof fs.existsSync === "function" ? fs : null;
  } catch {
    return null;
  }
}

/** The .git directory at or above `start`, following a worktree's "gitdir:" file. */
function gitDir(fs: FsLike, start: string): string | null {
  let dir = start.replace(/\/+$/, "") || "/";
  for (let depth = 0; depth < 40; depth++) {
    const candidate = `${dir === "/" ? "" : dir}/.git`;
    if (fs.existsSync(`${candidate}/HEAD`)) return candidate;
    if (fs.existsSync(candidate)) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(candidate, "utf8"))?.[1]?.trim();
      if (pointer) return pointer.startsWith("/") ? pointer : `${dir}/${pointer}`;
    }
    if (dir === "/" || !dir) return null;
    dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
  }
  return null;
}

/** HEAD's commit, through a branch ref or packed-refs; and origin's URL. */
export function readGit(fs: FsLike, start: string): { commit?: string; repository?: string } {
  const dir = gitDir(fs, start);
  if (!dir) return {};
  const result: { commit?: string; repository?: string } = {};
  const head = fs.readFileSync(`${dir}/HEAD`, "utf8").trim();
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
  if (!ref) result.commit = normalizeCommit(head);
  else {
    // A worktree keeps its refs in the main repository's directory.
    const common = fs.existsSync(`${dir}/commondir`) ? (() => {
      const pointer = fs.readFileSync(`${dir}/commondir`, "utf8").trim();
      return pointer.startsWith("/") ? pointer : `${dir}/${pointer}`;
    })() : dir;
    for (const base of [dir, common]) {
      if (fs.existsSync(`${base}/${ref}`)) { result.commit = normalizeCommit(fs.readFileSync(`${base}/${ref}`, "utf8")); break; }
    }
    if (!result.commit && fs.existsSync(`${common}/packed-refs`)) {
      const line = fs.readFileSync(`${common}/packed-refs`, "utf8").split("\n").find((entry) => entry.trim().endsWith(` ${ref}`));
      result.commit = normalizeCommit(line?.split(" ")[0]);
    }
  }
  const configPath = fs.existsSync(`${dir}/config`) ? `${dir}/config` : fs.existsSync(`${dir}/commondir`) ? `${dir}/${fs.readFileSync(`${dir}/commondir`, "utf8").trim()}/config` : null;
  if (configPath && fs.existsSync(configPath)) {
    const config = fs.readFileSync(configPath, "utf8");
    const origin = /\[remote "origin"\]([^[]*)/.exec(config)?.[1];
    result.repository = normalizeRepository(origin ? /^\s*url\s*=\s*(.+)$/m.exec(origin)?.[1] : undefined);
  }
  return result;
}

export interface CodeSource {
  commit?: string;
  repository?: string;
}

/** The running code's commit and repository: explicit options, then the environment, then .git. */
export function detectSource(options: { commit?: string; repository?: string } = {}, env?: Env, cwd?: string, fs: FsLike | null = nodeFs()): CodeSource {
  try {
    const vars: Env = env ?? (typeof process !== "undefined" && process.env ? process.env : {});
    let commit = normalizeCommit(options.commit);
    for (const name of COMMIT_VARS) {
      if (commit) break;
      commit = normalizeCommit(vars[name]);
    }
    let repository = normalizeRepository(options.repository) ?? repositoryFromEnv(vars);
    if ((!commit || !repository) && fs) {
      const where = cwd ?? (typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : null);
      if (where) {
        const git = readGit(fs, where);
        commit ??= git.commit;
        repository ??= git.repository;
      }
    }
    return { commit, repository };
  } catch {
    return {};
  }
}
