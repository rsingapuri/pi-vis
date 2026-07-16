import { AsyncLocalStorage } from "node:async_hooks";
import { test as base, expect } from "@playwright/test";
import type { Dialog, Page } from "@playwright/test";

export type InvariantKind =
  | "renderer-console"
  | "page-error"
  | "native-dialog"
  | "main-stderr"
  | "error-toast";

export type AllowMatcher = string | RegExp;
type InvariantIssue = { kind: InvariantKind; message: string };

/** The suite starts strict; expected diagnostics must be allowed by each test. */
export const DEFAULT_INVARIANT_ALLOWLIST: Readonly<Record<string, never>> = {};

const activeContext = new AsyncLocalStorage<InvariantContext>();
// Playwright resumes a test body in its own async continuation, outside an
// auto-fixture's AsyncLocalStorage scope. Keep the fixture-bound context as a
// fallback so test continuations and launch helpers retain their per-test
// allowlist. A worker executes tests serially; restore the prior value for
// nested fixture scopes.
let fixtureContext: InvariantContext | undefined;
const TOAST_BINDING = "__pivisInvariantErrorToast";
const MAIN_PROCESS_ERROR =
  /(?:error occurred in (?:event )?handler|(?:unhandled(?:\s+promise)?\s*rejection|unhandledrejection)|uncaught exception)/i;

export function matchesAllowMatcher(matcher: AllowMatcher, message: string): boolean {
  // Diagnostics are usually wrapped (Electron handler prefixes, toast
  // suffixes), so a string matcher is a substring match; use a RegExp with
  // anchors when a test genuinely needs exact-message strictness.
  if (typeof matcher === "string") return message.includes(matcher);
  matcher.lastIndex = 0;
  return matcher.test(message);
}

/** Splits process output into complete lines while retaining chunk boundaries. */
export function createLineBuffer(onLine: (line: string) => void): {
  push(chunk: Buffer | string): void;
  end(): void;
} {
  let buffered = "";
  const emit = (line: string): void => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  return {
    push(chunk) {
      buffered += chunk.toString();
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        emit(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    },
    end() {
      if (buffered) emit(buffered);
      buffered = "";
    },
  };
}

function assertAllowMatcher(matcher: unknown): asserts matcher is AllowMatcher {
  if (typeof matcher === "string" && matcher.length > 0) return;
  if (matcher instanceof RegExp) return;
  throw new Error("allowInvariant() requires a nonempty substring string or RegExp matcher");
}

export class InvariantContext {
  private readonly issues: InvariantIssue[] = [];
  private readonly allowlist = new Map<InvariantKind, AllowMatcher[]>();
  private readonly pages = new Set<Page>();
  private readonly stderrStreams = new Set<NodeJS.ReadableStream>();
  private readonly observedToasts = new Set<string>();

  allow(kind: InvariantKind, matcher: AllowMatcher): void {
    assertAllowMatcher(matcher);
    const matchers = this.allowlist.get(kind) ?? [];
    matchers.push(matcher);
    this.allowlist.set(kind, matchers);
  }

  record(kind: InvariantKind, message: string): void {
    this.issues.push({ kind, message: message.trim() || "<no diagnostic message>" });
  }

  private recordErrorToast(message: string): void {
    const normalized = message.trim() || "<empty error toast>";
    if (this.observedToasts.has(normalized)) return;
    this.observedToasts.add(normalized);
    this.record("error-toast", normalized);
  }

  registerStderr(stderr: NodeJS.ReadableStream | null | undefined): void {
    if (!stderr || this.stderrStreams.has(stderr)) return;
    this.stderrStreams.add(stderr);
    const lines = createLineBuffer((line) => {
      if (MAIN_PROCESS_ERROR.test(line)) this.record("main-stderr", line);
    });
    stderr.on("data", (chunk: Buffer | string) => lines.push(chunk));
    stderr.once("end", () => lines.end());
  }

  async registerPage(page: Page): Promise<void> {
    if (this.pages.has(page)) return;
    this.pages.add(page);
    page.on("console", (message) => {
      if (message.type() === "error") this.record("renderer-console", message.text());
    });
    page.on("pageerror", (error) => this.record("page-error", error.stack ?? error.message));
    page.on("dialog", (dialog: Dialog) => {
      const message = `${dialog.type()}: ${dialog.message()}`;
      this.record("native-dialog", message);
      // An unexpected native dialog must not turn the useful invariant failure
      // into an opaque test timeout. Expected dialogs must be allowlisted
      // before triggering them and accepted/dismissed by the test itself.
      if (!this.isAllowed({ kind: "native-dialog", message })) {
        void dialog.dismiss().catch(() => undefined);
      }
    });
    await this.observeErrorToasts(page);
  }

  private async observeErrorToasts(page: Page): Promise<void> {
    try {
      await page.exposeBinding(TOAST_BINDING, (_source, message: unknown) => {
        this.recordErrorToast(String(message));
      });
      await page.evaluate((binding) => {
        const seen = new WeakSet<Element>();
        const report = (): void => {
          for (const toast of Array.from(document.querySelectorAll(".notification-card--error"))) {
            if (seen.has(toast)) continue;
            seen.add(toast);
            const callback = (window as unknown as Record<string, unknown>)[binding];
            if (typeof callback === "function") {
              void Promise.resolve(callback(toast.textContent ?? "<empty error toast>")).catch(
                () => {},
              );
            }
          }
        };
        report();
        new MutationObserver(report).observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }, TOAST_BINDING);
    } catch {
      // A page may already be closing when its test finishes. Existing toast
      // observations remain valid, and closed pages cannot expose new UI.
    }
  }

  async collectTeardownToasts(): Promise<void> {
    for (const page of this.pages) {
      try {
        const messages = await page.locator(".notification-card--error").allTextContents();
        for (const message of messages) this.recordErrorToast(message);
      } catch {
        // The common explicit app.close() cleanup closes the page first. The
        // binding observer records any toast that appeared while it was live.
      }
    }
  }

  private isAllowed(issue: InvariantIssue): boolean {
    const matchers = this.allowlist.get(issue.kind) ?? [];
    return matchers.some((matcher) => matchesAllowMatcher(matcher, issue.message));
  }

  assert(): void {
    const unexpected = this.issues.filter((issue) => !this.isAllowed(issue));
    if (unexpected.length === 0) return;
    throw new Error(
      `E2E invariant violations:\n${unexpected
        .map((issue) => `- [${issue.kind}] ${issue.message}`)
        .join("\n")}`,
    );
  }
}

/** Allow an expected diagnostic only for the currently running test. */
export function allowInvariant(kind: InvariantKind, matcher: AllowMatcher): void {
  const context = activeContext.getStore() ?? fixtureContext;
  if (!context) throw new Error("allowInvariant() must be called from an invariant-harness test");
  context.allow(kind, matcher);
}

/** Used by instrumented-launch; it is intentionally undefined outside a test. */
export function activeInvariantContext(): InvariantContext | undefined {
  return activeContext.getStore() ?? fixtureContext;
}

export const test = base.extend<{ invariantContext: InvariantContext }>({
  invariantContext: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture callbacks require destructuring.
    async ({}, use) => {
      const context = new InvariantContext();
      const previous = fixtureContext;
      fixtureContext = context;
      try {
        await activeContext.run(context, async () => {
          await use(context);
        });
        await context.collectTeardownToasts();
      } finally {
        fixtureContext = previous;
        context.assert();
      }
    },
    { auto: true },
  ],
});

export { expect };
