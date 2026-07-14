const DEFAULT_MAX_REPAINT_BYTES = 1024 * 1024;

/**
 * Host-owned panel reconstruction fence. ANSI deltas are deliberately not
 * retained: only a fresh, public pi-tui forced render can rebuild a terminal.
 */
export function createPanelReconstruction({ maxRepaintBytes = DEFAULT_MAX_REPAINT_BYTES } = {}) {
  const panels = new Map();
  const captureLimit = Math.max(1, Number(maxRepaintBytes) || DEFAULT_MAX_REPAINT_BYTES);

  function open(panelId) {
    const panel = {
      revision: 1,
      acknowledgedRevision: 0,
      repaintAnsi: undefined,
      repaintBytes: 0,
      sealed: false,
      overflowed: false,
    };
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
    panel.repaintAnsi = "";
    panel.repaintBytes = 0;
    panel.sealed = false;
    panel.overflowed = false;
    return baseline(panelId);
  }

  function write(panelId, data) {
    const panel = panels.get(panelId);
    if (!panel || panel.repaintAnsi === undefined || panel.overflowed) return;
    const bytes = Buffer.byteLength(data, "utf8");
    if (panel.repaintBytes + bytes > captureLimit) {
      // A truncated ANSI stream is not a keyframe. Discard it and keep input
      // fenced until a later forced repaint can produce a bounded complete one.
      panel.repaintAnsi = undefined;
      panel.repaintBytes = 0;
      panel.overflowed = true;
      return;
    }
    panel.repaintAnsi += data;
    panel.repaintBytes += bytes;
  }

  /** Seal the synchronous forced-render output before ordinary deltas resume. */
  function seal(panelId) {
    const panel = panels.get(panelId);
    if (!panel || panel.repaintAnsi === undefined || panel.overflowed) return undefined;
    panel.sealed = true;
    return pendingKeyframe(panelId);
  }

  /** Current bounded image, including deltas emitted while ack is in flight. */
  function keyframe(panelId) {
    return pendingKeyframe(panelId);
  }

  /** The already-published repaint frame remains the acknowledgement target. */
  function pendingKeyframe(panelId) {
    const panel = panels.get(panelId);
    if (!panel || panel.repaintAnsi === undefined || !panel.sealed) return undefined;
    return { ansi: panel.repaintAnsi, revision: panel.revision };
  }

  function acknowledge(panelId, revision) {
    const panel = panels.get(panelId);
    if (!panel || revision !== panel.revision || panel.repaintAnsi === undefined || !panel.sealed)
      return false;
    panel.acknowledgedRevision = revision;
    panel.repaintAnsi = undefined;
    panel.repaintBytes = 0;
    panel.sealed = false;
    return true;
  }

  function acceptsInput(panelId, revision) {
    const panel = panels.get(panelId);
    return !!panel && panel.revision === revision && panel.acknowledgedRevision === revision;
  }

  return {
    open,
    close,
    baseline,
    requireRepaint,
    write,
    seal,
    keyframe,
    pendingKeyframe,
    acknowledge,
    acceptsInput,
  };
}
