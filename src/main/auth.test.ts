import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  appendDiagnostic: vi.fn(),
  boundedProcessFailureKind: vi.fn(() => "timeout"),
  captureProcessOutput: vi.fn(),
}));

vi.mock("./bounded-process.js", () => ({
  boundedProcessFailureKind: h.boundedProcessFailureKind,
  captureProcessOutput: h.captureProcessOutput,
}));
vi.mock("./diagnostics.js", () => ({ appendDiagnostic: h.appendDiagnostic }));

import {
  clearLoginShellEnvCache,
  getLoginShellEnv,
  listAuthStatus,
  mergeAuthEnvironment,
  publishAuthStatusForSettingsUpdate,
} from "./auth.js";

let previousHostScript: string | undefined;
let previousSentinel: string | undefined;
let previousShell: string | undefined;

beforeEach(() => {
  previousHostScript = process.env.PIVIS_TEST_HOST_SCRIPT;
  previousSentinel = process.env.PIVIS_TEST_INHERITED_ENV_SENTINEL;
  previousShell = process.env.SHELL;
  delete process.env.PIVIS_TEST_HOST_SCRIPT;
  process.env.SHELL = "/bin/test-shell";
  clearLoginShellEnvCache();
  h.appendDiagnostic.mockReset();
  h.boundedProcessFailureKind.mockClear();
  h.captureProcessOutput.mockReset();
});

afterEach(() => {
  if (previousHostScript === undefined) delete process.env.PIVIS_TEST_HOST_SCRIPT;
  else process.env.PIVIS_TEST_HOST_SCRIPT = previousHostScript;
  if (previousSentinel === undefined) delete process.env.PIVIS_TEST_INHERITED_ENV_SENTINEL;
  else process.env.PIVIS_TEST_INHERITED_ENV_SENTINEL = previousSentinel;
  if (previousShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = previousShell;
  clearLoginShellEnvCache();
});

describe("getLoginShellEnv", () => {
  it("uses the inherited environment without invoking a login shell for fake hosts", async () => {
    process.env.PIVIS_TEST_HOST_SCRIPT = "/tmp/fake-session-host.mjs";
    process.env.PIVIS_TEST_INHERITED_ENV_SENTINEL = "inherited";

    await expect(getLoginShellEnv()).resolves.toMatchObject({
      PIVIS_TEST_INHERITED_ENV_SENTINEL: "inherited",
    });
    expect(h.captureProcessOutput).not.toHaveBeenCalled();
  });

  it("captures and parses the interactive login-shell environment with a hard bound", async () => {
    h.captureProcessOutput.mockResolvedValue({
      stdout: "PATH=/login/bin:/usr/bin\nAPI_TOKEN=abc=123\n",
      stderr: "",
    });

    await expect(getLoginShellEnv()).resolves.toEqual({
      PATH: "/login/bin:/usr/bin",
      API_TOKEN: "abc=123",
    });
    expect(h.captureProcessOutput).toHaveBeenCalledWith("/bin/test-shell", ["-ilc", "env"], {
      timeoutMs: 5_000,
      maxBufferBytes: 1024 * 1024,
    });
  });

  it("does not PATH-resolve a relative SHELL before the capture deadline starts", async () => {
    process.env.SHELL = "relative-shell";
    h.captureProcessOutput.mockResolvedValue({ stdout: "PATH=/safe\n", stderr: "" });

    await getLoginShellEnv();

    expect(h.captureProcessOutput).toHaveBeenCalledWith("/bin/bash", ["-ilc", "env"], {
      timeoutMs: 5_000,
      maxBufferBytes: 1024 * 1024,
    });
  });

  it("shares one shell capture across concurrent callers", async () => {
    let resolveCapture: ((value: { stdout: string; stderr: string }) => void) | undefined;
    h.captureProcessOutput.mockReturnValue(
      new Promise((resolve) => {
        resolveCapture = resolve;
      }),
    );

    const first = getLoginShellEnv();
    const second = getLoginShellEnv();
    expect(h.captureProcessOutput).toHaveBeenCalledOnce();
    resolveCapture?.({ stdout: "PATH=/single-flight\n", stderr: "" });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { PATH: "/single-flight" },
      { PATH: "/single-flight" },
    ]);
    await getLoginShellEnv();
    expect(h.captureProcessOutput).toHaveBeenCalledOnce();
  });

  it("falls back once and caches an empty environment after bounded capture fails", async () => {
    h.captureProcessOutput.mockRejectedValue(new Error("Process timed out after 5000ms"));

    await expect(getLoginShellEnv()).resolves.toEqual({});
    await expect(getLoginShellEnv()).resolves.toEqual({});
    expect(h.captureProcessOutput).toHaveBeenCalledOnce();
    expect(h.appendDiagnostic).toHaveBeenCalledOnce();
    expect(h.appendDiagnostic).toHaveBeenCalledWith(
      "host-startup",
      "login-shell-env-failed",
      undefined,
      { reason: "timeout", timeoutMs: 5_000 },
    );
  });
});

describe("listAuthStatus", () => {
  it("detects Meta API-key environment authentication", () => {
    expect(
      listAuthStatus({}, { META_API_KEY: "secret" }).find((provider) => provider.key === "meta"),
    ).toMatchObject({
      source: "environment",
      envVar: "META_API_KEY",
      environmentLabel: "META_API_KEY env var",
      supportsOAuth: true,
    });
  });

  it("detects only a complete Anthropic workload-identity environment", () => {
    const partial = listAuthStatus(
      {},
      {
        ANTHROPIC_FEDERATION_RULE_ID: "rule",
        ANTHROPIC_ORGANIZATION_ID: "org",
      },
    ).find((provider) => provider.key === "anthropic");
    expect(partial).toMatchObject({ source: "none" });

    const complete = listAuthStatus(
      {},
      {
        ANTHROPIC_FEDERATION_RULE_ID: "rule",
        ANTHROPIC_ORGANIZATION_ID: "org",
        ANTHROPIC_IDENTITY_TOKEN_FILE: "/run/identity-token",
      },
    ).find((provider) => provider.key === "anthropic");
    expect(complete).toMatchObject({
      source: "environment",
      environmentLabel: "Anthropic workload identity",
    });
  });

  it("detects Anthropic OAuth and bearer environment aliases", () => {
    for (const variable of ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"] as const) {
      expect(
        listAuthStatus({}, { [variable]: "secret" }).find(
          (provider) => provider.key === "anthropic",
        ),
      ).toMatchObject({
        source: "environment",
        environmentLabel: `${variable} env var`,
      });
    }
  });

  it.each([
    [
      "bearer before every key alias",
      {
        ANTHROPIC_AUTH_TOKEN: "bearer-secret",
        ANTHROPIC_OAUTH_TOKEN: "oauth-secret",
        ANTHROPIC_API_KEY: "api-secret",
      },
      "ANTHROPIC_AUTH_TOKEN env var",
    ],
    [
      "OAuth token before API key",
      { ANTHROPIC_OAUTH_TOKEN: "oauth-secret", ANTHROPIC_API_KEY: "api-secret" },
      "ANTHROPIC_OAUTH_TOKEN env var",
    ],
    [
      "API key before federation",
      {
        ANTHROPIC_API_KEY: "api-secret",
        ANTHROPIC_FEDERATION_RULE_ID: "rule",
        ANTHROPIC_ORGANIZATION_ID: "org",
        ANTHROPIC_IDENTITY_TOKEN_FILE: "/run/identity-token",
      },
      "ANTHROPIC_API_KEY env var",
    ],
    [
      "federation after keys and tokens",
      {
        ANTHROPIC_FEDERATION_RULE_ID: "rule",
        ANTHROPIC_ORGANIZATION_ID: "org",
        ANTHROPIC_IDENTITY_TOKEN_FILE: "/run/identity-token",
      },
      "Anthropic workload identity",
    ],
  ])("mirrors Pi's Anthropic precedence: %s", (_name, environment, expectedLabel) => {
    expect(
      listAuthStatus({}, environment).find((provider) => provider.key === "anthropic"),
    ).toMatchObject({ source: "environment", environmentLabel: expectedLabel });
  });

  it("lets stored credentials own a provider ahead of every environment source", () => {
    const status = listAuthStatus(
      { anthropic: { type: "oauth", access: "stored-secret" } },
      {
        ANTHROPIC_AUTH_TOKEN: "bearer-secret",
        ANTHROPIC_OAUTH_TOKEN: "oauth-secret",
        ANTHROPIC_API_KEY: "api-secret",
      },
    ).find((provider) => provider.key === "anthropic");
    expect(status).toMatchObject({ source: "oauth" });
    expect(status).not.toHaveProperty("environmentLabel");
  });

  it("uses the same login-shell plus Settings override order as SDK hosts", () => {
    const effective = mergeAuthEnvironment(
      { META_API_KEY: "login-secret", ANTHROPIC_API_KEY: "login-anthropic" },
      {
        META_API_KEY: "settings-secret",
        ANTHROPIC_AUTH_TOKEN: "settings-bearer",
        PIVIS_PRIVATE_CONTROL: "must-not-pass",
      },
    );

    expect(effective).toMatchObject({
      META_API_KEY: "settings-secret",
      ANTHROPIC_API_KEY: "login-anthropic",
      ANTHROPIC_AUTH_TOKEN: "settings-bearer",
    });
    expect(effective).not.toHaveProperty("PIVIS_PRIVATE_CONTROL");
    expect(listAuthStatus({}, effective).find((provider) => provider.key === "meta")).toMatchObject(
      {
        source: "environment",
        environmentLabel: "META_API_KEY env var",
      },
    );
    expect(
      listAuthStatus({}, effective).find((provider) => provider.key === "anthropic"),
    ).toMatchObject({
      source: "environment",
      environmentLabel: "ANTHROPIC_AUTH_TOKEN env var",
    });
  });

  it("never projects environment or stored credential values into renderer status", () => {
    const secrets = [
      "meta-super-secret",
      "anthropic-super-secret",
      "identity-super-secret",
      "stored-super-secret",
    ] as const;
    const providers = listAuthStatus(
      { openai: { type: "api_key", key: secrets[3]! } },
      {
        META_API_KEY: secrets[0],
        ANTHROPIC_AUTH_TOKEN: secrets[1],
        ANTHROPIC_FEDERATION_RULE_ID: "rule",
        ANTHROPIC_ORGANIZATION_ID: "org",
        ANTHROPIC_IDENTITY_TOKEN_FILE: secrets[2],
      },
    );
    const serialized = JSON.stringify(providers);

    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(providers.find((provider) => provider.key === "meta")).toMatchObject({
      environmentLabel: "META_API_KEY env var",
    });
  });

  it("requires Pi's complete Cloudflare environment rather than a key alone", () => {
    expect(
      listAuthStatus({}, { CLOUDFLARE_API_KEY: "secret" }).find(
        (provider) => provider.key === "cloudflare-workers-ai",
      ),
    ).toMatchObject({ source: "none" });
    expect(
      listAuthStatus({}, { CLOUDFLARE_API_KEY: "secret", CLOUDFLARE_ACCOUNT_ID: "account" }).find(
        (provider) => provider.key === "cloudflare-workers-ai",
      ),
    ).toMatchObject({ source: "environment", environmentLabel: "Cloudflare environment" });
    expect(
      listAuthStatus(
        {},
        {
          CLOUDFLARE_API_KEY: "secret",
          CLOUDFLARE_ACCOUNT_ID: "account",
          CLOUDFLARE_GATEWAY_ID: "gateway",
        },
      ).find((provider) => provider.key === "cloudflare-ai-gateway"),
    ).toMatchObject({ source: "environment", environmentLabel: "Cloudflare environment" });
  });

  it("matches ModelRuntime's Bedrock collision precedence", async () => {
    const { builtinModels } = await import(
      "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/all.js"
    );
    const environment = {
      AWS_BEARER_TOKEN_BEDROCK: "bearer-secret",
      AWS_PROFILE: "profile",
      AWS_ACCESS_KEY_ID: "access-id",
      AWS_SECRET_ACCESS_KEY: "access-secret",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/ecs",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/web-identity",
    };
    const models = builtinModels({
      authContext: {
        env: async (name: string) => environment[name as keyof typeof environment],
        fileExists: async () => false,
      },
    });

    await expect(models.checkAuth("amazon-bedrock")).resolves.toEqual({
      source: "AWS_BEARER_TOKEN_BEDROCK",
      type: "api_key",
    });
    expect(
      listAuthStatus({}, environment).find((provider) => provider.key === "amazon-bedrock"),
    ).toMatchObject({
      source: "environment",
      environmentLabel: "AWS_BEARER_TOKEN_BEDROCK env var",
    });
  });

  it("publishes committed piEnv additions and removals but ignores unrelated Settings patches", async () => {
    const providers = [
      {
        key: "meta",
        displayName: "Meta",
        source: "environment" as const,
        envVar: "META_API_KEY",
        environmentLabel: "META_API_KEY env var",
      },
    ];
    const readStatus = vi.fn(async () => providers);
    const onChange = vi.fn();

    await expect(
      publishAuthStatusForSettingsUpdate({ themeMode: "dark" }, {}, onChange, readStatus),
    ).resolves.toBe(false);
    expect(readStatus).not.toHaveBeenCalled();

    const committedPiEnv = { META_API_KEY: "settings-secret" };
    await expect(
      publishAuthStatusForSettingsUpdate(
        { piEnv: committedPiEnv },
        committedPiEnv,
        onChange,
        readStatus,
      ),
    ).resolves.toBe(true);
    expect(readStatus).toHaveBeenLastCalledWith(committedPiEnv);
    expect(onChange).toHaveBeenLastCalledWith(providers);

    await expect(
      publishAuthStatusForSettingsUpdate({ piEnv: {} }, {}, onChange, readStatus),
    ).resolves.toBe(true);
    expect(readStatus).toHaveBeenLastCalledWith({});
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
