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

  it("paints scroll fades beside rather than over the scrollbar lane", () => {
    const css = readFileSync(new URL("./TranscriptView.css", import.meta.url), "utf8");
    const frameCss = readFileSync(
      new URL("../common/ScrollFadeFrame.css", import.meta.url),
      "utf8",
    );
    const fadeRule =
      css.match(/\.transcript-region::before,\s*\.transcript-region::after\s*{(?<body>[^}]*)}/s)
        ?.groups?.body ?? "";

    expect(fadeRule).toContain("right: var(--scrollbar-size);");
    expect(css).not.toMatch(/\.transcript-view[^{}]*{[^}]*mask-image:/s);

    expect(frameCss).toMatch(/\.scroll-fade-frame__edge\s*{[^}]*right: var\(--scrollbar-size\);/s);
    expect(frameCss).toMatch(
      /\.scroll-fade-frame--horizontal \.scroll-fade-frame__edge--bottom\s*{[^}]*bottom: var\(--scrollbar-size\);/s,
    );
    expect(css).toMatch(/\.tool-card__output-frame\s*{[^}]*overflow: hidden;/s);
    expect(css).not.toContain(".tool-card__output-frame::before");
  });

  it("keeps tool disclosure chrome quiet and gives each payload one scroll owner", () => {
    const css = readFileSync(new URL("./TranscriptView.css", import.meta.url), "utf8");
    const diffCss = readFileSync(new URL("./DiffBlock.css", import.meta.url), "utf8");
    const focusRule =
      css.match(/\.tool-card__header:focus-visible\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const focusChevronRule =
      css.match(/\.tool-card__header:focus-visible \.tool-card__chevron\s*{(?<body>[^}]*)}/s)
        ?.groups?.body ?? "";
    const bodyRule = css.match(/\.tool-card__body\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const scrollRule = css.match(/\.tool-card__scroll\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";

    expect(css).not.toMatch(/\.tool-card:hover\s*{/);
    expect(css).not.toMatch(/\.tool-card__header:hover\s*{/);
    expect(focusRule).toContain("outline: none;");
    expect(focusRule).toContain("box-shadow: none;");
    expect(focusChevronRule).toContain("stroke-width: 2;");
    expect(bodyRule).not.toContain("border-top");
    expect(scrollRule).toContain("overflow: auto;");
    expect(css).not.toContain(".tool-card__horizontal-scroll");
    expect(diffCss).not.toContain(".diff-block__scroll");
    expect(css).toMatch(
      /\.activity-card__markdown \.markdown-table-scroll,[^{]*\.activity-card__markdown \.shiki > code,[^{]*\.activity-card__markdown \.code-block--plain > code\s*{[^}]*overflow: visible;/s,
    );
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
