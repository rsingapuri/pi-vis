import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const PI_ROOT = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
const PI_PACKAGE = JSON.parse(readFileSync(join(PI_ROOT, "package.json"), "utf8")) as {
  bin: { pi: string };
};
const PI_CLI = join(PI_ROOT, PI_PACKAGE.bin.pi);
const PI_MCP_ROOT = join(PI_ROOT, "node_modules", "@earendil-works", "pi-mcp");
const PI_MCP_PACKAGE = JSON.parse(readFileSync(join(PI_MCP_ROOT, "package.json"), "utf8")) as {
  exports: Record<string, { import: string }>;
};
const PI_MCP_OAUTH = pathToFileURL(
  join(PI_MCP_ROOT, PI_MCP_PACKAGE.exports["./oauth"].import),
).href;

interface FixtureRequest {
  method: string;
  path: string;
  authorization?: string;
  body: string;
}

interface OAuthMcpFixture {
  origin: string;
  serverUrl: string;
  alternateServerUrl: string;
  metadataUrl: string;
  requests: FixtureRequest[];
  close(): Promise<void>;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listenOAuthMcpFixture(): Promise<OAuthMcpFixture> {
  const requests: FixtureRequest[] = [];
  let origin = "";
  const server = createServer((request, response) => {
    void (async () => {
      const body = await requestBody(request);
      const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
      requests.push({
        method: request.method ?? "GET",
        path: url.pathname,
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
        body,
      });

      if (url.pathname === "/oauth/custom-metadata") {
        respondJson(response, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/oauth/token`,
          registration_endpoint: "",
          scopes_supported: null,
          response_types_supported: ["code"],
          grant_types_supported: null,
          token_endpoint_auth_methods_supported: null,
          code_challenge_methods_supported: null,
          client_id_metadata_document_supported: null,
          authorization_response_iss_parameter_supported: true,
        });
        return;
      }

      if (url.pathname === "/oauth/token") {
        const params = new URLSearchParams(body);
        const refreshToken = params.get("refresh_token");
        const accessToken =
          refreshToken === "alpha-refresh"
            ? "alpha-access"
            : refreshToken === "beta-refresh"
              ? "beta-access"
              : "code-access";
        respondJson(response, 200, {
          access_token: accessToken,
          token_type: "Bearer",
          refresh_token: "",
          // Pi 1.0 must normalize both empty and null optional token fields.
          // The refresh path also has to preserve the scope on the old grant.
          scope: refreshToken === "alpha-refresh" ? "" : null,
          id_token: "",
          expires_in: null,
        });
        return;
      }

      if (
        url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
        url.pathname.startsWith("/.well-known/openid-configuration")
      ) {
        respondJson(response, 500, { error: "configured metadata URL was bypassed" });
        return;
      }

      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        respondJson(response, 404, { error: "no protected-resource metadata" });
        return;
      }

      if (url.pathname === "/mcp" || url.pathname === "/mcp-alternate") {
        const allowed =
          url.pathname === "/mcp"
            ? new Set(["Bearer alpha-access", "Bearer beta-access"])
            : new Set(["Bearer alpha-alternate-access"]);
        if (!request.headers.authorization || !allowed.has(request.headers.authorization)) {
          response.writeHead(401, { "www-authenticate": "Bearer" });
          response.end();
          return;
        }
        if (request.method === "GET") {
          response.writeHead(405);
          response.end();
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(404);
          response.end();
          return;
        }

        const message = JSON.parse(body) as {
          id?: string | number;
          method?: string;
          params?: { protocolVersion?: string };
        };
        if (message.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        let result: unknown;
        switch (message.method) {
          case "initialize":
            result = {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: "oauth-loopback", version: "1.0.0" },
            };
            break;
          case "tools/list":
            result = { tools: [] };
            break;
          case "resources/list":
            result = { resources: [] };
            break;
          case "resources/templates/list":
            result = { resourceTemplates: [] };
            break;
          case "ping":
            result = {};
            break;
          default:
            respondJson(response, 200, {
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: `Unknown method: ${message.method}` },
            });
            return;
        }
        respondJson(response, 200, { jsonrpc: "2.0", id: message.id, result });
        return;
      }

      response.writeHead(404);
      response.end();
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OAuth fixture did not bind a TCP address");
  }
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    serverUrl: `${origin}/mcp`,
    alternateServerUrl: `${origin}/mcp-alternate`,
    metadataUrl: `${origin}/oauth/custom-metadata`,
    requests,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections?.();
      await closed;
    },
  };
}

async function runPiCli(args: string[], agentDir: string, cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PI_CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        PI_CODING_AGENT_DIR: agentDir,
        TERM: "dumb",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Pi CLI timed out: ${args.join(" ")}\n${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function writeMcpConfig(
  agentDir: string,
  servers: Record<string, { url: string; oauth?: Record<string, string> }>,
): void {
  writeFileSync(
    join(agentDir, "mcp.json"),
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    "utf8",
  );
}

function oauthServerConfig(url: string, metadataUrl: string) {
  return {
    url,
    oauth: {
      clientId: "fixture-client",
      authServerMetadataUrl: metadataUrl,
    },
  };
}

function readCredentialStates(agentDir: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(agentDir, "mcp-auth.json"), "utf8"));
}

function expectSuccessfulCli(result: CliResult): void {
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
}

describe("Pi 1.0 MCP OAuth behavior", () => {
  it("honors configured metadata, normalizes empty optional fields, and isolates migrated credentials", async () => {
    const fixture = await listenOAuthMcpFixture();
    const root = mkdtempSync(join(tmpdir(), "pivis-pi1-mcp-oauth-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    try {
      const oauth = await import(PI_MCP_OAUTH);
      const discovered = await oauth.discoverOAuthServerInfo(fixture.serverUrl, {
        authorizationServerMetadataUrl: new URL(fixture.metadataUrl),
      });
      expect(discovered.authorizationServerUrl).toBe(fixture.origin);
      expect(discovered.authorizationServerMetadata).toMatchObject({
        issuer: fixture.origin,
        authorization_endpoint: `${fixture.origin}/oauth/authorize`,
        token_endpoint: `${fixture.origin}/oauth/token`,
        response_types_supported: ["code"],
        authorization_response_iss_parameter_supported: true,
      });
      for (const optional of [
        "registration_endpoint",
        "scopes_supported",
        "grant_types_supported",
        "token_endpoint_auth_methods_supported",
        "code_challenge_methods_supported",
        "client_id_metadata_document_supported",
      ]) {
        expect(discovered.authorizationServerMetadata).not.toHaveProperty(optional);
      }
      await expect(
        oauth.exchangeAuthorizationCode(fixture.origin, {
          metadata: discovered.authorizationServerMetadata,
          clientInformation: { client_id: "fixture-client" },
          code: "fixture-code",
          codeVerifier: "fixture-verifier",
          redirectUrl: new URL("http://127.0.0.1/callback"),
        }),
      ).resolves.toEqual({
        access_token: "code-access",
        token_type: "Bearer",
      });

      fixture.requests.length = 0;
      const canonicalUrl = String(new URL(fixture.serverUrl));
      const legacyState = {
        serverUrl: canonicalUrl,
        tokens: {
          access_token: "expired-alpha",
          token_type: "Bearer",
          refresh_token: "alpha-refresh",
          scope: "read",
        },
        tokensExpireAt: 0,
      };
      writeFileSync(
        join(agentDir, "mcp-auth.json"),
        `${JSON.stringify({ [canonicalUrl]: legacyState }, null, 2)}\n`,
        "utf8",
      );
      writeMcpConfig(agentDir, {
        alpha: oauthServerConfig(fixture.serverUrl, fixture.metadataUrl),
      });

      const migrated = await runPiCli(["mcp", "list", "--json"], agentDir, cwd);
      expectSuccessfulCli(migrated);
      expect(JSON.parse(migrated.stdout)).toMatchObject({
        servers: [{ name: "alpha", state: "connected", tools: [] }],
        errors: [],
      });

      const alphaKey = `mcp__alpha|${canonicalUrl}`;
      let states = readCredentialStates(agentDir);
      expect(Object.hasOwn(states, canonicalUrl)).toBe(false);
      expect(Object.hasOwn(states, alphaKey)).toBe(true);
      expect(states[alphaKey]).toMatchObject({
        serverUrl: canonicalUrl,
        tokens: {
          access_token: "alpha-access",
          token_type: "Bearer",
          refresh_token: "alpha-refresh",
          scope: "read",
        },
      });
      expect(states[alphaKey]).not.toHaveProperty("tokens.expires_in");
      expect(states[alphaKey]).not.toHaveProperty("tokens.id_token");
      expect(states[alphaKey]).not.toHaveProperty("tokensExpireAt");

      const paths = fixture.requests.map((request) => request.path);
      expect(paths).toContain("/oauth/custom-metadata");
      expect(
        paths.filter(
          (path) =>
            path.startsWith("/.well-known/oauth-authorization-server") ||
            path.startsWith("/.well-known/openid-configuration"),
        ),
      ).toEqual([]);
      const tokenRequest = fixture.requests.find((request) => request.path === "/oauth/token");
      if (!tokenRequest) throw new Error("OAuth refresh did not reach the token endpoint");
      const tokenParams = new URLSearchParams(tokenRequest.body);
      expect(tokenParams.get("grant_type")).toBe("refresh_token");
      expect(tokenParams.get("refresh_token")).toBe("alpha-refresh");
      expect(tokenParams.get("client_id")).toBe("fixture-client");
      expect(
        new Set(
          fixture.requests
            .filter((request) => request.path === "/mcp")
            .map((request) => request.authorization),
        ),
      ).toEqual(new Set(["Bearer alpha-access"]));

      const betaKey = `mcp__beta|${canonicalUrl}`;
      const alternateUrl = String(new URL(fixture.alternateServerUrl));
      const alternateKey = `mcp__alpha|${alternateUrl}`;
      states[betaKey] = {
        serverUrl: canonicalUrl,
        tokens: {
          access_token: "beta-access",
          token_type: "Bearer",
          refresh_token: "beta-refresh",
          scope: "write",
        },
      };
      states[alternateKey] = {
        serverUrl: alternateUrl,
        tokens: {
          access_token: "alpha-alternate-access",
          token_type: "Bearer",
          refresh_token: "alpha-alternate-refresh",
          scope: "alternate",
        },
      };
      writeFileSync(
        join(agentDir, "mcp-auth.json"),
        `${JSON.stringify(states, null, 2)}\n`,
        "utf8",
      );

      fixture.requests.length = 0;
      writeMcpConfig(agentDir, {
        beta: oauthServerConfig(fixture.serverUrl, fixture.metadataUrl),
      });
      const betaList = await runPiCli(["mcp", "list", "--json"], agentDir, cwd);
      expectSuccessfulCli(betaList);
      expect(JSON.parse(betaList.stdout).servers[0]).toMatchObject({
        name: "beta",
        state: "connected",
      });
      expect(
        new Set(
          fixture.requests
            .filter((request) => request.path === "/mcp")
            .map((request) => request.authorization),
        ),
      ).toEqual(new Set(["Bearer beta-access"]));

      fixture.requests.length = 0;
      writeMcpConfig(agentDir, {
        alpha: oauthServerConfig(fixture.alternateServerUrl, fixture.metadataUrl),
      });
      const alternateList = await runPiCli(["mcp", "list", "--json"], agentDir, cwd);
      expectSuccessfulCli(alternateList);
      expect(JSON.parse(alternateList.stdout).servers[0]).toMatchObject({
        name: "alpha",
        state: "connected",
      });
      expect(
        new Set(
          fixture.requests
            .filter((request) => request.path === "/mcp-alternate")
            .map((request) => request.authorization),
        ),
      ).toEqual(new Set(["Bearer alpha-alternate-access"]));

      writeMcpConfig(agentDir, {
        alpha: oauthServerConfig(fixture.serverUrl, fixture.metadataUrl),
        beta: oauthServerConfig(fixture.serverUrl, fixture.metadataUrl),
      });
      const logoutAlpha = await runPiCli(["mcp", "logout", "alpha"], agentDir, cwd);
      expectSuccessfulCli(logoutAlpha);
      expect(logoutAlpha.stdout).toContain('Signed out of MCP server "alpha".');
      states = readCredentialStates(agentDir);
      expect(Object.hasOwn(states, alphaKey)).toBe(false);
      expect(Object.hasOwn(states, betaKey)).toBe(true);
      expect(Object.hasOwn(states, alternateKey)).toBe(true);

      writeMcpConfig(agentDir, {
        alpha: oauthServerConfig(fixture.alternateServerUrl, fixture.metadataUrl),
      });
      const logoutAlternate = await runPiCli(["mcp", "logout", "alpha"], agentDir, cwd);
      expectSuccessfulCli(logoutAlternate);
      states = readCredentialStates(agentDir);
      expect(Object.hasOwn(states, alternateKey)).toBe(false);
      expect(Object.hasOwn(states, betaKey)).toBe(true);

      writeMcpConfig(agentDir, {
        beta: oauthServerConfig(fixture.serverUrl, fixture.metadataUrl),
      });
      const logoutBeta = await runPiCli(["mcp", "logout", "beta"], agentDir, cwd);
      expectSuccessfulCli(logoutBeta);
      expect(readCredentialStates(agentDir)).toEqual({});
    } finally {
      await fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects an RFC 9207 response issuer mismatch before sending the authorization code", async () => {
    const fixture = await listenOAuthMcpFixture();
    try {
      const oauth = await import(PI_MCP_OAUTH);
      const store = new oauth.MemoryOAuthStateStore();
      store.save({
        serverUrl: String(new URL(fixture.serverUrl)),
        codeVerifier: "fixture-verifier",
      });
      const provider = new oauth.McpOAuthProvider({
        serverUrl: fixture.serverUrl,
        redirectUrl: "http://127.0.0.1/callback",
        clientMetadata: { client_name: "Pi-Vis issuer test" },
        clientId: "fixture-client",
        store,
        onRedirect: () => {
          throw new Error("code exchange must not redirect");
        },
      });
      const received = `${fixture.origin}/different-issuer`;

      await expect(
        oauth.authorizeMcp(provider, {
          serverUrl: fixture.serverUrl,
          authorizationServerMetadataUrl: new URL(fixture.metadataUrl),
          authorizationCode: "attacker-code",
          iss: received,
        }),
      ).rejects.toMatchObject({
        name: "OAuthIssuerMismatchError",
        expected: fixture.origin,
        received,
      });
      expect(fixture.requests.some((request) => request.path === "/oauth/token")).toBe(false);
      expect(await provider.tokens()).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("preserves granted scopes when the transport requests OAuth step-up", async () => {
    const oauth = await import(PI_MCP_OAUTH);
    const serverUrl = "https://mcp.example.test/mcp";
    const issuer = "https://auth.example.test";
    const store = new oauth.MemoryOAuthStateStore();
    store.save({
      serverUrl,
      clientInformation: { client_id: "fixture-client" },
      tokens: { access_token: "fixture-access", token_type: "Bearer", scope: "read" },
      discovery: {
        authorizationServerUrl: issuer,
        authorizationServerMetadata: {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
        },
      },
    });
    let redirect: URL | undefined;
    const provider = new oauth.McpOAuthProvider({
      serverUrl,
      redirectUrl: "http://127.0.0.1/callback",
      clientMetadata: { client_name: "Pi-Vis step-up test" },
      store,
      onRedirect: (url: URL) => {
        redirect = url;
      },
    });
    const auth = oauth.adaptOAuthProvider(provider);
    let fetched = false;

    await expect(
      auth.onUnauthorized({
        response: new Response(null, {
          status: 403,
          headers: {
            "www-authenticate": 'Bearer error="insufficient_scope", scope="write"',
          },
        }),
        serverUrl: new URL(serverUrl),
        fetch: async () => {
          fetched = true;
          throw new Error("cached step-up flow must not fetch metadata or tokens");
        },
        token: "fixture-access",
      }),
    ).rejects.toMatchObject({ name: "McpOAuthAuthorizationRequiredError" });

    expect(fetched).toBe(false);
    expect(redirect).toBeInstanceOf(URL);
    expect(redirect?.origin).toBe(issuer);
    expect(redirect?.pathname).toBe("/authorize");
    expect(redirect?.searchParams.get("scope")).toBe("read write");
    expect(await provider.tokens()).toEqual({
      access_token: "fixture-access",
      token_type: "Bearer",
      scope: "read",
    });
  });
});
