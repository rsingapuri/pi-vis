/**
 * Normalize a URL that may be handed to the operating system.
 *
 * External links may use HTTP or HTTPS, but embedded credentials are never
 * accepted. Returning `null` keeps this usable as both a renderer affordance
 * check and the main-process policy.
 */
export function normalizeSafeExternalWebUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
