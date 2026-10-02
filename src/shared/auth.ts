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
  /** Human-readable environment source when authentication uses a token alias
   *  or a multi-variable workload-identity configuration. */
  environmentLabel?: string | undefined;
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
 * API-key variables in the exact order Pi 0.99.2 discovers them. Providers
 * with ambient-only authentication keep an empty list; their compound rules
 * are mirrored by main's status projection.
 */
export const PROVIDER_API_KEY_ENV_VARS: Readonly<Record<string, readonly string[]>> = {
  "amazon-bedrock": [],
  "ant-ling": ["ANT_LING_API_KEY"],
  anthropic: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  google: ["GEMINI_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  groq: ["GROQ_API_KEY"],
  huggingface: ["HF_TOKEN"],
  "kimi-coding": ["KIMI_API_KEY"],
  meta: ["META_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "openai-codex": [],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
  "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
  "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
  radius: ["RADIUS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  typesafe: ["TYPESAFE_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  xai: ["XAI_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
};

function provider(
  key: string,
  displayName: string,
  supportsOAuth = false,
  primaryEnvVar = PROVIDER_API_KEY_ENV_VARS[key]?.[0],
): ProviderDef {
  return {
    key,
    displayName,
    ...(primaryEnvVar ? { envVar: primaryEnvVar } : {}),
    ...(supportsOAuth ? { supportsOAuth: true } : {}),
  };
}

/**
 * Exact built-in provider IDs, names, primary API-key variables, and OAuth
 * capabilities from the pinned Pi 0.99.2 runtime. Anthropic's documented
 * primary variable remains `ANTHROPIC_API_KEY`; its actual resolution order is
 * captured above and mirrored by main.
 */
export const PROVIDERS: readonly ProviderDef[] = [
  provider("amazon-bedrock", "Amazon Bedrock"),
  provider("ant-ling", "Ant Ling"),
  provider("anthropic", "Anthropic", true, "ANTHROPIC_API_KEY"),
  provider("azure-openai-responses", "Azure OpenAI"),
  provider("baseten", "Baseten"),
  provider("cerebras", "Cerebras"),
  provider("cloudflare-ai-gateway", "Cloudflare AI Gateway"),
  provider("cloudflare-workers-ai", "Cloudflare Workers AI"),
  provider("deepseek", "DeepSeek"),
  provider("fireworks", "Fireworks"),
  provider("github-copilot", "GitHub Copilot", true),
  provider("google", "Google"),
  provider("google-vertex", "Google Vertex AI"),
  provider("groq", "Groq"),
  provider("huggingface", "Hugging Face"),
  provider("kimi-coding", "Kimi For Coding", true),
  provider("meta", "Meta", true),
  provider("minimax", "MiniMax"),
  provider("minimax-cn", "MiniMax CN"),
  provider("mistral", "Mistral"),
  provider("moonshotai", "Moonshot AI"),
  provider("moonshotai-cn", "Moonshot AI CN"),
  provider("nvidia", "NVIDIA"),
  provider("openai", "OpenAI", true),
  provider("openai-codex", "OpenAI Codex (legacy)", true),
  provider("opencode", "OpenCode Zen"),
  provider("opencode-go", "OpenCode Go"),
  provider("openrouter", "OpenRouter", true),
  provider("qwen-token-plan", "Qwen Token Plan"),
  provider("qwen-token-plan-cn", "Qwen Token Plan CN"),
  provider("qwen-token-plan-individual", "Qwen Token Plan Individual"),
  provider("radius", "Radius", true),
  provider("together", "Together"),
  provider("typesafe", "TypeSafe"),
  provider("vercel-ai-gateway", "Vercel AI Gateway"),
  provider("xai", "xAI", true),
  provider("xiaomi", "Xiaomi"),
  provider("xiaomi-token-plan-ams", "Xiaomi Token Plan AMS"),
  provider("xiaomi-token-plan-cn", "Xiaomi Token Plan CN"),
  provider("xiaomi-token-plan-sgp", "Xiaomi Token Plan SGP"),
  provider("zai", "Z.AI"),
  provider("zai-coding-cn", "Z.AI Coding CN"),
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
