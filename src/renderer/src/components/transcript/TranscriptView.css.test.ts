import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("TranscriptView CSS", () => {
  it("shows the shared scrollbar only while the transcript is unpinned", () => {
    const css = readFileSync(new URL("./TranscriptView.css", import.meta.url), "utf8");

    const transcriptRule = css.match(/\.transcript-view\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const pinnedThumbRule =
      css.match(
        /\.transcript-view--pinned::-webkit-scrollbar-thumb,\s*\.transcript-view--pinned::-webkit-scrollbar-thumb:hover\s*{(?<body>[^}]*)}/s,
      )?.groups?.body ?? "";

    expect(transcriptRule).toContain("scrollbar-gutter: stable;");
    expect(pinnedThumbRule).toContain("background: transparent;");
    expect(css).not.toContain(".transcript-view--pinned::-webkit-scrollbar {");
    expect(css).not.toMatch(/\.transcript-view--pinned\s*{[^}]*scrollbar-width:/s);
    expect(css).not.toContain(".show-earlier-btn");
  });

  it("renders the working timer like compact transcript summaries", () => {
    const css = readFileSync(new URL("./TranscriptView.css", import.meta.url), "utf8");

    const workingRowRule = css.match(/\.working-row\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const workingLabelRule =
      css.match(/\.working-row__label\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const compactSummaryRule =
      css.match(/\.compact-transcript-group__summary\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";

    expect(workingRowRule).toContain("font-family: var(--font-display);");
    expect(workingRowRule).toContain("font-size: 0.929em;");
    expect(workingRowRule).toContain("line-height: var(--leading-label);");
    expect(workingRowRule).not.toContain("font-family: var(--font-code);");
    expect(workingLabelRule).toContain("font-style: normal;");
    expect(compactSummaryRule).toContain("font-size: 0.929em;");
  });
});
