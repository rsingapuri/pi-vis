import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("global CSS", () => {
  it("themes browser text selection with semantic accent tokens", () => {
    const css = readFileSync(join(__dirname, "global.css"), "utf8");

    expect(css).toMatch(
      /::selection\s*{[^}]*color:\s*var\(--on-accent\);[^}]*background:\s*var\(--accent-fill\);[^}]*}/s,
    );
  });

  it("keeps keyboard focus inside component geometry", () => {
    const rendererRoot = dirname(__filename);
    const globalCss = readFileSync(join(__dirname, "global.css"), "utf8");
    const themeCss = readFileSync(join(__dirname, "theme/theme.css"), "utf8");
    const cssFiles = readdirSync(rendererRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
      .map((entry) => join(entry.parentPath, entry.name));

    expect(globalCss).toMatch(
      /:focus-visible\s*{[^}]*outline:\s*1px solid[^}]*outline-offset:\s*-1px;/s,
    );
    expect(themeCss).toMatch(
      /\.icon-btn:is\(:hover, :focus-visible\):not\(:disabled\)\s*{[^}]*background:\s*var\(--surface-2\);[^}]*color:\s*var\(--text\);/s,
    );

    for (const file of cssFiles) {
      const relative = file.slice(rendererRoot.length + 1);
      const css = readFileSync(file, "utf8");
      expect(css, relative).not.toMatch(/outline-offset:\s*(?:[1-9]|\d{2,})(?:px|rem|em)\b/u);
      expect(css, relative).not.toMatch(
        /\.(?:picker-slot|ext-dialog-slot|custom-panel)\s+:focus-visible\s*\{/u,
      );
    }
  });

  it("keeps visible scrollbar chrome app-wide with only sanctioned hidden-thumb exceptions", () => {
    const rendererRoot = dirname(__filename);
    const cssFiles = readdirSync(rendererRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
      .map((entry) => join(entry.parentPath, entry.name));
    const sanctioned = new Map<string, RegExp[]>([
      [
        "components/transcript/TranscriptView.css",
        [
          /\.transcript-view--pinned::-webkit-scrollbar-thumb/gu,
          /\.transcript-view--pinned::-webkit-scrollbar-thumb:hover/gu,
        ],
      ],
      ["components/shell/Sidebar.css", [/\.sidebar__workspaces::-webkit-scrollbar/gu]],
      [
        "components/notifications/NotificationStack.css",
        [/\.notification-stack__list::-webkit-scrollbar/gu],
      ],
    ]);

    for (const file of cssFiles) {
      const relative = file.slice(rendererRoot.length + 1);
      if (relative === "theme/theme.css") continue;
      let css = readFileSync(file, "utf8");
      for (const pattern of sanctioned.get(relative) ?? []) css = css.replace(pattern, "");
      expect(css, relative).not.toContain("::-webkit-scrollbar");
      if (!sanctioned.has(relative)) {
        expect(css, relative).not.toMatch(/scrollbar-(?:width|color)\s*:/u);
      }
    }
  });

  it("nests scrollbar tracks with one axis-aware global end inset", () => {
    const css = readFileSync(join(__dirname, "theme/theme.css"), "utf8");

    expect(css).toMatch(
      /::-webkit-scrollbar-track:vertical\s*{[^}]*margin-block:\s*var\(--space-1\);/s,
    );
    expect(css).toMatch(
      /::-webkit-scrollbar-track:horizontal\s*{[^}]*margin-inline:\s*var\(--space-1\);/s,
    );
  });

  it("makes every explicitly vertical scroll owner horizontal-proof", () => {
    const rendererRoot = dirname(__filename);
    const cssFiles = readdirSync(rendererRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
      .map((entry) => join(entry.parentPath, entry.name));

    for (const file of cssFiles) {
      const relative = file.slice(rendererRoot.length + 1);
      const css = readFileSync(file, "utf8");
      for (const rule of css.matchAll(/(?<selector>[^{}]+)\{(?<body>[^{}]*)}/gs)) {
        const body = rule.groups?.body ?? "";
        if (!/overflow-y:\s*auto/u.test(body)) continue;
        expect(body, `${relative}: ${rule.groups?.selector?.trim() ?? "unknown rule"}`).toMatch(
          /overflow-x:\s*hidden/u,
        );
      }
    }
  });
});
