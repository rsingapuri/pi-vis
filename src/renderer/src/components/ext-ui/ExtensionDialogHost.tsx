import type { SessionId } from "@shared/ids.js";
import type {
  DialogUiRequest,
  ExtensionUiResponse,
  ProviderAuthUiRequest,
} from "@shared/pi-protocol/extension-ui.js";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { RENDERER_GENERATION } from "../../lib/renderer-generation.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { ProviderLoginDialog } from "../auth/ProviderLoginDialog.js";
import { ScrollFadeFrame } from "../common/ScrollFadeFrame.js";
import "./ExtensionDialogHost.css";

interface ExtensionDialogHostProps {
  sessionId: SessionId;
}

interface DialogProps {
  request: DialogUiRequest;
  onRespond: (requestId: string, response: Record<string, unknown>) => void;
}

function SelectDialog({ request, onRespond }: DialogProps): React.ReactElement {
  const req = request as {
    id: string;
    method: "select";
    title: string;
    options: string[];
    timeout?: number;
  };
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => dialogRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, []);

  // Scroll the highlighted option into view (mirrors SessionHeader).
  useEffect(() => {
    const btn = itemRefs.current.get(highlightedIndex);
    btn?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  return (
    <div
      className="ext-dialog"
      role="dialog"
      tabIndex={-1}
      ref={dialogRef}
      onKeyDown={(e) => {
        switch (e.key) {
          case "ArrowDown":
            e.preventDefault();
            setHighlightedIndex((i) => (i < req.options.length - 1 ? i + 1 : 0));
            break;
          case "ArrowUp":
            e.preventDefault();
            setHighlightedIndex((i) => (i > 0 ? i - 1 : req.options.length - 1));
            break;
          case "Home":
            e.preventDefault();
            setHighlightedIndex(0);
            break;
          case "End":
            e.preventDefault();
            setHighlightedIndex(req.options.length - 1);
            break;
          case "Enter":
            e.preventDefault();
            {
              const opt = req.options[highlightedIndex];
              if (opt !== undefined) onRespond(req.id, { value: opt });
            }
            break;
          case "Escape":
            e.preventDefault();
            onRespond(req.id, { cancelled: true });
            break;
          default:
            break;
        }
      }}
    >
      <div className="ext-dialog__title">
        {req.title}
        {typeof req.timeout === "number" && req.timeout > 0 && (
          <span className="ext-dialog__countdown">
            auto-dismisses in {Math.ceil(req.timeout / 1000)}s
          </span>
        )}
      </div>
      <ScrollFadeFrame
        frameClassName="ext-dialog__options-frame"
        scrollerRef={listRef}
        className="ext-dialog__options"
        role="listbox"
      >
        {req.options.map((opt, idx) => (
          <button
            type="button"
            key={opt}
            ref={(el) => {
              if (el) itemRefs.current.set(idx, el);
              else itemRefs.current.delete(idx);
            }}
            role="option"
            aria-selected={idx === highlightedIndex}
            className={`ext-dialog__option${idx === highlightedIndex ? " ext-dialog__option--highlighted" : ""}`}
            onClick={() => onRespond(req.id, { value: opt })}
            onMouseEnter={() => setHighlightedIndex(idx)}
          >
            {opt}
          </button>
        ))}
      </ScrollFadeFrame>
      <div className="ext-dialog__hint">↑↓ navigate · enter to select</div>
      <button
        type="button"
        className="ext-dialog__cancel"
        onClick={() => onRespond(req.id, { cancelled: true })}
      >
        Cancel
      </button>
    </div>
  );
}

function ConfirmDialog({ request, onRespond }: DialogProps): React.ReactElement {
  const req = request as {
    id: string;
    method: "confirm";
    title: string;
    message?: string;
    timeout?: number;
  };
  const [remaining, setRemaining] = useState<number | null>(
    typeof req.timeout === "number" ? Math.ceil(req.timeout / 1000) : null,
  );
  useEffect(() => {
    if (typeof req.timeout !== "number" || req.timeout <= 0) return;
    setRemaining(Math.ceil(req.timeout / 1000));
    const id = setInterval(() => {
      setRemaining((r) => (r == null ? null : Math.max(0, r - 1)));
    }, 1000);
    return () => clearInterval(id);
  }, [req.timeout]);
  return (
    <div className="ext-dialog" role="dialog">
      <div className="ext-dialog__title">
        {req.title}
        {remaining != null && remaining > 0 && (
          <span className="ext-dialog__countdown">auto-dismisses in {remaining}s</span>
        )}
      </div>
      {req.message && <div className="ext-dialog__message">{req.message}</div>}
      <div className="ext-dialog__actions">
        <button
          type="button"
          className="ext-dialog__btn ext-dialog__btn--confirm"
          onClick={() => onRespond(req.id, { confirmed: true })}
        >
          Confirm
        </button>
        <button
          type="button"
          className="ext-dialog__btn ext-dialog__btn--cancel"
          onClick={() => onRespond(req.id, { cancelled: true })}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function InputDialog({ request, onRespond }: DialogProps): React.ReactElement {
  const req = request as { id: string; method: "input"; title: string; placeholder?: string };
  const [value, setValue] = useState("");
  return (
    <div className="ext-dialog">
      <div className="ext-dialog__title">{req.title}</div>
      <input
        className="ext-dialog__input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={req.placeholder ?? ""}
        onKeyDown={(e) => {
          if (e.key === "Enter") onRespond(req.id, { value });
          if (e.key === "Escape") onRespond(req.id, { cancelled: true });
        }}
        autoFocus
      />
      <div className="ext-dialog__actions">
        <button
          type="button"
          className="ext-dialog__btn ext-dialog__btn--confirm"
          onClick={() => onRespond(req.id, { value })}
        >
          OK
        </button>
        <button
          type="button"
          className="ext-dialog__btn ext-dialog__btn--cancel"
          onClick={() => onRespond(req.id, { cancelled: true })}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function EditorDialog({ request, onRespond }: DialogProps): React.ReactElement {
  const req = request as { id: string; method: "editor"; title: string; prefill?: string };
  const [value, setValue] = useState(req.prefill ?? "");
  return (
    <div className="ext-dialog ext-dialog--editor">
      <div className="ext-dialog__title">{req.title}</div>
      <textarea
        className="ext-dialog__editor"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <div className="ext-dialog__actions">
        <button
          type="button"
          className="ext-dialog__btn ext-dialog__btn--confirm"
          onClick={() => onRespond(req.id, { value })}
        >
          OK
        </button>
        <button
          type="button"
          className="ext-dialog__btn ext-dialog__btn--cancel"
          onClick={() => onRespond(req.id, { cancelled: true })}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ExtensionDialogHost({
  sessionId,
}: ExtensionDialogHostProps): React.ReactElement | null {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const dismissUiRequest = useSessionsStore((s) => s.dismissUiRequest);
  const current = session?.pendingDialogs[0] as
    | (DialogUiRequest | ProviderAuthUiRequest)
    | undefined;
  const [responding, setResponding] = useState(false);

  // Claim ESC while a dialog is open so a background streaming session isn't
  // aborted (the dialog's own controls respond/cancel).
  useEscapeClaim(!!current);

  const handleRespond = useCallback(
    async (requestId: string, response: Record<string, unknown>) => {
      if (responding || !current?.hostInstanceId || current.sessionEpoch === undefined) return;
      setResponding(true);
      const payload = {
        type: "extension_ui_response" as const,
        id: requestId,
        ...response,
      };

      try {
        const result = await window.pivis.invoke("session.respondToUiRequest", {
          sessionId,
          rendererGeneration: RENDERER_GENERATION,
          expectedHostInstanceId: current.hostInstanceId,
          expectedSessionEpoch: current.sessionEpoch,
          operationId:
            (current as (DialogUiRequest & { operationId?: string }) | undefined)?.operationId ??
            requestId,
          response: payload as ExtensionUiResponse,
        });
        if (result.acknowledged) dismissUiRequest(sessionId, requestId);
      } finally {
        setResponding(false);
      }
    },
    [sessionId, dismissUiRequest, current, responding],
  );

  // Timeout and AbortSignal cancellation are enforced by the host. The request
  // stays visible until the correlated host acknowledgement arrives.
  if (!current) return null;
  if (current.method === "providerAuth") {
    return <ProviderLoginDialog sessionId={sessionId} request={current} />;
  }

  // No modal overlay: the dialog lives in the Composer slot so the
  // transcript, status bar, session header (model + thinking level) and
  // diff viewer remain interactive. The parent renders this host in
  // place of the Composer when a dialog is pending, so the two are
  // never both visible.
  return (
    <div className="ext-dialog-slot">
      {current.method === "select" && <SelectDialog request={current} onRespond={handleRespond} />}
      {current.method === "confirm" && (
        <ConfirmDialog request={current} onRespond={handleRespond} />
      )}
      {current.method === "input" && <InputDialog request={current} onRespond={handleRespond} />}
      {current.method === "editor" && <EditorDialog request={current} onRespond={handleRespond} />}
    </div>
  );
}
