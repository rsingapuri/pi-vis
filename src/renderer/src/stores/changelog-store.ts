import { create } from "zustand";

interface ChangelogStore {
  open: boolean;
  markdown: string;
  openChangelog: (markdown: string) => void;
  closeChangelog: () => void;
}

export const useChangelogStore = create<ChangelogStore>((set) => ({
  open: false,
  markdown: "",

  openChangelog: (markdown) => set({ open: true, markdown }),
  closeChangelog: () => set({ open: false, markdown: "" }),
}));
