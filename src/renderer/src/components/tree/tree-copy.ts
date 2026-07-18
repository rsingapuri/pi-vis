/** Pure copy-ownership guard for the tree's Cmd/Ctrl+C shortcut. */
export function canCopyTreeSelection(
  target: HTMLElement | null,
  hasNativeSelection: boolean,
): boolean {
  if (hasNativeSelection || !target) return false;
  return !target.isContentEditable && !target.closest("input, textarea, select, [contenteditable]");
}
