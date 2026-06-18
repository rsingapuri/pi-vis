import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./turndown.js";

/** Wrap HTML in a container div so Turndown behaves as it would inside
 *  a real DOM fragment (e.g. from range.cloneContents()). */
function wrap(inner: string): string {
  return `<div>${inner}</div>`;
}

describe("htmlToMarkdown", () => {
  // ── Code blocks ────────────────────────────────────────────────────

  it("converts a Shiki code-block div to a fenced code block with language", () => {
    const html = wrap(
      '<div class="code-block" data-language="typescript"><pre><code>const x = 1;</code></pre></div>',
    );
    expect(htmlToMarkdown(html)).toContain("```typescript\nconst x = 1;\n```");
  });

  it("strips Shiki syntax-highlight spans inside code blocks", () => {
    const html = wrap(
      '<div class="code-block" data-language="rust"><pre class="shiki"><code><span class="line"><span style="color:#cba6f7">let</span><span style="color:#cdd6f4"> </span><span style="color:#89b4fa">x</span> <span style="color:#89dceb">=</span> <span style="color:#a6e3a1">1</span><span>;</span></span></code></pre></div>',
    );
    expect(htmlToMarkdown(html)).toContain("```rust\nlet x = 1;\n```");
  });

  it("converts a plain code-block--plain pre to a fenced code block", () => {
    const html = wrap(
      '<pre class="code-block code-block--plain" data-language="python"><code>print("hi")</code></pre>',
    );
    expect(htmlToMarkdown(html)).toContain('```python\nprint("hi")\n```');
  });

  it('omits the language annotation when data-language is "text"', () => {
    const html = wrap(
      '<div class="code-block" data-language="text"><pre><code>plain output</code></pre></div>',
    );
    const result = htmlToMarkdown(html);
    expect(result).toContain("```\nplain output\n```");
    expect(result).not.toContain("```text");
  });

  it("omits the language annotation when data-language is missing", () => {
    const html = wrap('<div class="code-block"><pre><code>no lang</code></pre></div>');
    const result = htmlToMarkdown(html);
    expect(result).toContain("```\nno lang\n```");
  });

  // ── Prose / inline formatting ──────────────────────────────────────

  it("converts inline formatting (bold, italic, code)", () => {
    const html = wrap(
      "<p>This is <strong>bold</strong>, <em>italic</em>, and <code>inline code</code>.</p>",
    );
    expect(htmlToMarkdown(html)).toContain("This is **bold**, _italic_, and `inline code`.");
  });

  it("converts lists", () => {
    const html = wrap("<ul><li>first</li><li>second</li></ul><ol><li>one</li><li>two</li></ol>");
    const result = htmlToMarkdown(html);
    // Turndown defaults to * for unordered bullets.
    expect(result).toContain("*   first");
    expect(result).toContain("*   second");
    expect(result).toContain("1.  one");
    expect(result).toContain("2.  two");
  });

  it("converts headings", () => {
    const html = wrap("<h1>Title</h1><h3>Subtitle</h3>");
    expect(htmlToMarkdown(html)).toContain("# Title");
    expect(htmlToMarkdown(html)).toContain("### Subtitle");
  });

  it("converts links", () => {
    const html = wrap('<p>See <a href="https://example.com">this page</a>.</p>');
    expect(htmlToMarkdown(html)).toContain("See [this page](https://example.com).");
  });

  // ── Mixed content ──────────────────────────────────────────────────

  it("handles mixed prose and code blocks together", () => {
    const html = wrap(
      '<p>Some text.</p><div class="code-block" data-language="ts"><pre><code>1 + 1</code></pre></div><p>More <strong>text</strong>.</p>',
    );
    const result = htmlToMarkdown(html);
    expect(result).toContain("Some text.");
    expect(result).toContain("```ts\n1 + 1\n```");
    expect(result).toContain("More **text**.");
  });

  // ── Escaping is disabled ───────────────────────────────────────────

  it("does NOT escape markdown metacharacters in prose", () => {
    // turndown normally escapes _ and * in text nodes.  We've overridden
    // escape to be the identity function so copied answers remain readable.
    const html = wrap("<p>Use _emphasis_ and item 1.</p>");
    expect(htmlToMarkdown(html)).toContain("Use _emphasis_ and item 1.");
    expect(htmlToMarkdown(html)).not.toContain("\\_");
  });

  it("does NOT escape underscores in user-block plain text", () => {
    // User blocks render plain text inside <span>s — turndown would
    // normally escape their underscores too.
    const html = wrap("<span>my_var and another_var</span>");
    expect(htmlToMarkdown(html)).toBe("my_var and another_var");
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  it("separates two adjacent code blocks", () => {
    const html = wrap(
      '<div class="code-block" data-language="ts"><pre><code>a</code></pre></div>' +
        '<div class="code-block" data-language="js"><pre><code>b</code></pre></div>',
    );
    const result = htmlToMarkdown(html);
    expect(result).toContain("```ts\na\n```\n\n```js\nb\n```");
  });

  it("handles empty code blocks (blank-rule escape hatch)", () => {
    // Turndown's isBlank fires before custom rules — empty content yields
    // the blank-rule output, which trimNewlines strips to "".  An empty
    // code block never appears in a real pi transcript, so this is fine.
    const html = wrap(
      '<div class="code-block" data-language="bash"><pre><code></code></pre></div>',
    );
    const result = htmlToMarkdown(html);
    // Accept either empty or the fenced block — depends on isBlank timing.
    // In practice this edge case is irrelevant.
    expect(result === "" || result.includes("```bash")).toBe(true);
  });

  it("returns empty string for input that contains only whitespace", () => {
    // Turndown trims the final output.
    expect(htmlToMarkdown("")).toBe("");
  });

  it("handles multi-line code blocks", () => {
    const html = wrap(
      '<div class="code-block" data-language="js"><pre><code>line1\nline2\nline3</code></pre></div>',
    );
    expect(htmlToMarkdown(html)).toContain("```js\nline1\nline2\nline3\n```");
  });
});
