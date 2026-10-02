import { describe, expect, it } from "vitest";
import { PROVIDERS, PROVIDER_API_KEY_ENV_VARS, findProvider } from "./auth.js";

describe("Pi provider definitions", () => {
  it("exposes the providers added by Pi 0.84 with their public credential variables", () => {
    expect(findProvider("baseten")).toEqual({
      key: "baseten",
      displayName: "Baseten",
      envVar: "BASETEN_API_KEY",
    });
    expect(findProvider("qwen-token-plan-individual")).toEqual({
      key: "qwen-token-plan-individual",
      displayName: "Qwen Token Plan Individual",
      envVar: "QWEN_TOKEN_PLAN_API_KEY",
    });
  });

  it("exposes Pi 0.86.1 Meta Muse authentication through API key and OAuth", () => {
    expect(findProvider("meta")).toEqual({
      key: "meta",
      displayName: "Meta",
      envVar: "META_API_KEY",
      supportsOAuth: true,
    });
  });

  it("keeps every provider key unique", () => {
    const keys = PROVIDERS.map((provider) => provider.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("matches every exact Pi 1.0.0 built-in provider, OAuth capability, and API-key env mapping", async () => {
    const [{ builtinProviders }, { findEnvKeys }] = await Promise.all([
      import(
        "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/all.js"
      ),
      import(
        "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/env-api-keys.js"
      ),
    ]);
    const upstreamProviders = builtinProviders();

    expect(
      PROVIDERS.map(({ key, displayName, supportsOAuth }) => ({
        key,
        displayName,
        supportsOAuth: supportsOAuth === true,
      })),
    ).toEqual(
      upstreamProviders.map((provider) => ({
        key: provider.id,
        displayName: provider.name,
        supportsOAuth: provider.auth.oauth !== undefined,
      })),
    );

    // A catch-all proxy makes every variable Pi probes appear configured, so
    // findEnvKeys returns its complete ordered mapping without this test
    // copying the upstream variable names into another expectation.
    const everyEnvironmentVariable = new Proxy<Record<string, string>>(
      {},
      {
        get: (_target, property) => (typeof property === "string" ? "configured" : undefined),
      },
    );
    expect(PROVIDER_API_KEY_ENV_VARS).toEqual(
      Object.fromEntries(
        upstreamProviders.map((provider) => [
          provider.id,
          findEnvKeys(provider.id, everyEnvironmentVariable) ?? [],
        ]),
      ),
    );
  });
});
