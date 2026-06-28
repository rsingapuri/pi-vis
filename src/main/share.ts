/**
 * /share — export the session to a secret GitHub gist and return the
 * pi.dev share viewer URL.
 *
 * Mirrors pi's TUI `handleShareCommand()` (interactive-mode.js:4341). The
 * error strings for the gh-missing and gh-not-logged-in cases are pi's
 * EXACT messages — a hard requirement so /share reads identically in
 * pi-vis and the terminal.
 *
 * Host-vs-main split: `gh` is spawned and the temp file is written here in
 * MAIN because (a) main already owns `getSubprocessEnv` (the login-shell
 * env that puts `gh` on PATH for GUI-launched apps — the host inherits
 * process.env but not the resolved login-shell PATH), and (b) the HTML
 * content comes from the host's `export_html` bridge command, which main
 * already knows how to route (via the session registry's sendCommand).
 * Keeping the gh spawn in main means one source of truth for the env and
 * for the exact error wording.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionId } from "@shared/ids.js";
import { getSubprocessEnv } from "./auth.js";
import type { SessionRegistry } from "./sessions/session-registry.js";

// pi's exact TUI messages for the two gh failure cases. Do not reword —
// /share must read identically in pi-vis and the terminal.
export const GH_NOT_INSTALLED_MESSAGE =
  "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/";
export const GH_NOT_LOGGED_IN_MESSAGE = "GitHub CLI is not logged in. Run 'gh auth login' first.";

/**
 * Compute the pi.dev share viewer URL for a gist ID.
 *
 * Mirrors pi's `getShareViewerUrl` (config.js:404): base URL overridable via
 * the `PI_SHARE_VIEWER_URL` env var, default `https://pi.dev/session/`, with
 * the gist ID appended after `#`.
 */
export function getShareViewerUrl(gistId: string): string {
  const baseUrl = process.env["PI_SHARE_VIEWER_URL"] || "https://pi.dev/session/";
  return `${baseUrl}#${gistId}`;
}

export interface ShareResult {
  ok: true;
  url: string;
  gistUrl: string;
}

export interface ShareError {
  ok: false;
  error: string;
}

/**
 * Create a secret gist from the session's HTML export and return the share URL.
 *
 * Flow (mirrors pi's handleShareCommand):
 *   1. Check `gh auth status` (spawnSync) — missing → GH_NOT_INSTALLED_MESSAGE,
 *      non-zero exit → GH_NOT_LOGGED_IN_MESSAGE.
 *   2. Export the session to a temp HTML file via the host's `export_html`
 *      bridge command (routed through the session registry).
 *   3. `gh gist create --public=false <tmpfile>` — capture stdout (gist URL).
 *   4. Parse the gist ID (last path segment), compute the viewer URL.
 *   5. Clean up the temp file.
 */
export async function createGistForSession(
  sessionId: SessionId,
  registry: SessionRegistry,
): Promise<ShareResult | ShareError> {
  const env = await getSubprocessEnv();

  // ── 1. gh availability + auth ────────────────────────────────────────
  // spawnSync on a missing binary does NOT throw — it returns
  // { status: null, error: { code: "ENOENT" } }. So a bare status !== 0
  // check would misreport a missing gh as "not logged in". Check the
  // ENOENT/null-status case first.
  try {
    const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8", env });
    // spawnSync's .error on a missing binary is an ErrnoException with .code;
    // cast to access it (Node types .error as Error, not ErrnoException).
    const errCode = (authResult.error as NodeJS.ErrnoException | undefined)?.code;
    if (errCode === "ENOENT" || authResult.status === null) {
      return { ok: false, error: GH_NOT_INSTALLED_MESSAGE };
    }
    if (authResult.status !== 0) {
      return { ok: false, error: GH_NOT_LOGGED_IN_MESSAGE };
    }
  } catch {
    return { ok: false, error: GH_NOT_INSTALLED_MESSAGE };
  }

  // ── 2. Export the session HTML to a temp file ────────────────────────
  // pi writes to os.tmpdir()/session.html; we use a unique name to avoid
  // collisions between concurrent /share invocations.
  const tmpFile = path.join(os.tmpdir(), `pi-vis-session-${process.pid}-${Date.now()}.html`);
  try {
    let exportRes: { success: boolean; data?: { path?: string }; error?: string };
    try {
      exportRes = (await registry.sendCommand(sessionId, {
        type: "export_html",
        outputPath: tmpFile,
      })) as { success: boolean; data?: { path?: string }; error?: string };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (!exportRes.success) {
      return {
        ok: false,
        error: `Failed to export session: ${exportRes.error ?? "Unknown error"}`,
      };
    }

    // ── 3. Create the secret gist ────────────────────────────────────────
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    // Inner try: only the gist spawn. Cleanup is the outer finally so a
    // throw/fail in step 2 still unlinks tmpFile.
    try {
      const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
        (resolve) => {
          const proc = spawn("gh", ["gist", "create", "--public=false", tmpFile], { env });
          proc.stdout?.on("data", (data) => {
            stdout += data.toString();
          });
          proc.stderr?.on("data", (data) => {
            stderr += data.toString();
          });
          proc.on("close", (code) => resolve({ stdout, stderr, code }));
          proc.on("error", (err) => {
            resolve({
              stdout: "",
              stderr: err.message,
              code: null,
            });
          });
        },
      );
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.code;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (exitCode !== 0) {
      const errorMsg = stderr.trim() || "Unknown error";
      return { ok: false, error: `Failed to create gist: ${errorMsg}` };
    }

    // ── 4. Parse the gist ID + compute the viewer URL ────────────────────
    // gh returns something like: https://gist.github.com/username/GIST_ID
    const gistUrl = stdout.trim();
    const gistId = gistUrl.split("/").pop();
    if (!gistId) {
      return { ok: false, error: "Failed to parse gist ID from gh output" };
    }

    return { ok: true, url: getShareViewerUrl(gistId), gistUrl };
  } finally {
    // Clean up the temp file in ALL paths — export failure, gist failure,
    // and success. Best-effort (pi ignores cleanup errors too).
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}
