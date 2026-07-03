import { create } from "zustand";

export interface ImageViewerItem {
  src: string;
  alt?: string | undefined;
}

interface ImageViewerStore {
  open: boolean;
  images: ImageViewerItem[];
  index: number;
  openImage: (image: ImageViewerItem) => void;
  openImages: (images: ImageViewerItem[], index?: number) => void;
  close: () => void;
  next: () => void;
  previous: () => void;
}

function normalizeImages(images: ImageViewerItem[]): ImageViewerItem[] {
  return images.filter((image) => image.src.trim().length > 0);
}

export const useImageViewerStore = create<ImageViewerStore>((set) => ({
  open: false,
  images: [],
  index: 0,

  openImage: (image) => {
    const normalized = normalizeImages([image]);
    if (normalized.length === 0) return;
    set({ open: true, images: normalized, index: 0 });
  },

  openImages: (images, index = 0) => {
    const normalized = normalizeImages(images);
    if (normalized.length === 0) return;
    const safeIndex = Math.max(0, Math.min(index, normalized.length - 1));
    set({ open: true, images: normalized, index: safeIndex });
  },

  close: () => set({ open: false, images: [], index: 0 }),

  next: () =>
    set((state) => {
      if (state.images.length <= 1) return state;
      return { index: (state.index + 1) % state.images.length };
    }),

  previous: () =>
    set((state) => {
      if (state.images.length <= 1) return state;
      return { index: (state.index - 1 + state.images.length) % state.images.length };
    }),
}));
