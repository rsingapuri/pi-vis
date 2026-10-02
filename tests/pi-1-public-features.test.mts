import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

const piPackageRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
const piDependenciesRoot = join(piPackageRoot, "node_modules", "@earendil-works");

function dependencyPath(packageName: string, ...segments: string[]): string {
  return join(piDependenciesRoot, packageName, ...segments);
}

function readDependencyFile(packageName: string, ...segments: string[]): string {
  return readFileSync(dependencyPath(packageName, ...segments), "utf8");
}

function dependencyPackageJson(packageName: string): {
  exports?: Record<string, string | { import?: string }>;
  main?: string;
} {
  return JSON.parse(readDependencyFile(packageName, "package.json"));
}

function publicDependencyUrl(packageName: string, subpath = "."): string {
  const packageJson = dependencyPackageJson(packageName);
  const exported = packageJson.exports?.[subpath];
  const importPath =
    typeof exported === "string"
      ? exported
      : (exported?.import ?? (subpath === "." ? packageJson.main : undefined));
  if (!importPath) throw new Error(`${packageName} does not export ${subpath} for import`);
  return pathToFileURL(dependencyPath(packageName, importPath)).href;
}

describe("Pi 1.0 public feature compatibility", () => {
  it("marks only explicitly subscription-backed OAuth providers as subscriptions", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pivis-pi1-providers-"));
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const oauthProviders = new Map(
        runtime
          .getProviders()
          .filter((provider) => provider.auth?.oauth)
          .map((provider) => [provider.id, provider.auth?.oauth?.isSubscription]),
      );

      expect(oauthProviders.get("anthropic")).toBe(true);
      expect(oauthProviders.get("openrouter")).toBeUndefined();
      expect(oauthProviders.get("radius")).toBeUndefined();
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("routes image generation through the public ModelRegistry without changing inputs or output", async () => {
    const generated = {
      output: [{ type: "image", data: "cGl4ZWw=", mimeType: "image/png" }],
      usage: { input: 3, output: 1, totalTokens: 4 },
      stopReason: "stop",
    };
    const generateImages = vi.fn(async () => generated);
    const registry = new ModelRegistry({ generateImages } as never);
    const model = { type: "image", provider: "fixture", id: "pixel", api: "fixture-images" };
    const context = { input: [{ type: "text", text: "Draw one pixel" }] };
    const options = { signal: AbortSignal.timeout(1_000) };

    await expect(
      registry.generateImages(model as never, context as never, options as never),
    ).resolves.toBe(generated);
    expect(generateImages).toHaveBeenCalledOnce();
    expect(generateImages).toHaveBeenCalledWith(model, context, options);

    const modelRegistryTypes = readFileSync(
      join(piPackageRoot, "dist", "core", "model-registry.d.ts"),
      "utf8",
    );
    expect(modelRegistryTypes).toContain(
      "generateImages(model: ImageModel<ImageApi>, context: ImagesContext, options?: ModelsImagesOptions): Promise<AssistantImages>;",
    );
  });

  it("renders codemode tool output types and reports actionable unknown-member errors", async () => {
    const codemode = await import(publicDependencyUrl("pi-codemode"));

    expect(codemode.renderToolOutputType(undefined)).toBe("unknown");
    expect(codemode.renderToolOutputType({ type: "array", items: { type: "string" } })).toBe(
      "Array<string>",
    );
    expect(
      codemode.renderToolOutputType({
        type: "object",
        properties: {
          content: { type: "array", items: { type: "object" } },
          isError: { type: "boolean" },
          _meta: { type: "object" },
          structuredContent: {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
          },
        },
      }),
    ).toBe("CallToolResult<{ count: number; }>");

    const sandbox = new codemode.CodemodeSandbox({
      timeoutMs: 5_000,
      tools: [{ name: "bash", description: "Run a command", execute: () => "unused" }],
    });
    try {
      const result = await sandbox.execute("return await tools.Bash({});");
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "script",
          name: "TypeError",
          message: expect.stringContaining("Did you mean tools.bash?"),
        },
        calls: [],
      });
      expect(result.error.message).toContain("ALL_TOOLS lists every tool");
      expect(result.error.message).toContain('Check for a member with "Bash" in tools');
    } finally {
      await sandbox.close();
    }
  });

  it('round-trips quietStartup: "header" through the public settings API', async () => {
    const settingsTypes = readFileSync(
      join(piPackageRoot, "dist", "core", "settings-manager.d.ts"),
      "utf8",
    );
    const publicTypes = readFileSync(join(piPackageRoot, "dist", "index.d.ts"), "utf8");
    expect(settingsTypes).toContain('export type QuietStartup = boolean | "header";');
    expect(publicTypes).toContain("type QuietStartup");

    const settings = SettingsManager.inMemory();
    settings.setQuietStartup("header");
    expect(settings.getQuietStartup()).toBe("header");
    expect(settings.getGlobalSettings()).toMatchObject({ quietStartup: "header" });
    await settings.flush();

    settings.setQuietStartup(false);
    expect(settings.getQuietStartup()).toBe(false);
  });

  it("ships the hardened public MCP OAuth surface and scope-preserving step-up behavior", async () => {
    const flowTypes = readDependencyFile("pi-mcp", "dist", "oauth", "flow.d.ts");
    const errorTypes = readDependencyFile("pi-mcp", "dist", "oauth", "errors.d.ts");
    const oauthIndexTypes = readDependencyFile("pi-mcp", "dist", "oauth", "index.d.ts");
    const mcpConfigTypes = readFileSync(
      join(piPackageRoot, "dist", "core", "mcp-servers.d.ts"),
      "utf8",
    );
    const hostOAuthTypes = readFileSync(
      join(piPackageRoot, "dist", "extensions", "mcp", "oauth.d.ts"),
      "utf8",
    );

    expect(flowTypes).toContain("iss?: string;");
    expect(flowTypes).toContain("authorizationServerMetadataUrl?: URL;");
    expect(flowTypes).toContain(
      "stepUpScope(granted: string | undefined, challenged: string | undefined): string | undefined;",
    );
    expect(errorTypes).toContain("readonly received: string | undefined;");
    expect(oauthIndexTypes).toContain("stepUpScope");
    expect(oauthIndexTypes).toContain("OAuthIssuerMismatchError");
    expect(mcpConfigTypes).toContain("authServerMetadataUrl?: string;");
    expect(hostOAuthTypes).toContain("authServerMetadataUrl?: URL;");
    expect(hostOAuthTypes).toContain("forServer(name: string, serverUrl: string)");
    expect(hostOAuthTypes).toContain("tokens(name: string, serverUrl: string)");
    expect(hostOAuthTypes).toContain("remove(name: string, serverUrl: string)");

    const oauth = await import(publicDependencyUrl("pi-mcp", "./oauth"));
    expect(oauth.stepUpScope("read write", "write admin")).toBe("read write admin");
    expect(oauth.stepUpScope("read", undefined)).toBeUndefined();
    expect(oauth.stepUpScope(undefined, "admin")).toBe("admin");

    const missingIssuer = new oauth.OAuthIssuerMismatchError("https://issuer.example", undefined);
    expect(missingIssuer).toMatchObject({
      name: "OAuthIssuerMismatchError",
      expected: "https://issuer.example",
      received: undefined,
    });
  });

  it("exposes TuiAltScreen.getScreenLines as a defensive snapshot", async () => {
    const tuiTypes = readDependencyFile("pi-tui", "dist", "tui-alt-screen.d.ts");
    expect(tuiTypes).toContain("getScreenLines(): string[];");

    const tui = await import(publicDependencyUrl("pi-tui"));
    expect(typeof tui.TuiAltScreen.prototype.getScreenLines).toBe("function");

    const screen = new tui.TuiAltScreen({} as never);
    expect(screen.getScreenLines()).toEqual([]);
    Reflect.set(screen, "previousScreen", ["first", "second"]);
    const snapshot = screen.getScreenLines();
    snapshot[0] = "mutated by caller";
    expect(screen.getScreenLines()).toEqual(["first", "second"]);
  });

  it("keeps removed pi-agent-core subpaths unavailable", async () => {
    const agentCoreRoot = dependencyPath("pi-agent-core");
    const packageJson = dependencyPackageJson("pi-agent-core");
    expect(Object.keys(packageJson.exports ?? {}).sort()).toEqual([".", "./package.json"]);
    expect(packageJson.exports).toMatchObject({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./package.json": "./package.json",
    });

    const agentCoreTypes = readFileSync(join(agentCoreRoot, "dist", "index.d.ts"), "utf8");
    expect(agentCoreTypes).not.toMatch(/harness|telemetry|pico3/i);
    expect(existsSync(join(agentCoreRoot, "dist", "node.js"))).toBe(false);
    expect(existsSync(join(agentCoreRoot, "dist", "harness"))).toBe(false);
    expect(existsSync(join(agentCoreRoot, "dist", "experimental", "pico3.js"))).toBe(false);

    const agentCore = await import(publicDependencyUrl("pi-agent-core"));
    expect(typeof agentCore.Agent).toBe("function");
    for (const removedSubpath of [
      "./node",
      "./harness",
      "./harness/search",
      "./experimental/pico3",
    ]) {
      expect(packageJson.exports).not.toHaveProperty(removedSubpath);
    }
  });
});
