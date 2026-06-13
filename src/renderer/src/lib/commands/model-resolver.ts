/**
 * findExactModelReferenceMatch — pi's exact-match heuristic for /model.
 *
 * Mirrors the real implementation in pi's
 *   dist/core/model-resolver.js:findExactModelReferenceMatch
 * which is also what interactive-mode.js:3443 uses for `/model <search>`.
 *
 * Accepts either:
 *   1. A canonical `provider/id` (case-insensitive), exactly one match.
 *   2. A bare `id` (case-insensitive), exactly one match. Ambiguous matches
 *      across providers are rejected.
 *
 * The "exactly one match" rule is important: pi refuses to pick a model
 * when the search term is ambiguous, surfacing the picker for the user
 * to disambiguate.
 */

export interface ModelCandidate {
  id: string;
  provider: string;
  name?: string;
}

export function findExactModelReferenceMatch(
  ref: string,
  available: readonly ModelCandidate[],
): ModelCandidate | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toLowerCase();

  // 1. Canonical `provider/id` form
  const canonical = available.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === normalized);
  if (canonical.length === 1) return canonical[0];
  if (canonical.length > 1) return undefined;

  // 2. If the ref contains a slash but didn't match above, try a
  //    case-insensitive provider+id split (covers "Anthropic/Claude-Sonnet-4").
  const slash = trimmed.indexOf("/");
  if (slash !== -1) {
    const provider = trimmed.substring(0, slash).trim();
    const modelId = trimmed.substring(slash + 1).trim();
    if (provider && modelId) {
      const providerMatches = available.filter(
        (m) =>
          m.provider.toLowerCase() === provider.toLowerCase() &&
          m.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) return providerMatches[0];
      if (providerMatches.length > 1) return undefined;
    }
  }

  // 3. Bare id — only if exactly one match.
  const idMatches = available.filter((m) => m.id.toLowerCase() === normalized);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}
