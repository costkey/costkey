#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";

type Framework =
  | "next"
  | "vite"
  | "express"
  | "fastify"
  | "hono"
  | "fastapi"
  | "django"
  | "flask"
  | "node"
  | "python"
  | "unknown";

interface Detection {
  framework: Framework;
  language: "ts" | "py" | "unknown";
  label: string;
  entrypoint: string;
  entryFile?: string;
  needsSourcemaps: boolean;
  sidecar: string;
}

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const TOKEN_DIR = join(process.env["HOME"] ?? ".", ".costkey");
const TOKEN_FILE = join(TOKEN_DIR, "token");

function arg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function getHost(): string {
  return arg("--host") ?? process.env["COSTKEY_HOST"] ?? "https://app.costkey.dev";
}

function loadToken(): string | null {
  const flag = arg("--token");
  if (flag) return flag;
  if (process.env["COSTKEY_TOKEN"]) return process.env["COSTKEY_TOKEN"];
  try {
    if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    // ignore
  }
  return null;
}

function saveToken(token: string): void {
  mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deps(pkg: Record<string, unknown> | null): Record<string, string> {
  return {
    ...((pkg?.["dependencies"] as Record<string, string> | undefined) ?? {}),
    ...((pkg?.["devDependencies"] as Record<string, string> | undefined) ?? {}),
  };
}

function hasPyDep(name: string): boolean {
  for (const file of ["requirements.txt", "pyproject.toml", "Pipfile"]) {
    try {
      if (readFileSync(file, "utf8").toLowerCase().includes(name.toLowerCase())) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

function findFirst(paths: string[]): string | undefined {
  return paths.find((file) => existsSync(file));
}

function nodeEntryFile(): string | undefined {
  return findFirst([
    "src/instrumentation.ts",
    "src/instrumentation.js",
    "instrumentation.ts",
    "instrumentation.js",
    "src/server.ts",
    "src/server.js",
    "server.ts",
    "server.js",
    "src/index.ts",
    "src/index.js",
    "index.ts",
    "index.js",
    "app.ts",
    "app.js",
  ]);
}

function pyEntryFile(): string | undefined {
  return findFirst([
    "main.py",
    "app.py",
    "asgi.py",
    "wsgi.py",
    "manage.py",
    "src/main.py",
    "src/app.py",
  ]);
}

function detect(): Detection {
  const pkg = readJson("package.json");
  const allDeps = deps(pkg);

  if (allDeps["next"] || existsSync("next.config.js") || existsSync("next.config.mjs") || existsSync("next.config.ts")) {
    return {
      framework: "next",
      language: "ts",
      label: "Next.js",
      entrypoint: "Initialize CostKey in your Next.js instrumentation file, or preload it with NODE_OPTIONS before the server starts.",
      entryFile: findFirst(["src/instrumentation.ts", "src/instrumentation.js", "instrumentation.ts", "instrumentation.js"]),
      needsSourcemaps: true,
      sidecar: "NODE_OPTIONS='--import costkey/register' next start",
    };
  }
  if (allDeps["vite"] || existsSync("vite.config.ts") || existsSync("vite.config.js")) {
    return {
      framework: "vite",
      language: "ts",
      label: "Vite / bundled TypeScript",
      entrypoint: "Initialize CostKey in your server entrypoint before AI clients are constructed, or preload it with NODE_OPTIONS for server-side runtimes.",
      entryFile: nodeEntryFile(),
      needsSourcemaps: true,
      sidecar: "NODE_OPTIONS='--import costkey/register' node dist/server.js",
    };
  }
  if (allDeps["@nestjs/core"]) {
    return {
      framework: "node",
      language: "ts",
      label: "NestJS",
      entrypoint: "Initialize CostKey in main.ts before NestFactory creates the app, or preload it with NODE_OPTIONS.",
      entryFile: findFirst(["src/main.ts", "main.ts", "src/main.js", "main.js"]),
      needsSourcemaps: false,
      sidecar: "NODE_OPTIONS='--import costkey/register' npm start",
    };
  }
  if (allDeps["@remix-run/node"] || allDeps["@remix-run/serve"]) {
    return {
      framework: "node",
      language: "ts",
      label: "Remix",
      entrypoint: "Initialize CostKey in the server entrypoint that starts Remix, or preload it with NODE_OPTIONS.",
      entryFile: nodeEntryFile(),
      needsSourcemaps: true,
      sidecar: "NODE_OPTIONS='--import costkey/register' npm start",
    };
  }
  if (allDeps["astro"]) {
    return {
      framework: "node",
      language: "ts",
      label: "Astro",
      entrypoint: "Initialize CostKey in the server adapter entrypoint, or preload it with NODE_OPTIONS for SSR/server output.",
      entryFile: nodeEntryFile(),
      needsSourcemaps: true,
      sidecar: "NODE_OPTIONS='--import costkey/register' npm start",
    };
  }
  if (allDeps["@sveltejs/kit"]) {
    return {
      framework: "node",
      language: "ts",
      label: "SvelteKit",
      entrypoint: "Initialize CostKey in the server hook or server entrypoint, or preload it with NODE_OPTIONS.",
      entryFile: findFirst(["src/hooks.server.ts", "src/hooks.server.js", "src/server.ts", "src/server.js"]),
      needsSourcemaps: true,
      sidecar: "NODE_OPTIONS='--import costkey/register' npm start",
    };
  }
  if (allDeps["express"]) {
    return {
      framework: "express",
      language: "ts",
      label: "Express",
      entrypoint: "Initialize CostKey at the top of your server entrypoint, before routes and AI clients.",
      entryFile: nodeEntryFile(),
      needsSourcemaps: false,
      sidecar: "NODE_OPTIONS='--import costkey/register' node server.js",
    };
  }
  if (allDeps["fastify"]) {
    return {
      framework: "fastify",
      language: "ts",
      label: "Fastify",
      entrypoint: "Initialize CostKey at the top of your Fastify server entrypoint.",
      entryFile: nodeEntryFile(),
      needsSourcemaps: false,
      sidecar: "NODE_OPTIONS='--import costkey/register' node server.js",
    };
  }
  if (allDeps["hono"]) {
    return {
      framework: "hono",
      language: "ts",
      label: "Hono",
      entrypoint: "Initialize CostKey before creating routes or AI clients.",
      entryFile: nodeEntryFile(),
      needsSourcemaps: false,
      sidecar: "NODE_OPTIONS='--import costkey/register' node server.js",
    };
  }
  if (allDeps["koa"]) {
    return {
      framework: "node",
      language: "ts",
      label: "Koa",
      entrypoint: "Initialize CostKey before creating routes or AI clients.",
      entryFile: nodeEntryFile(),
      needsSourcemaps: false,
      sidecar: "NODE_OPTIONS='--import costkey/register' node server.js",
    };
  }
  if (pkg) {
    return {
      framework: "node",
      language: "ts",
      label: "Node / TypeScript",
      entrypoint: "Initialize CostKey in your app entrypoint before AI calls.",
      entryFile: nodeEntryFile(),
      needsSourcemaps: false,
      sidecar: "NODE_OPTIONS='--import costkey/register' node index.js",
    };
  }

  if (hasPyDep("fastapi")) {
    return {
      framework: "fastapi",
      language: "py",
      label: "FastAPI",
      entrypoint: "Initialize CostKey near the top of your FastAPI app module before AI clients are used.",
      entryFile: pyEntryFile(),
      needsSourcemaps: false,
      sidecar: "python -m costkey.auto",
    };
  }
  if (hasPyDep("django")) {
    return {
      framework: "django",
      language: "py",
      label: "Django",
      entrypoint: "Initialize CostKey in settings.py, wsgi.py, or asgi.py before AI clients are used.",
      entryFile: findFirst(["settings.py", "wsgi.py", "asgi.py", "manage.py"]) ?? pyEntryFile(),
      needsSourcemaps: false,
      sidecar: "python -m costkey.auto",
    };
  }
  if (hasPyDep("flask")) {
    return {
      framework: "flask",
      language: "py",
      label: "Flask",
      entrypoint: "Initialize CostKey before creating routes or AI clients.",
      entryFile: pyEntryFile(),
      needsSourcemaps: false,
      sidecar: "python -m costkey.auto",
    };
  }
  if (existsSync("pyproject.toml") || existsSync("requirements.txt")) {
    return {
      framework: "python",
      language: "py",
      label: "Python",
      entrypoint: "Initialize CostKey in your app entrypoint before AI calls.",
      entryFile: pyEntryFile(),
      needsSourcemaps: false,
      sidecar: "python -m costkey.auto",
    };
  }

  return {
    framework: "unknown",
    language: "unknown",
    label: "Unknown project",
    entrypoint: "Initialize CostKey before AI calls are made.",
    needsSourcemaps: false,
    sidecar: "Set COSTKEY_DSN, then initialize CostKey before AI calls.",
  };
}

function ensureEnv(dsn: string | undefined): void {
  if (!dsn) return;
  const line = `COSTKEY_DSN=${dsn}`;
  const envPath = ".env";
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (current.includes("COSTKEY_DSN=")) {
    console.log("[ok] COSTKEY_DSN already exists in .env");
    return;
  }
  appendFileSync(envPath, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}# CostKey\n${line}\n`);
  console.log("[ok] Added COSTKEY_DSN to .env");
}

function writeGuide(detection: Detection, dsn: string | undefined): void {
  mkdirSync(".costkey", { recursive: true });
  const snippet = detection.language === "py"
    ? `import costkey\ncostkey.init(dsn="${dsn ?? "https://ck_key@app.costkey.dev/project_id"}")`
    : `import { CostKey } from "costkey"\nCostKey.init({ dsn: process.env.COSTKEY_DSN ?? "${dsn ?? "https://ck_key@app.costkey.dev/project_id"}" })`;
  const warning = detection.needsSourcemaps
    ? "\n\nIMPORTANT: This project appears to be bundled/minified. Configure sourcemaps so production stack traces resolve to original source: https://costkey.dev/docs/sourcemaps\n"
    : "";
  const detectedFile = detection.entryFile ? `\nLikely entrypoint: \`${detection.entryFile}\`\n` : "\nNo safe entrypoint was detected. Use the sidecar/preload option or add the snippet manually.\n";
  writeFileSync(
    join(".costkey", "setup.md"),
    `# CostKey setup\n\nDetected: ${detection.label}\n${detectedFile}\n${detection.entrypoint}\n\n## Code snippet\n\n\`\`\`${detection.language === "py" ? "python" : "ts"}\n${snippet}\n\`\`\`\n\n## No-code sidecar/preload\n\n\`\`\`bash\n${detection.sidecar}\n\`\`\`${warning}\n`,
  );
  if (detection.language === "ts") {
    writeFileSync(join(".costkey", "node-options.env"), "NODE_OPTIONS=--import costkey/register\n");
  }
  console.log("[ok] Wrote .costkey/setup.md");
}

function printSnippet(detection: Detection, dsn: string | undefined): void {
  console.log(`\nDetected: ${detection.label}`);
  if (detection.entryFile) console.log(`Likely entrypoint: ${detection.entryFile}`);
  console.log(detection.entrypoint);
  console.log("\nAdd this before your first AI call:\n");
  if (detection.language === "py") {
    console.log("  import costkey");
    console.log(`  costkey.init(dsn="${dsn ?? "https://ck_key@app.costkey.dev/project_id"}")`);
  } else {
    console.log('  import { CostKey } from "costkey"');
    console.log(`  CostKey.init({ dsn: process.env.COSTKEY_DSN ?? "${dsn ?? "https://ck_key@app.costkey.dev/project_id"}" })`);
  }
  if (detection.needsSourcemaps) {
    console.log("\n\x1b[33mWarning: sourcemaps recommended\x1b[0m");
    console.log("  This looks like a bundled/minified JS app. Configure sourcemaps:");
    console.log("  https://costkey.dev/docs/sourcemaps");
  }
  console.log("No-code preload option:");
  console.log(`  ${detection.sidecar}`);
  console.log();
}

async function login(host: string): Promise<string> {
  const existing = loadToken();
  if (existing) {
    try {
      const res = await fetch(`${host}/auth/me`, { headers: { Authorization: `Bearer ${existing}` } });
      if (res.ok) return existing;
    } catch {
      // continue to browser auth
    }
  }

  const state = randomBytes(16).toString("hex");
  console.log("\nOpening browser to authenticate with CostKey...\n");

  return new Promise<string>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      if (req.method === "POST" && req.url === "/callback") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { token: string; state: string };
            if (parsed.state !== state) {
              res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
              res.end(JSON.stringify({ error: "State mismatch" }));
              return;
            }
            saveToken(parsed.token);
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify({ ok: true }));
            if (timeout) clearTimeout(timeout);
            server.close();
            resolve(parsed.token);
          } catch {
            res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ error: "Invalid request" }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const url = `${host}/auth/cli?${new URLSearchParams({ port: String(port), state }).toString()}`;
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${openCmd} "${url}"`, () => undefined);
      console.log(`If the browser does not open, visit:\n${url}\n`);
    });

    server.on("error", reject);
    timeout = setTimeout(() => {
      server.close(() => undefined);
      reject(new Error("Login timed out"));
    }, 5 * 60 * 1000);
  });
}

async function createProject(host: string, token: string): Promise<string> {
  const name = arg("--name") ?? basename(process.cwd()) ?? "my-app";
  console.log(`Creating CostKey project "${name}"...`);
  const res = await fetch(`${host}/api/v1/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Project creation failed (${res.status})`);
  }
  const project = await res.json() as { dsn: string };
  return project.dsn;
}

async function setup(): Promise<void> {
  const host = getHost();
  let dsn = arg("--dsn") ?? process.env["COSTKEY_DSN"];
  if (!dsn) {
    const token = await login(host);
    dsn = await createProject(host, token);
  }
  const detection = detect();
  ensureEnv(dsn);
  writeGuide(detection, dsn);
  printSnippet(detection, dsn);
  console.log("Done. Run your app and open the CostKey dashboard to watch events land.\n");
}

if (command === "setup") {
  setup().catch((err) => {
    console.error(`\nSetup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
} else {
  console.log(`costkey

Usage:
  costkey setup [--name <project-name>] [--dsn <dsn>]

Examples:
  npx costkey setup
  npx costkey setup --name my-app
  npx costkey setup --dsn https://ck_key@app.costkey.dev/project_id
  COSTKEY_DSN=https://ck_key@app.costkey.dev/project_id npx costkey setup
`);
}
