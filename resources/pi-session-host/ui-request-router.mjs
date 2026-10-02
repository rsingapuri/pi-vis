/**
 * Build the host's UI/private-request sender.
 *
 * Public extension UI requests are reconstructable presentation and therefore
 * belong on the typed extension-UI authority plane. Host-private requests use
 * the same callback for convenience, but must stay only on the ordinary
 * owner-sequenced wire: their shapes are intentionally not
 * ExtensionUiRequestSchema-compatible.
 */
export function createUiRequestSender({
  send,
  publishExtensionUi,
  hostInstanceId,
  getSessionEpoch,
}) {
  if (typeof send !== "function") throw new TypeError("send must be a function");
  if (typeof publishExtensionUi !== "function") {
    throw new TypeError("publishExtensionUi must be a function");
  }
  if (typeof hostInstanceId !== "string" || hostInstanceId.length === 0) {
    throw new TypeError("hostInstanceId must be a non-empty string");
  }
  if (typeof getSessionEpoch !== "function") {
    throw new TypeError("getSessionEpoch must be a function");
  }

  let extensionUiRequestSequence = 0;
  return (request) => {
    if (request?.type !== "extension_ui_request") return send(request);

    // Fire-and-forget UI methods do not receive a Pi dialog ID, but the typed
    // presentation contract still requires stable request identity for replay
    // and baseline overlap. Dialog requests retain their existing IDs.
    const routed = {
      ...request,
      id: request.id ?? `extension-ui-${++extensionUiRequestSequence}`,
      // Presentation publications carry their owner in the envelope, but a
      // reconstructed dialog is later returned through the typed UI-response
      // contract itself. Keep that identity on the request so the renderer can
      // acknowledge the exact host/epoch.
      hostInstanceId,
      sessionEpoch: getSessionEpoch(),
    };
    publishExtensionUi(routed);
    return send(routed);
  };
}
