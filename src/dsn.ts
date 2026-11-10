/**
 * Parse a CostKey DSN string.
 * Format: https://<key>@<host>[/<base-path>]/<project-id>
 * Example: https://ck_abc123@costkey.example.com/proj_xyz
 * Under a path: https://ck_abc123@portal.example.com/costkey/proj_xyz
 */
export interface ParsedDSN {
  authKey: string;
  host: string;
  projectId: string;
  endpoint: string;
}

export function parseDSN(dsn: string): ParsedDSN {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error(
      `[costkey] Invalid DSN: "${dsn}". Expected format: https://<key>@<host>/<project-id>. Find it in your CostKey console under Settings, Projects.`,
    );
  }

  const authKey = url.username;
  if (!authKey) {
    throw new Error(
      `[costkey] DSN missing auth key. Expected format: https://<key>@<host>/<project-id>. Find it in your CostKey console under Settings, Projects.`,
    );
  }

  // The project ID is the last path segment. Anything before it is the path
  // CostKey is served under, e.g. https://<key>@portal.example.com/costkey/<project-id>.
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop() ?? "";
  if (!projectId) {
    throw new Error(
      `[costkey] DSN missing project ID. Expected format: https://<key>@<host>/<project-id>. Find it in your CostKey console under Settings, Projects.`,
    );
  }

  const host = url.host;
  const basePath = segments.length ? `/${segments.join("/")}` : "";
  const endpoint = `${url.protocol}//${host}${basePath}/api/v1/events`;

  return { authKey, host, projectId, endpoint };
}
