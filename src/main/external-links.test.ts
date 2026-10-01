import { describe, expect, it, vi } from "vitest";
import { openValidatedExternalWebUrl } from "./external-links.js";

describe("openValidatedExternalWebUrl", () => {
  it.each([
    ["https://example.com/docs?q=pi#links", "https://example.com/docs?q=pi#links"],
    ["http://example.com/docs?q=pi#links", "http://example.com/docs?q=pi#links"],
    ["http://localhost:4173/preview", "http://localhost:4173/preview"],
    ["http://127.0.0.1:4173/preview", "http://127.0.0.1:4173/preview"],
    ["http://[::1]:4173/preview", "http://[::1]:4173/preview"],
  ])("opens an allowed web URL through the supplied OS effect: %s", async (input, expected) => {
    const opener = vi.fn(async () => undefined);

    await openValidatedExternalWebUrl(input, opener);

    expect(opener).toHaveBeenCalledOnce();
    expect(opener).toHaveBeenCalledWith(expected);
  });

  it.each([
    "https://user:password@example.com/private",
    "http://user:password@localhost/private",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,unsafe",
    "ftp://example.com/archive",
    "/relative/path",
    "https://example.com/line\nbreak",
    "",
    undefined,
  ])("rejects an unsafe target without invoking the OS effect: %s", async (input) => {
    const opener = vi.fn(async () => undefined);

    await expect(openValidatedExternalWebUrl(input, opener)).rejects.toThrow(
      "Only web links without credentials can be opened",
    );
    expect(opener).not.toHaveBeenCalled();
  });
});
