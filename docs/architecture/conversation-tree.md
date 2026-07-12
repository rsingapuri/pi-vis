# Conversation tree

`/tree` opens the native conversation-DAG overlay and changes the active leaf in place; `/fork` creates a separate session. The SDK host uses pi's public `sessionManager.getTree`, `getLeafId`, `getBranch`, `appendLabelChange`, and `session.navigateTree` surfaces. Tree support is an SDK-host capability; when the installed pi lacks a required public method, the overlay reports it as unsupported without changing runtime mode.

## Wire format

`getTree()` is recursive and can exceed Electron contextBridge's nesting limit. The host therefore sends flat `{ entry, parentId, label?, labelTimestamp? }` nodes, so only shallow data crosses preload. The renderer reconstructs and traverses the nested presentation with explicit iterative stacks (`tree-flatten.ts`); session-controlled conversation depth must never become JavaScript call-stack depth.

After navigation, the returned in-memory root→leaf branch is converted by `entriesToTranscript`; Pi-Vis does not reread the session file because recently appended entries may not yet be persisted. Tree navigation is refused whenever the authoritative runtime snapshot is unavailable or non-idle. A successful navigation is an epoch transition: transition records and its terminal snapshot establish the new live state before the renderer resumes interaction.

The viewer mirrors the diff overlay's modal and Escape ownership conventions. Filtering is per-node, hidden ancestors reattach visible descendants, indentation follows actual visible branch points, and tool-result messages are identified from pi's assistant content.
