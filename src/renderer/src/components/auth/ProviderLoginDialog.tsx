import type { SessionId } from "@shared/ids.js";
import type { ProviderAuthUiRequest } from "@shared/pi-protocol/extension-ui.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { RENDERER_GENERATION } from "../../lib/renderer-generation.js";
import { IconCheck, IconCopy } from "../common/icons.js";
import "./ProviderLoginDialog.css";

export function ProviderLoginDialog({
  sessionId,
  request,
}: {
  sessionId: SessionId;
  request: ProviderAuthUiRequest;
}): React.ReactElement {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setValue("");
    setBusy(false);
    setCopied(false);
    const timer = window.setTimeout(() => rootRef.current?.focus(), 10);
    return () => window.clearTimeout(timer);
  }, []);

  const respond = useCallback(
    async (response: { value: string } | { cancelled: true }) => {
      if (busy || !request.hostInstanceId || request.sessionEpoch === undefined) return;
      setBusy(true);
      // Clear before crossing IPC so credentials never remain in component
      // state while main and the active host acknowledge the response.
      setValue("");
      try {
        await window.pivis.invoke("session.respondToUiRequest", {
          sessionId,
          rendererGeneration: RENDERER_GENERATION,
          expectedHostInstanceId: request.hostInstanceId,
          expectedSessionEpoch: request.sessionEpoch,
          operationId: request.operationId ?? request.id,
          response: {
            type: "extension_ui_response",
            id: request.id,
            operationId: request.operationId,
            ...response,
          },
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, request, sessionId],
  );

  const openUrl = useCallback(async (url: string) => {
    try {
      await window.pivis.invoke("app.openExternal", { url });
    } catch {
      // The main process rejects malformed or unsafe provider links. Keep the
      // sign-in surface available so the user can cancel or choose another flow.
    }
  }, []);

  const copyCode = useCallback(async () => {
    if (!request.deviceCode) return;
    try {
      await window.pivis.invoke("clipboard.writeText", { text: request.deviceCode });
      setCopied(true);
    } catch {
      // Copy remains best-effort; no toast should cover the sign-in controls.
    }
  }, [request.deviceCode]);

  const submit = (): void => {
    if (request.promptType !== "select") void respond({ value });
  };

  return (
    <div
      ref={rootRef}
      className="provider-login-dialog"
      role="dialog"
      aria-label={`Sign in to ${request.providerName}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          void respond({ cancelled: true });
        } else if (
          event.key === "Enter" &&
          request.phase === "prompt" &&
          request.promptType !== "select"
        ) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <div className="provider-login-dialog__heading">
        <div className="provider-login-dialog__eyebrow">Provider sign-in</div>
        <h2>Sign in to {request.providerName}</h2>
      </div>

      {request.phase === "error" ? (
        <p className="provider-login-dialog__message provider-login-dialog__message--error">
          {request.message ?? "Sign in could not be completed. Try again."}
        </p>
      ) : (
        request.message && <p className="provider-login-dialog__message">{request.message}</p>
      )}

      {(request.phase === "oauth" || request.phase === "device") && request.authUrl && (
        <button
          type="button"
          className="provider-login-dialog__primary"
          disabled={busy}
          onClick={() => void openUrl(request.authUrl!)}
        >
          Open browser
        </button>
      )}

      {request.deviceCode && (
        <div className="provider-login-dialog__code-block">
          <span>Device code</span>
          <div className="provider-login-dialog__code-row">
            <code>{request.deviceCode}</code>
            <button
              type="button"
              className="icon-btn"
              aria-label={copied ? "Copied code" : "Copy code"}
              title={copied ? "Copied" : "Copy code"}
              onClick={() => void copyCode()}
            >
              {copied ? <IconCheck /> : <IconCopy />}
            </button>
          </div>
        </div>
      )}

      {request.links?.map((link) => (
        <button
          type="button"
          className="provider-login-dialog__link"
          key={`${link.url}:${link.label ?? ""}`}
          onClick={() => void openUrl(link.url)}
        >
          {link.label ?? "Open link"}
        </button>
      ))}

      {request.phase === "prompt" && request.promptType === "select" && (
        <div className="provider-login-dialog__options" role="listbox">
          {request.options?.map((option) => (
            <button
              key={option.id}
              type="button"
              className="provider-login-dialog__option"
              disabled={busy}
              onClick={() => void respond({ value: option.id })}
              role="option"
              aria-selected="false"
            >
              <span>{option.label}</span>
              {option.description && <small>{option.description}</small>}
            </button>
          ))}
        </div>
      )}

      {request.phase === "prompt" && request.promptType !== "select" && (
        <label className="provider-login-dialog__field">
          <span>{request.prompt ?? "Continue sign-in"}</span>
          <input
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            type={request.promptType === "secret" ? "password" : "text"}
            value={value}
            placeholder={request.placeholder ?? ""}
            onChange={(event) => setValue(event.target.value)}
            autoFocus
          />
        </label>
      )}

      <div className="provider-login-dialog__actions">
        {request.phase === "prompt" && request.promptType !== "select" && (
          <button
            type="button"
            className="provider-login-dialog__primary"
            disabled={busy || value.length === 0}
            onClick={submit}
          >
            Continue
          </button>
        )}
        <button
          type="button"
          className="provider-login-dialog__cancel"
          disabled={busy}
          onClick={() => void respond({ cancelled: true })}
        >
          {request.phase === "error" ? "Close" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
