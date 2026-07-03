import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { useImageViewerStore } from "../../stores/image-viewer-store.js";
import { FadeText } from "./FadeText.js";
import { IconChevronLeft, IconChevronRight, IconClose } from "./icons.js";
import "./ImageLightbox.css";

export function ImageLightbox(): React.ReactElement | null {
  const open = useImageViewerStore((s) => s.open);
  const images = useImageViewerStore((s) => s.images);
  const index = useImageViewerStore((s) => s.index);
  const close = useImageViewerStore((s) => s.close);
  const next = useImageViewerStore((s) => s.next);
  const previous = useImageViewerStore((s) => s.previous);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEscapeClaim(open);

  const current = images[index];
  const canNavigate = images.length > 1;
  const title = current?.alt?.trim() || "Image preview";

  const handleClose = useCallback(() => {
    close();
  }, [close]);

  useEffect(() => {
    if (!open) return;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        handleClose();
        return;
      }
      if (e.key === "ArrowRight" && canNavigate) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        next();
        return;
      }
      if (e.key === "ArrowLeft" && canNavigate) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        previous();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, handleClose, canNavigate, next, previous]);

  if (!open || !current) return null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard close/navigation is handled by the global key listener above.
    <div
      className="image-lightbox"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="image-lightbox__dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="image-lightbox__header">
          <FadeText className="image-lightbox__title" title={title}>
            {title}
          </FadeText>
          {canNavigate && (
            <span className="image-lightbox__counter">
              {index + 1} / {images.length}
            </span>
          )}
          <button
            ref={closeBtnRef}
            type="button"
            className="image-lightbox__close icon-btn"
            onClick={handleClose}
            aria-label="Close image preview"
          >
            <IconClose />
          </button>
        </div>
        <div className="image-lightbox__body">
          {canNavigate && (
            <button
              type="button"
              className="image-lightbox__nav image-lightbox__nav--previous icon-btn"
              onClick={previous}
              aria-label="Previous image"
            >
              <IconChevronLeft />
            </button>
          )}
          <img className="image-lightbox__image" src={current.src} alt={current.alt ?? ""} />
          {canNavigate && (
            <button
              type="button"
              className="image-lightbox__nav image-lightbox__nav--next icon-btn"
              onClick={next}
              aria-label="Next image"
            >
              <IconChevronRight />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
