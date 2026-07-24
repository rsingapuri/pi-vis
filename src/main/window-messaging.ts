export interface WindowMessageTarget {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

/**
 * Best-effort main-to-renderer delivery.
 *
 * Electron can destroy a BrowserWindow/webContents between the destroyed
 * checks and `send()`. Keep that lifecycle race out of main-process event
 * callbacks: losing a renderer notification is preferable to crashing main.
 */
export function safeSendToWindow(
  target: WindowMessageTarget | null | undefined,
  channel: string,
  payload: unknown,
  onError?: (error: unknown) => void,
): boolean {
  try {
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return false;
    target.webContents.send(channel, payload);
    return true;
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      // Diagnostics must not turn a best-effort notification into a crash.
    }
    return false;
  }
}
