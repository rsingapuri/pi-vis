import { describe, expect, it, vi } from "vitest";
import { handleRendererNavigation, handleWindowOpen } from "./external-navigation.js";

const allowedUrls = [
  ["https://example.com/docs?q=pi#links", "https://example.com/docs?q=pi#links"],
  ["http://example.com/docs?q=pi#links", "http://example.com/docs?q=pi#links"],
] as const;

const blockedUrls = [
  "https://user:password@example.com/private",
  "http://user:password@example.com/private",
  "javascript:alert(1)",
  "file:///etc/passwd",
  "data:text/html,unsafe",
  "/relative/path",
  "https://example.com/line\nbreak",
] as const;

describe("BrowserWindow external navigation policy", () => {
  it.each(allowedUrls)(
    "denies a new window and opens an allowed URL externally: %s",
    (url, expected) => {
      const opener = vi.fn(async () => undefined);

      expect(handleWindowOpen(url, opener, vi.fn())).toEqual({ action: "deny" });

      expect(opener).toHaveBeenCalledOnce();
      expect(opener).toHaveBeenCalledWith(expected);
    },
  );

  it.each(blockedUrls)("denies a new window without opening an unsafe URL: %s", (url) => {
    const opener = vi.fn(async () => undefined);

    expect(handleWindowOpen(url, opener, vi.fn())).toEqual({ action: "deny" });

    expect(opener).not.toHaveBeenCalled();
  });

  it.each(allowedUrls)(
    "prevents renderer navigation and opens an allowed URL externally: %s",
    (url, expected) => {
      const event = { preventDefault: vi.fn() };
      const opener = vi.fn(async () => undefined);

      handleRendererNavigation(event, url, "file:///renderer/index.html", opener, vi.fn());

      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(opener).toHaveBeenCalledOnce();
      expect(opener).toHaveBeenCalledWith(expected);
    },
  );

  it.each(blockedUrls)("prevents renderer navigation without opening an unsafe URL: %s", (url) => {
    const event = { preventDefault: vi.fn() };
    const opener = vi.fn(async () => undefined);

    handleRendererNavigation(event, url, "file:///renderer/index.html", opener, vi.fn());

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(opener).not.toHaveBeenCalled();
  });

  it("does not intercept navigation to the already-loaded document", () => {
    const event = { preventDefault: vi.fn() };
    const opener = vi.fn(async () => undefined);

    handleRendererNavigation(
      event,
      "file:///renderer/index.html",
      "file:///renderer/index.html",
      opener,
      vi.fn(),
    );

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(opener).not.toHaveBeenCalled();
  });

  it("reports OS opener failures without allowing the child window", async () => {
    const failure = new Error("browser unavailable");
    const reportFailure = vi.fn();

    expect(
      handleWindowOpen(
        "https://example.com",
        vi.fn(async () => Promise.reject(failure)),
        reportFailure,
      ),
    ).toEqual({ action: "deny" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(reportFailure).toHaveBeenCalledWith(failure);
  });
});
