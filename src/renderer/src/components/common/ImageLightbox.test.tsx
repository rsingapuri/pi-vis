// @vitest-environment jsdom
import type React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../../lib/markdown.js";
import { useImageViewerStore } from "../../stores/image-viewer-store.js";
import { ImageLightbox } from "./ImageLightbox.js";

function mount(node: React.ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    flushSync(() => {
      root.render(node);
    });
  });
  return {
    container,
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

function keyDown(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("ImageLightbox", () => {
  beforeEach(() => {
    useImageViewerStore.setState({ open: false, images: [], index: 0 });
  });

  afterEach(() => {
    useImageViewerStore.setState({ open: false, images: [], index: 0 });
    document.body.innerHTML = "";
  });

  it("opens images from markdown and closes on Escape", () => {
    const { container, unmount } = mount(
      <>
        <Markdown>{"![diagram](data:image/png;base64,abc)"}</Markdown>
        <ImageLightbox />
      </>,
    );

    const thumbnail = container.querySelector<HTMLImageElement>(".markdown-image")!;
    expect(thumbnail).toBeTruthy();

    act(() => {
      thumbnail.click();
    });

    expect(container.querySelector(".image-lightbox")).toBeTruthy();
    expect(container.querySelector<HTMLImageElement>(".image-lightbox__image")?.alt).toBe(
      "diagram",
    );

    keyDown("Escape");
    expect(container.querySelector(".image-lightbox")).toBeNull();
    unmount();
  });

  it("stops Escape from reaching parent overlay listeners", () => {
    const parentEscape = vi.fn();
    window.addEventListener("keydown", parentEscape);
    const { container, unmount } = mount(<ImageLightbox />);

    act(() => {
      useImageViewerStore
        .getState()
        .openImage({ src: "data:image/png;base64,abc", alt: "diagram" });
    });

    expect(container.querySelector(".image-lightbox")).toBeTruthy();
    keyDown("Escape");
    expect(container.querySelector(".image-lightbox")).toBeNull();
    expect(parentEscape).not.toHaveBeenCalled();

    window.removeEventListener("keydown", parentEscape);
    unmount();
  });

  it("does not nest an interactive preview inside linked markdown images", () => {
    const { container, unmount } = mount(
      <>
        <Markdown>{"[![diagram](data:image/png;base64,thumb)](https://example.com/page)"}</Markdown>
        <ImageLightbox />
      </>,
    );

    expect(container.querySelector("a.markdown-image")).toBeTruthy();
    expect(container.querySelector("a.markdown-image button")).toBeNull();
    unmount();
  });

  it("opens the linked full-size image when markdown image links point to an image", () => {
    const { container, unmount } = mount(
      <>
        <Markdown>
          {"[![diagram](data:image/png;base64,thumb)](https://example.com/full.png)"}
        </Markdown>
        <ImageLightbox />
      </>,
    );

    const preview = container.querySelector<HTMLButtonElement>("button.markdown-image")!;
    expect(preview).toBeTruthy();

    act(() => {
      preview.click();
    });

    expect(container.querySelector<HTMLImageElement>(".image-lightbox__image")?.src).toBe(
      "https://example.com/full.png",
    );
    unmount();
  });

  it("navigates grouped images with arrow keys", () => {
    const { container, unmount } = mount(<ImageLightbox />);

    act(() => {
      useImageViewerStore.getState().openImages([
        { src: "data:image/png;base64,one", alt: "one" },
        { src: "data:image/png;base64,two", alt: "two" },
      ]);
    });

    expect(container.querySelector<HTMLImageElement>(".image-lightbox__image")?.alt).toBe("one");
    keyDown("ArrowRight");
    expect(container.querySelector<HTMLImageElement>(".image-lightbox__image")?.alt).toBe("two");
    keyDown("ArrowLeft");
    expect(container.querySelector<HTMLImageElement>(".image-lightbox__image")?.alt).toBe("one");
    unmount();
  });
});
