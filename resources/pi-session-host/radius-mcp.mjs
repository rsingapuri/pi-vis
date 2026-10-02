import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

export const RADIUS_PROVIDER_ID = "radius";

// Pi 1.0.0 intentionally uses the public default Radius gateway for MCP even
// when PI_RADIUS_GATEWAY overrides the model gateway. Keep this compatibility
// value exact and gate it against the pinned public pi-ai declaration/runtime.
export const RADIUS_MCP_URL = "https://radius.pi.dev/mcp";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUrl(value) {
  return value.replace(/\/+$/u, "");
}

function parseConfig(mcpPath) {
  const text = fs.existsSync(mcpPath) ? fs.readFileSync(mcpPath, "utf8") : undefined;
  const parsed = text === undefined ? {} : JSON.parse(text);
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    throw new Error(`${mcpPath}: expected an object with an \"mcpServers\" object`);
  }
  return { parsed, text, servers: parsed.mcpServers ?? {} };
}

function matchingRadiusServer(servers) {
  const matches = Object.entries(servers).filter(
    ([, config]) =>
      isRecord(config) &&
      typeof config.url === "string" &&
      normalizeUrl(config.url) === normalizeUrl(RADIUS_MCP_URL),
  );
  return matches.find(([, config]) => usesRadiusAuth(config)) ?? matches[0];
}

function usesRadiusAuth(config) {
  return isRecord(config?.auth) && config.auth.provider === RADIUS_PROVIDER_ID;
}

function availableRadiusServerName(servers) {
  if (!Object.hasOwn(servers, RADIUS_PROVIDER_ID)) return RADIUS_PROVIDER_ID;

  const fallback = `${RADIUS_PROVIDER_ID}-mcp`;
  if (!Object.hasOwn(servers, fallback)) return fallback;

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${fallback}-${suffix}`;
    if (!Object.hasOwn(servers, candidate)) return candidate;
  }
}

export function inspectRadiusMcpConfig(agentDir) {
  const mcpPath = path.join(agentDir, "mcp.json");
  const { servers } = parseConfig(mcpPath);
  const existing = matchingRadiusServer(servers);
  return {
    path: mcpPath,
    needsConfiguration: !existing || !usesRadiusAuth(existing[1]),
  };
}

function writeConfigAtomically(mcpPath, parsed, originalText) {
  const directory = path.dirname(mcpPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const mode = fs.existsSync(mcpPath) ? fs.statSync(mcpPath).mode & 0o777 : 0o600;
  const indent = (originalText && /^([ \t]+)\S/m.exec(originalText)?.[1]) || "  ";
  const temporaryPath = path.join(
    directory,
    `.${path.basename(mcpPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", mode);
    // Apply the exact existing/new mode before the atomic commit. Doing this
    // after rename could report failure even though the new config was already
    // visible, leaving the caller unable to distinguish commit from rollback.
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, `${JSON.stringify(parsed, null, indent)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, mcpPath);
    try {
      const directoryDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch {
      // Some filesystems do not permit fsync on directories. The same-dir
      // rename is still atomic; durability remains best-effort there.
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

/**
 * Idempotently add or update the global Radius MCP server.
 *
 * The file is re-read only after taking a dedicated lock, so an edit made
 * while the user considers the consent prompt is merged rather than lost.
 */
export async function configureRadiusMcp(agentDir) {
  const mcpPath = path.join(agentDir, "mcp.json");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const lockfilePath = `${mcpPath}.lock`;
  await lockfile.lock(mcpPath, {
    lockfilePath,
    realpath: false,
    retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
  });
  try {
    const { parsed, text, servers } = parseConfig(mcpPath);
    const existing = matchingRadiusServer(servers);
    if (existing && usesRadiusAuth(existing[1])) return { changed: false };

    const name = existing?.[0] ?? availableRadiusServerName(servers);
    const config = existing
      ? { ...existing[1], auth: { provider: RADIUS_PROVIDER_ID } }
      : {
          url: RADIUS_MCP_URL,
          auth: { provider: RADIUS_PROVIDER_ID },
        };
    delete config.oauth;
    parsed.mcpServers = { ...servers, [name]: config };
    writeConfigAtomically(mcpPath, parsed, text);
    return { changed: true };
  } finally {
    await lockfile.unlock(mcpPath, { lockfilePath, realpath: false }).catch(() => {});
  }
}
