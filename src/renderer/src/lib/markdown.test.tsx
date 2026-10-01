// @vitest-environment jsdom
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shikiMock = vi.hoisted(() => {
  const cache = new Map<string, string>();
  const codeToHtml = vi.fn((code: string, opts: { lang: string; theme: string }) => {
    return `<pre class="shiki" data-lang="${opts.lang}" data-theme="${opts.theme}"><code>${code}</code></pre>`;
  });
  return {
    cache,
    codeToHtml,
    getHighlighter: vi.fn(async () => ({ codeToHtml })),
    getShikiTheme: vi.fn(() => "test-theme"),
    getCachedHighlightedHtml: vi.fn((theme: string, lang: string, code: string) => {
      return cache.get(`${theme}\0${lang}\0${code}`) ?? null;
    }),
    setCachedHighlightedHtml: vi.fn((theme: string, lang: string, code: string, html: string) => {
      cache.set(`${theme}\0${lang}\0${code}`, html);
    }),
  };
});

vi.mock("./shiki.js", () => ({
  getHighlighter: shikiMock.getHighlighter,
  getShikiTheme: shikiMock.getShikiTheme,
  getCachedHighlightedHtml: shikiMock.getCachedHighlightedHtml,
  setCachedHighlightedHtml: shikiMock.setCachedHighlightedHtml,
}));

import { Markdown } from "./markdown.js";

function mount(node: React.ReactElement): {
  container: HTMLDivElement;
  rerender: (next: React.ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (next: React.ReactElement): void => {
    act(() => {
      flushSync(() => {
        root.render(next);
      });
    });
  };
  render(node);
  return {
    container,
    rerender: render,
    unmount: () => {
      act(() => {
        flushSync(() => {
          root.unmount();
        });
      });
      document.body.removeChild(container);
    },
  };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("Markdown code highlighting", () => {
  beforeEach(() => {
    shikiMock.cache.clear();
    shikiMock.codeToHtml.mockClear();
    shikiMock.getHighlighter.mockClear();
    shikiMock.getCachedHighlightedHtml.mockClear();
    shikiMock.setCachedHighlightedHtml.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("renders over-cap code blocks as plain pre without highlighting", async () => {
    const code = "x".repeat(50_001);
    const { container, unmount } = mount(<Markdown>{`\`\`\`ts\n${code}\n\`\`\``}</Markdown>);
    await flushPromises();

    expect(container.querySelector("pre.code-block--plain")?.textContent).toBe(code);
    expect(shikiMock.codeToHtml).not.toHaveBeenCalled();
    unmount();
  });

  it("defers streaming highlights until the trailing delay elapses", async () => {
    vi.useFakeTimers();
    const { container, unmount } = mount(
      <Markdown streaming>{"```ts\nconst a = 1;\n```"}</Markdown>,
    );

    expect(shikiMock.codeToHtml).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(149);
      await Promise.resolve();
    });
    expect(shikiMock.codeToHtml).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(shikiMock.codeToHtml).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".shiki")?.textContent).toBe("const a = 1;");
    unmount();
  });

  it("shows latest streaming code as plain text while a new highlight is delayed", async () => {
    vi.useFakeTimers();
    const view = mount(<Markdown streaming>{"```ts\nconst oldValue = 1;\n```"}</Markdown>);

    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });
    expect(view.container.querySelector(".shiki")?.textContent).toBe("const oldValue = 1;");

    view.rerender(<Markdown streaming>{"```ts\nconst newValue = 2;\n```"}</Markdown>);

    expect(view.container.querySelector(".shiki")).toBeNull();
    expect(view.container.querySelector("pre.code-block--plain")?.textContent).toBe(
      "const newValue = 2;",
    );
    view.unmount();
  });

  it("highlights immediately when streaming is false", async () => {
    const { container, unmount } = mount(
      <Markdown>{"```ts\nconst finalValue = 1;\n```"}</Markdown>,
    );
    await flushPromises();

    expect(shikiMock.codeToHtml).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".shiki")?.textContent).toBe("const finalValue = 1;");
    unmount();
  });

  it("reuses cached final highlights on remount", async () => {
    const markdown = "```ts\nconst cachedValue = 1;\n```";
    const first = mount(<Markdown>{markdown}</Markdown>);
    await flushPromises();
    first.unmount();
    expect(shikiMock.codeToHtml).toHaveBeenCalledTimes(1);

    const second = mount(<Markdown>{markdown}</Markdown>);
    await flushPromises();

    expect(shikiMock.codeToHtml).toHaveBeenCalledTimes(1);
    expect(second.container.querySelector(".shiki")?.textContent).toBe("const cachedValue = 1;");
    second.unmount();
  });

  it("nests markdown tables inside a dedicated horizontal scroll owner", () => {
    const view = mount(<Markdown>{"| A | B |\n| - | - |\n| 1 | 2 |"}</Markdown>);

    const shell = view.container.querySelector(".markdown-table-shell");
    const scroller = shell?.querySelector(":scope > .markdown-table-scroll");
    expect(scroller?.querySelector(":scope > table")?.textContent).toContain("A");

    view.unmount();
  });
});

describe("Markdown external links", () => {
  const invoke = vi.fn(async () => ({ ok: true as const }));

  beforeEach(() => {
    invoke.mockClear();
    Object.defineProperty(window, "pivis", {
      configurable: true,
      value: { invoke },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    Reflect.deleteProperty(window, "pivis");
  });

  it("opens nested and keyboard-activated links through typed external IPC", async () => {
    const view = mount(
      <Markdown>{"Read [the **nested docs**](https://example.com/guide?q=pi#start)."}</Markdown>,
    );
    const link = view.container.querySelector<HTMLAnchorElement>("a")!;
    const nested = link.querySelector("strong")!;

    let allowedNavigation = true;
    act(() => {
      allowedNavigation = nested.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          metaKey: true,
          shiftKey: true,
        }),
      );
    });
    await flushPromises();

    expect(allowedNavigation).toBe(false);
    expect(invoke).toHaveBeenLastCalledWith("app.openExternal", {
      url: "https://example.com/guide?q=pi#start",
    });

    act(() => {
      link.focus();
      link.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 0 }),
      );
    });
    await flushPromises();
    expect(invoke).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("routes middle-clicked linked images externally exactly once", async () => {
    const view = mount(
      <Markdown>
        {"[![diagram](data:image/png;base64,thumb)](https://example.com/full-page)"}
      </Markdown>,
    );
    const image = view.container.querySelector<HTMLImageElement>("a.markdown-image img")!;

    act(() => {
      image.dispatchEvent(
        new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
      );
    });
    await flushPromises();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("app.openExternal", {
      url: "https://example.com/full-page",
    });
    view.unmount();
  });

  it("opens HTTP links but keeps unsafe, credentialed, and relative targets inert", async () => {
    const view = mount(
      <Markdown>
        {[
          "[script](javascript:alert(1))",
          "[data](data:text/html,hello)",
          "[file](file:///tmp/private)",
          "[credentials](https://user:secret@example.com/)",
          "[relative](../secrets)",
          "[http](http://example.com/)",
          "[loopback](http://localhost:4317/callback)",
        ].join(" ")}
      </Markdown>,
    );

    for (const label of ["script", "data", "file", "credentials", "relative"]) {
      const text = Array.from(view.container.querySelectorAll("span")).find(
        (element) => element.textContent === label,
      );
      expect(text?.closest("a")).toBeNull();
      act(() => text?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    }
    expect(invoke).not.toHaveBeenCalled();

    const http = view.container.querySelector<HTMLAnchorElement>('a[href="http://example.com/"]')!;
    const loopback = view.container.querySelector<HTMLAnchorElement>(
      'a[href="http://localhost:4317/callback"]',
    )!;
    act(() => {
      http.click();
      loopback.click();
    });
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith("app.openExternal", {
      url: "http://example.com/",
    });
    expect(invoke).toHaveBeenCalledWith("app.openExternal", {
      url: "http://localhost:4317/callback",
    });
    view.unmount();
  });
});
