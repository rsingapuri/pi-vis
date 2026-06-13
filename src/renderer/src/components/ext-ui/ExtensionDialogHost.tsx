import type { SessionId } from "@shared/ids.js";
import type { DialogUiRequest, ExtensionUiResponse } from "@shared/pi-protocol/extension-ui.js";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionsStore } from "../../stores/sessions-store.js";
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
      <div className="ext-dialog__title ext-dialog__title--question">
        {req.title}
        {typeof req.timeout === "number" && req.timeout > 0 && (
          <span className="ext-dialog__countdown">
            auto-dismisses in {Math.ceil(req.timeout / 1000)}s
          </span>
        )}
      </div>
      <div className="ext-dialog__options" ref={listRef} role="listbox">
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
      </div>
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
  const current = session?.pendingDialogs[0] as DialogUiRequest | undefined;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleRespond = useCallback(
    async (requestId: string, response: Record<string, unknown>) => {
      dismissUiRequest(sessionId, requestId);
      if (timerRef.current) clearTimeout(timerRef.current);

      const payload = {
        type: "extension_ui_response" as const,
        id: requestId,
        ...response,
      };

      await window.pivis.invoke("session.respondToUiRequest", {
        sessionId,
        response: payload as ExtensionUiResponse,
      });
    },
    [sessionId, dismissUiRequest],
  );

  // Auto-dismiss on timeout. Per the pi protocol (docs/rpc.md), `timeout`
  // is in milliseconds and the dialog is fire-and-forget on expiry: pi
  // auto-resolves the request with the default value client-side, so we
  // simply drop our local state — sending a `cancelled: true` would
  // actually be a user choice, not a timeout, and would clobber pi's
  // resolution. The old behaviour multiplied by 1000 (10s → 2.8h) which
  // was the source of the seconds-bug e2e regression.
  useEffect(() => {
    if (!current) return;
    const timeout = (current as { timeout?: number }).timeout;
    if (!timeout) return;

    timerRef.current = setTimeout(() => {
      // Drop the dialog locally; do NOT send a response.
      dismissUiRequest(sessionId, current.id);
    }, timeout);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [current, dismissUiRequest, sessionId]);

  if (!current) return null;

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

export function ToastHost({ sessionId }: { sessionId: SessionId }): React.ReactElement | null {
  const session = useSessionsStore((s) => s.sessions.get(sessionId));
  const dismissToast = useSessionsStore((s) => s.dismissToast);
  const toasts = session?.toasts ?? [];

  useEffect(() => {
    if (toasts.length === 0) return;
    const oldest = toasts[0];
    if (!oldest) return;
    // Time out the oldest toast relative to its creation, not "now".
    // Resetting on every change to the array was the bug: adding a new
    // toast would re-fire the timer for the existing one, so old toasts
    // could linger indefinitely.
    const remaining = Math.max(0, oldest.createdAt + 4000 - Date.now());
    const timer = setTimeout(() => dismissToast(sessionId, oldest.id), remaining);
    return () => clearTimeout(timer);
  }, [toasts, sessionId, dismissToast]);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host">
      {toasts.map((toast) => (
        <button
          type="button"
          key={toast.id}
          className={`toast toast--${toast.type ?? "info"}`}
          onClick={() => dismissToast(sessionId, toast.id)}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
