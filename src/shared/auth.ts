/**
 * Auth types for pi-vis login integration.
 *
 * Provider keys and display names transcribed from pi's docs/providers.md
 * (shipped with the pi binary). Unknown keys found in auth.json are shown
 * by their raw key name so the UI never breaks if pi adds providers.
 */

/** Auth credential shape stored in ~/.pi/agent/auth.json */
export interface AuthCredential {
  type: "api_key" | "oauth";
  key?: string;
  [key: string]: unknown;
}

/** Status of a single provider — union of file, env, and OAuth states. */
export interface ProviderAuthStatus {
  /** auth.json key, e.g. "openrouter", "anthropic" */
  key: string;
  /** Human-readable name, e.g. "OpenRouter", "Anthropic" */
  displayName: string;
  /** How auth is currently configured. */
  source: "api_key" | "oauth" | "environment" | "none";
  /** Primary environment variable name, when known. */
  envVar?: string | undefined;
  /** Whether this provider supports native pi OAuth login. */
  supportsOAuth?: boolean | undefined;
}

/** A known provider definition for the API-key dropdown and status display. */
export interface ProviderDef {
  key: string;
  displayName: string;
  envVar?: string | undefined;
  supportsOAuth?: boolean | undefined;
}

/**
 * Known providers, transcribed from pi's docs/providers.md table
 * (and shipping docs). The envVar column is the primary env var pi
 * checks for that provider. supportsOAuth marks providers pi can
 * authenticate via interactive /login (OAuth/SSO flows).
 */
export const PROVIDERS: readonly ProviderDef[] = [
  { key: "openai", displayName: "OpenAI", envVar: "OPENAI_API_KEY", supportsOAuth: true },
  { key: "anthropic", displayName: "Anthropic", envVar: "ANTHROPIC_API_KEY", supportsOAuth: true },
  { key: "openrouter", displayName: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
  { key: "google", displayName: "Google", envVar: "GEMINI_API_KEY" },
  { key: "deepseek", displayName: "DeepSeek", envVar: "DEEPSEEK_API_KEY" },
  { key: "groq", displayName: "Groq", envVar: "GROQ_API_KEY" },
  { key: "xai", displayName: "xAI", envVar: "XAI_API_KEY" },
  { key: "mistral", displayName: "Mistral", envVar: "MISTRAL_API_KEY" },
  { key: "cerebras", displayName: "Cerebras", envVar: "CEREBRAS_API_KEY" },
  { key: "fireworks", displayName: "Fireworks", envVar: "FIREWORKS_API_KEY" },
  { key: "together", displayName: "Together", envVar: "TOGETHER_API_KEY" },
  { key: "nvidia", displayName: "NVIDIA", envVar: "NVIDIA_API_KEY" },
  { key: "kimi-coding", displayName: "Kimi Coding", envVar: "KIMI_API_KEY" },
  { key: "minimax", displayName: "MiniMax", envVar: "MINIMAX_API_KEY" },
  { key: "zai", displayName: "ZAI", envVar: "ZAI_API_KEY" },
  { key: "opencode", displayName: "OpenCode", envVar: "OPENCODE_API_KEY" },
  { key: "xiaomi", displayName: "Xiaomi", envVar: "XIAOMI_API_KEY" },
  { key: "xiaomi-pro", displayName: "Xiaomi Pro", envVar: "XIAOMI_PRO_API_KEY" },
  { key: "cloudflare", displayName: "Cloudflare", envVar: "CLOUDFLARE_API_KEY" },
  {
    key: "cloudflare-ai-gateway",
    displayName: "Cloudflare AI Gateway",
    envVar: "CLOUDFLARE_AI_GATEWAY_API_KEY",
  },
  {
    key: "vercel-ai-gateway",
    displayName: "Vercel AI Gateway",
    envVar: "VERCEL_AI_GATEWAY_API_KEY",
  },
  { key: "github-copilot", displayName: "GitHub Copilot", supportsOAuth: true },
];

/** Look up a provider definition by key. Returns undefined for unknown keys. */
export function findProvider(key: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.key === key);
}

/** Build a display name for any provider key — known providers get their
 *  human name; unknown keys are shown as-is (e.g. "my-custom-provider"). */
export function getProviderDisplayName(key: string): string {
  const p = findProvider(key);
  return p?.displayName ?? key;
}
