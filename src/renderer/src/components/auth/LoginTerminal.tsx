/**
 * LoginTerminal — embedded xterm.js terminal that runs pi's own interactive
 * `/login` flow (OAuth/subscription or API key).
 *
 * We render pi's real TUI inside a pty and detect success by watching
 * `auth.changed` (i.e. auth.json), never by scraping the terminal — so this
 * stays robust to any change in pi's login UI.
 */

import type { ProviderAuthStatus } from "@shared/auth.js";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settings-store.js";
import { getTheme } from "../../theme/registry.js";
import { basePanelTerminalOptions, buildXtermTheme } from "../../theme/xterm.js";
import { IconCheck, IconClose } from "../common/icons.js";
import "@xterm/xterm/css/xterm.css";
import "./LoginTerminal.css";

interface LoginTerminalProps {
  /** Snapshot of auth state before opening — used for success detection. */
  initialAuthStatus: ProviderAuthStatus[];
  onClose: () => void;
}

type Status = "connecting" | "connected" | "authenticated" | "error";

function resolveMonoFont(): string {
  const fromVar = getComputedStyle(document.documentElement).getPropertyValue("--font-code").trim();
  return fromVar || "ui-monospace, Menlo, monospace";
}

/**
 * Ensure the monospace font is loaded (both regular and bold) before xterm
 * measures its cell size. Otherwise pi's bold headings are measured with
 * fallback metrics and the glyphs render mis-spaced ("authenti cati on").
 */
async function ensureFontsReady(fontFamily: string): Promise<void> {
  const first = fontFamily.split(",")[0]?.trim();
  try {
    if (first) {
      await Promise.all([
        document.fonts.load(`14px ${first}`),
        document.fonts.load(`bold 14px ${first}`),
      ]);
    }
    await document.fonts.ready;
  } catch {
    // Best-effort; xterm still renders with a system fallback.
  }
}

export function LoginTerminal({
  initialAuthStatus,
  onClose,
}: LoginTerminalProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const ptyIdRef = useRef<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [errorMsg, setErrorMsg] = useState("");

  // Live re-theme: the OAuth terminal streams pi's role-identity ANSI indices,
  // which xterm resolves against `term.options.theme.extendedAnsi` at paint
  // time, so swapping the palette recolors the buffer with no reconnect.
  const activeColorScheme = useSettingsStore((s) => s.activeColorScheme);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = buildXtermTheme(getTheme(activeColorScheme));
  }, [activeColorScheme]);

  // One lifecycle effect: build the terminal, wire pty I/O, start the pty, and
  // tear everything down. Consolidated (not split across effects) so the pty is
  // always killed on unmount — including React StrictMode's dev-mode
  // mount→unmount→remount, which otherwise leaves an orphan pty streaming
  // duplicate output into the terminal.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let localPtyId: string | null = null;

    const fontFamily = resolveMonoFont();
    const activeColorScheme = useSettingsStore.getState().activeColorScheme;
    const term = new Terminal({
      ...basePanelTerminalOptions(),
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 14,
      fontFamily,
      theme: buildXtermTheme(getTheme(activeColorScheme)),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // User keystrokes → pty.
    const onDataDispose = term.onData((data) => {
      if (ptyIdRef.current) {
        void window.pivis.invoke("pty.write", { ptyId: ptyIdRef.current, data }).catch(() => {});
      }
    });

    // pi output → terminal. Filter by ptyId so a transient StrictMode orphan
    // can't write into this terminal.
    const unsubData = window.pivis.on("pty.data", ({ ptyId, data }) => {
      if (ptyId === ptyIdRef.current) term.write(data);
    });
    const unsubExit = window.pivis.on("pty.exit", ({ ptyId, exitCode }) => {
      if (ptyId !== ptyIdRef.current) return;
      if (exitCode !== 0) {
        setStatus("error");
        setErrorMsg(`Terminal exited with code ${exitCode}`);
      }
    });

    // Keep the pty sized to the rendered terminal.
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && ptyIdRef.current) {
        void window.pivis
          .invoke("pty.resize", { ptyId: ptyIdRef.current, cols: dims.cols, rows: dims.rows })
          .catch(() => {});
      }
    });

    void (async () => {
      await ensureFontsReady(fontFamily);
      if (disposed) return;

      term.open(container);
      fitAddon.fit();
      term.focus();
      termRef.current = term;
      resizeObserver.observe(container);

      const dims = fitAddon.proposeDimensions();
      const startOpts: { autoLogin: boolean; cols?: number; rows?: number } = { autoLogin: true };
      if (dims) {
        startOpts.cols = dims.cols;
        startOpts.rows = dims.rows;
      }

      try {
        const { ptyId } = await window.pivis.invoke("pty.start", startOpts);
        // Unmounted while starting (StrictMode/quick close) — kill the orphan.
        if (disposed) {
          void window.pivis.invoke("pty.kill", { ptyId }).catch(() => {});
          return;
        }
        localPtyId = ptyId;
        ptyIdRef.current = ptyId;
        setStatus("connected");
      } catch (err) {
        if (disposed) return;
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      disposed = true;
      onDataDispose.dispose();
      unsubData();
      unsubExit();
      resizeObserver.disconnect();
      if (localPtyId) {
        void window.pivis.invoke("pty.kill", { ptyId: localPtyId }).catch(() => {});
      }
      ptyIdRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, []);

  // Detect successful sign-in via auth.json changes (never by scraping the TUI).
  useEffect(() => {
    const prevSource = new Map(initialAuthStatus.map((p) => [p.key, p.source]));
    const unsub = window.pivis.on("auth.changed", ({ providers }) => {
      const signedIn = providers.some(
        (p) =>
          (p.source === "oauth" || p.source === "api_key") && prevSource.get(p.key) !== p.source,
      );
      if (signedIn) setStatus("authenticated");
    });
    return () => unsub();
  }, [initialAuthStatus]);

  const handleClose = useCallback(() => onClose(), [onClose]);

  return (
    <div className="login-terminal-overlay">
      <div className="login-terminal">
        <div className="login-terminal__header">
          <span className="login-terminal__title">Sign in to a provider</span>
          <button
            type="button"
            className="login-terminal__close icon-btn"
            onClick={handleClose}
            aria-label="Close"
          >
            <IconClose />
          </button>
        </div>

        {status === "error" && (
          <div className="login-terminal__error">
            <p>{errorMsg}</p>
            <button type="button" className="login-terminal__btn" onClick={handleClose}>
              Close
            </button>
          </div>
        )}

        {status === "authenticated" && (
          <div className="login-terminal__success">
            <p>
              <IconCheck /> Signed in successfully. You can now use this provider.
            </p>
            <button type="button" className="login-terminal__btn" onClick={handleClose}>
              Done
            </button>
          </div>
        )}

        <p className="login-terminal__hint">
          Finish signing in below — this runs pi&apos;s own <code>/login</code>. The window updates
          automatically when you&apos;re signed in.
        </p>

        <div ref={containerRef} className="login-terminal__xterm" />

        <div className="login-terminal__footer">
          {status === "connecting" && <span className="login-terminal__status">Connecting…</span>}
          {status === "connected" && (
            <span className="login-terminal__status login-terminal__status--live">
              Terminal active — follow the on-screen prompts
            </span>
          )}
          {status === "authenticated" && (
            <span className="login-terminal__status login-terminal__status--done">
              <IconCheck /> Authenticated
            </span>
          )}
          <button type="button" className="login-terminal__btn" onClick={handleClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
