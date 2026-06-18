import { useDiffStore } from "../../stores/diff-store.js";
import { BranchDropdown } from "../common/BranchDropdown.js";

/**
 * Thin wrapper that connects the diff store to the presentational
 * BranchDropdown. The diff viewer's dropdown always includes "HEAD"
 * as a leading item (value=null means HEAD).
 */
export function BaseBranchDropdown(): React.ReactElement {
  const branches = useDiffStore((s) => s.branches);
  const currentBranch = useDiffStore((s) => s.currentBranch);
  const selectedBase = useDiffStore((s) => s.selectedBase);
  const includeRemoteBranches = useDiffStore((s) => s.includeRemoteBranches);
  const setBase = useDiffStore((s) => s.setBase);
  const setIncludeRemoteBranches = useDiffStore((s) => s.setIncludeRemoteBranches);

  return (
    <BranchDropdown
      branches={branches}
      currentBranch={currentBranch}
      value={selectedBase}
      onChange={setBase}
      includeRemoteBranches={includeRemoteBranches}
      onToggleRemote={() => setIncludeRemoteBranches(!includeRemoteBranches)}
      leadingItem={{ label: "HEAD" }}
      triggerLabel={selectedBase ?? "HEAD"}
    />
  );
}
