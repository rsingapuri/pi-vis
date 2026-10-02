import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { RADIUS_MCP_URL, configureRadiusMcp, inspectRadiusMcpConfig } from "./radius-mcp.mjs";

const roots = [];

function fixture(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-radius-mcp-"));
  roots.push(root);
  if (config !== undefined) {
    fs.writeFileSync(path.join(root, "mcp.json"), `${JSON.stringify(config, null, 4)}\n`, {
      mode: 0o640,
    });
  }
  return root;
}

function read(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "mcp.json"), "utf8"));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Radius MCP configuration", () => {
  it("creates the global server with restrictive permissions", async () => {
    const root = fixture();

    expect(inspectRadiusMcpConfig(root).needsConfiguration).toBe(true);
    await expect(configureRadiusMcp(root)).resolves.toEqual({ changed: true });

    expect(read(root)).toEqual({
      mcpServers: {
        radius: { url: RADIUS_MCP_URL, auth: { provider: "radius" } },
      },
    });
    expect(fs.statSync(path.join(root, "mcp.json")).mode & 0o777).toBe(0o600);
  });

  it("updates an existing matching URL, removes OAuth, and preserves unrelated data", async () => {
    const root = fixture({
      marker: { keep: true },
      mcpServers: {
        custom: {
          url: `${RADIUS_MCP_URL}/`,
          enabled: false,
          headers: { "x-safe": "value" },
          oauth: { scopes: ["old"] },
        },
        other: { command: "other" },
      },
    });

    await configureRadiusMcp(root);

    expect(read(root)).toEqual({
      marker: { keep: true },
      mcpServers: {
        custom: {
          url: `${RADIUS_MCP_URL}/`,
          enabled: false,
          headers: { "x-safe": "value" },
          auth: { provider: "radius" },
        },
        other: { command: "other" },
      },
    });
    expect(fs.statSync(path.join(root, "mcp.json")).mode & 0o777).toBe(0o640);
  });

  it("uses radius-mcp on a name collision and is idempotent", async () => {
    const root = fixture({ mcpServers: { radius: { command: "leave-me" } } });

    await expect(configureRadiusMcp(root)).resolves.toEqual({ changed: true });
    await expect(configureRadiusMcp(root)).resolves.toEqual({ changed: false });

    expect(read(root).mcpServers).toEqual({
      radius: { command: "leave-me" },
      "radius-mcp": { url: RADIUS_MCP_URL, auth: { provider: "radius" } },
    });
    expect(inspectRadiusMcpConfig(root).needsConfiguration).toBe(false);
  });

  it("uses the next deterministic free name without overwriting multiple collisions", async () => {
    const root = fixture({
      mcpServers: {
        radius: { command: "leave-radius" },
        "radius-mcp": { command: "leave-radius-mcp" },
        "radius-mcp-2": { command: "leave-radius-mcp-2" },
      },
    });

    await expect(configureRadiusMcp(root)).resolves.toEqual({ changed: true });
    await expect(configureRadiusMcp(root)).resolves.toEqual({ changed: false });

    expect(read(root).mcpServers).toEqual({
      radius: { command: "leave-radius" },
      "radius-mcp": { command: "leave-radius-mcp" },
      "radius-mcp-2": { command: "leave-radius-mcp-2" },
      "radius-mcp-3": { url: RADIUS_MCP_URL, auth: { provider: "radius" } },
    });
  });

  it("leaves every entry untouched when any matching server already uses Radius auth", async () => {
    const config = {
      marker: "preserve",
      mcpServers: {
        legacy: { url: RADIUS_MCP_URL, oauth: { scopes: ["legacy"] } },
        ready: {
          url: `${RADIUS_MCP_URL}/`,
          auth: { provider: "radius" },
          description: "already configured",
        },
      },
    };
    const root = fixture(config);

    expect(inspectRadiusMcpConfig(root).needsConfiguration).toBe(false);
    await expect(configureRadiusMcp(root)).resolves.toEqual({ changed: false });
    expect(read(root)).toEqual(config);
  });

  it("rereads after the lock and preserves a distinct concurrent edit", async () => {
    const root = fixture({ marker: "before", mcpServers: {} });
    const mcpPath = path.join(root, "mcp.json");
    const lockfilePath = `${mcpPath}.lock`;
    const release = await lockfile.lock(mcpPath, { lockfilePath, realpath: false });
    let settled = false;
    const configuration = configureRadiusMcp(root).finally(() => {
      settled = true;
    });

    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      fs.writeFileSync(
        mcpPath,
        `${JSON.stringify(
          {
            marker: "written-under-lock",
            mcpServers: { concurrent: { command: "preserve-this-edit" } },
          },
          null,
          4,
        )}\n`,
        "utf8",
      );
    } finally {
      await release();
    }

    await expect(configuration).resolves.toEqual({ changed: true });
    expect(read(root)).toEqual({
      marker: "written-under-lock",
      mcpServers: {
        concurrent: { command: "preserve-this-edit" },
        radius: { url: RADIUS_MCP_URL, auth: { provider: "radius" } },
      },
    });
  });

  it("fails closed on malformed configuration without clobbering it", async () => {
    const root = fixture();
    const mcpPath = path.join(root, "mcp.json");
    fs.writeFileSync(mcpPath, "{ definitely-not-json\n", "utf8");

    expect(() => inspectRadiusMcpConfig(root)).toThrow();
    await expect(configureRadiusMcp(root)).rejects.toThrow();
    expect(fs.readFileSync(mcpPath, "utf8")).toBe("{ definitely-not-json\n");
  });
});
