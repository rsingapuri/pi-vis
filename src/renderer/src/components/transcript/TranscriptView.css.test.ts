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
    const headerRule = css.match(/\.tool-card__header\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const identityRule =
      css.match(/(?:^|\n)\.tool-card__identity\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const chevronRule =
      css.match(/(?:^|\n)\.tool-card__chevron\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const trailingRule =
      css.match(/(?:^|\n)\.tool-card__header-trailing\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const focusRule =
      css.match(/\.tool-card__header:focus-visible\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const focusChevronRule =
      css.match(/\.tool-card__header:focus-visible \.tool-card__chevron\s*{(?<body>[^}]*)}/s)
        ?.groups?.body ?? "";
    const bodyRule = css.match(/\.tool-card__body\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const scrollRule = css.match(/\.tool-card__scroll\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";

    expect(css).not.toMatch(/\.tool-card:hover\s*{/);
    expect(css).not.toMatch(/\.tool-card__header:hover\s*{/);
    expect(headerRule).toContain("display: grid;");
    expect(headerRule).toContain("grid-template-columns: 0.857rem minmax(0, 1fr) max-content;");
    expect(headerRule).toContain("align-items: center;");
    expect(headerRule).toContain("padding: 0.571rem 0.857rem;");
    expect(identityRule).toContain("align-items: baseline;");
    expect(identityRule).toContain("gap: 0.571rem;");
    expect(trailingRule).toContain("align-items: center;");
    expect(trailingRule).toContain("justify-content: flex-end;");
    expect(chevronRule).not.toContain("position:");
    expect(chevronRule).not.toContain("top:");
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

  it("keeps reading-family tokens scoped away from interface and Composer chrome", () => {
    const css = readFileSync(new URL("./TranscriptView.css", import.meta.url), "utf8");
    const headerCss = readFileSync(
      new URL("../session-header/SessionHeader.css", import.meta.url),
      "utf8",
    );
    const composerCss = readFileSync(new URL("../composer/Composer.css", import.meta.url), "utf8");
    const changelogCss = readFileSync(
      new URL("../changelog/ChangelogModal.css", import.meta.url),
      "utf8",
    );
    const bubbleRule =
      css.match(/(?:^|\n)\.transcript-block__bubble\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const contentRule =
      css.match(/(?:^|\n)\.transcript-block__content\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const contentParagraphRule =
      css.match(/\.transcript-block__content p\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const titleButtonRule =
      headerCss.match(/\.session-header__name-btn\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const titleInputRule =
      headerCss.match(/\.session-header__name-input\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";

    expect(bubbleRule).toContain("font-family: var(--font-transcript-body);");
    expect(contentRule).toContain("font-family: var(--font-transcript-body);");
    expect(contentParagraphRule).toContain("font-family: inherit;");
    expect(css).toMatch(/\.thinking-block\s*{[^}]*font-family: var\(--font-thinking\);/s);
    expect(css).toMatch(
      /\.transcript-block__content h1,[^{]*\.transcript-block__content h6\s*{[^}]*font-family: var\(--font-transcript-heading\);/s,
    );
    expect(titleButtonRule).toContain("font-family: var(--font-title);");
    expect(titleInputRule).toContain("font-family: var(--font-title);");
    expect(composerCss).not.toContain("--font-title");
    expect(composerCss).not.toContain("--font-thinking");
    expect(composerCss).not.toContain("--font-transcript-heading");
    expect(composerCss).not.toContain("--font-transcript-body");
    expect(changelogCss).toContain("font-family: var(--font-reading-heading);");
    expect(changelogCss).not.toContain("--font-transcript-heading");
    expect(changelogCss).not.toContain("--font-thinking");
    expect(changelogCss).not.toContain("--font-transcript-body");
  });

  it("bundles regular and italic faces for every advertised reading family", () => {
    const settingsView = readFileSync(
      new URL("../settings/SettingsView.tsx", import.meta.url),
      "utf8",
    );
    const entrypoint = readFileSync(new URL("../../main.tsx", import.meta.url), "utf8");
    const optionList =
      settingsView.match(/const BUNDLED_READING_FONTS = \[(?<families>[^\]]*)\]/s)?.groups
        ?.families ?? "";
    const advertised = [...optionList.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    const packages: Record<string, string> = {
      Inter: "inter",
      Fraunces: "fraunces",
      "IBM Plex Serif": "ibm-plex-serif",
      "IBM Plex Mono": "ibm-plex-mono",
    };

    expect(advertised).toEqual(Object.keys(packages));
    for (const family of advertised) {
      const packageName = packages[family!];
      for (const weight of [400, 600, 700]) {
        expect(entrypoint).toContain(`@fontsource/${packageName}/${weight}.css`);
        expect(entrypoint).toContain(`@fontsource/${packageName}/${weight}-italic.css`);
      }
    }
  });
});
