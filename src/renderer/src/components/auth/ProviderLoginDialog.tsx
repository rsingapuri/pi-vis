import type { SessionId } from "@shared/ids.js";
import { useCallback, useState } from "react";
import type { ProviderAuthUiRequest } from "../../../../shared/pi-protocol/extension-ui.js";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { useSessionsStore } from "../../stores/sessions-store.js";

export function ProviderLoginDialog({
  sessionId,
  request,
}: { sessionId: SessionId; request: ProviderAuthUiRequest }) {
  const dismiss = useSessionsStore((s) => s.dismissUiRequest);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  useEscapeClaim(true);
  const respond = useCallback(
    async (response: Record<string, unknown>) => {
      if (busy || !request.hostInstanceId || request.sessionEpoch === undefined) return;
      setBusy(true);
      const secret = value;
      setValue(""); // never retain key/password after dispatch
      try {
        const result = await window.pivis.invoke("session.respondToUiRequest", {
          sessionId,
          rendererGeneration: 0,
          expectedHostInstanceId: request.hostInstanceId,
          expectedSessionEpoch: request.sessionEpoch,
          operationId: request.operationId ?? request.id,
          response:
            response.cancelled === true
              ? { type: "extension_ui_response", id: request.id, cancelled: true as const }
              : { type: "extension_ui_response", id: request.id, value: secret },
        });
        if (result.acknowledged) dismiss(sessionId, request.id);
      } finally {
        setBusy(false);
      }
    },
    [busy, dismiss, request, sessionId, value],
  );
  return (
    <div className="ext-dialog-slot provider-login-dialog">
      <h2>Sign in to {request.providerName}</h2>
      {request.message && <p>{request.message}</p>}
      {request.authUrl && (
        <button type="button" onClick={() => window.open(request.authUrl, "_blank", "noopener")}>
          Open browser
        </button>
      )}
      {request.deviceCode && (
        <p>
          <code>{request.deviceCode}</code>
        </p>
      )}
      {request.prompt && (
        <label>
          {request.prompt}
          <input
            autoComplete="off"
            type={request.secret ? "password" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
      )}
      {request.options?.map((option) => (
        <button
          key={option}
          type="button"
          disabled={busy}
          onClick={() => respond({ value: option })}
        >
          {option}
        </button>
      ))}
      {request.prompt && (
        <button type="button" disabled={busy} onClick={() => respond({ value: true })}>
          Continue
        </button>
      )}
      <button type="button" disabled={busy} onClick={() => respond({ cancelled: true })}>
        Cancel
      </button>
    </div>
  );
}
