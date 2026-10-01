import { normalizeSafeExternalWebUrl } from "@shared/external-links.js";

type ExternalUrlOpener = (url: string) => Promise<unknown>;

/** Main-process policy boundary for URLs passed to Electron's shell. */
export async function openValidatedExternalWebUrl(
  value: unknown,
  opener: ExternalUrlOpener,
): Promise<void> {
  const url = normalizeSafeExternalWebUrl(value);
  if (!url) throw new Error("Only web links without credentials can be opened");
  await opener(url);
}
