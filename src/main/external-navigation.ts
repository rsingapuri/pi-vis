import { normalizeSafeExternalWebUrl } from "@shared/external-links.js";

type ExternalUrlOpener = (url: string) => Promise<unknown>;
type ExternalUrlFailureReporter = (error: unknown) => void;

function openSafeExternalWebUrl(
  value: unknown,
  opener: ExternalUrlOpener,
  reportFailure: ExternalUrlFailureReporter,
): boolean {
  const url = normalizeSafeExternalWebUrl(value);
  if (!url) return false;

  try {
    void opener(url).catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
  return true;
}

/** Deny every child window while routing allowed web targets to the OS browser. */
export function handleWindowOpen(
  url: string,
  opener: ExternalUrlOpener,
  reportFailure: ExternalUrlFailureReporter,
): { action: "deny" } {
  openSafeExternalWebUrl(url, opener, reportFailure);
  return { action: "deny" };
}

/** Keep the renderer on its current document and route only allowed web targets externally. */
export function handleRendererNavigation(
  event: { preventDefault(): void },
  url: string,
  currentUrl: string,
  opener: ExternalUrlOpener,
  reportFailure: ExternalUrlFailureReporter,
): void {
  if (url === currentUrl) return;

  event.preventDefault();
  openSafeExternalWebUrl(url, opener, reportFailure);
}
