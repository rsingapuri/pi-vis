/**
 * Host-owned panel reconstruction fence. ANSI deltas are deliberately not
 * retained: only a fresh, public pi-tui forced render can rebuild a terminal.
 */
export function createPanelReconstruction() {
  const panels = new Map();

  function open(panelId) {
    const panel = { revision: 1, acknowledgedRevision: 0, repaintAnsi: undefined };
    panels.set(panelId, panel);
    return baseline(panelId);
  }

  function close(panelId) {
    panels.delete(panelId);
  }

  function baseline(panelId) {
    const panel = panels.get(panelId);
    if (!panel) return undefined;
    return {
      revision: panel.revision,
      repaintRequired: panel.acknowledgedRevision !== panel.revision,
    };
  }

  function requireRepaint(panelId) {
    const panel = panels.get(panelId);
    if (!panel) return undefined;
    panel.revision += 1;
    // Retain only bytes produced by this one forced full repaint, never an
    // unbounded terminal history. This capture is discarded at acknowledgement;
    // a later remount must force and capture a fresh reconstruction.
    panel.repaintAnsi = "";
    return baseline(panelId);
  }

  function write(panelId, data) {
    const panel = panels.get(panelId);
    if (panel?.repaintAnsi !== undefined) panel.repaintAnsi += data;
  }

  function keyframe(panelId) {
    const panel = panels.get(panelId);
    if (!panel || panel.repaintAnsi === undefined) return undefined;
    return { ansi: panel.repaintAnsi, revision: panel.revision };
  }

  function acknowledge(panelId, revision) {
    const panel = panels.get(panelId);
    if (!panel || revision !== panel.revision || panel.repaintAnsi === undefined) return false;
    panel.acknowledgedRevision = revision;
    // A published authority keyframe is now the renderer's reconstruction;
    // retaining its ANSI here would leak one full terminal per open panel.
    panel.repaintAnsi = undefined;
    return true;
  }

  function acceptsInput(panelId, revision) {
    const panel = panels.get(panelId);
    return !!panel && panel.revision === revision && panel.acknowledgedRevision === revision;
  }

  return { open, close, baseline, requireRepaint, write, keyframe, acknowledge, acceptsInput };
}
