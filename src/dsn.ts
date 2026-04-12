/**
 * Parse a CostKey DSN string.
 * Format: https://<key>@<host>/<project-id>
 * Example: https://ck_abc123@costkey.dev/proj_xyz
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
      `[costkey] Invalid DSN: "${dsn}". Expected format: https://<key>@<host>/<project-id>. Get your DSN at https://app.costkey.dev`,
    );
  }

  const authKey = url.username;
  if (!authKey) {
    throw new Error(
      `[costkey] DSN missing auth key. Expected format: https://<key>@<host>/<project-id>. Get your DSN at https://app.costkey.dev`,
    );
  }

  const projectId = url.pathname.replace(/^\//, "");
  if (!projectId) {
    throw new Error(
      `[costkey] DSN missing project ID. Expected format: https://<key>@<host>/<project-id>. Get your DSN at https://app.costkey.dev`,
    );
  }

  const host = url.host;
  const endpoint = `${url.protocol}//${host}/api/v1/events`;

  return { authKey, host, projectId, endpoint };
}
