import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PiOutbound } from "./jsonl-stream.js";
import { JsonlStream } from "./jsonl-stream.js";

describe("JsonlStream", () => {
  it("parses a simple JSON line", () => {
    const lines: unknown[] = [];
    const stream = new JsonlStream(
      (parsed) => lines.push(parsed),
      () => {},
    );
    stream.feed(Buffer.from('{"type":"agent_start"}\n'));
    expect(lines).toHaveLength(1);
    expect((lines[0] as { kind: string }).kind).toBe("event");
  });

  it("handles line split across two chunks", () => {
    const lines: unknown[] = [];
    const stream = new JsonlStream(
      (p) => lines.push(p),
      () => {},
    );
    stream.feed(Buffer.from('{"type":"agent_'));
    expect(lines).toHaveLength(0);
    stream.feed(Buffer.from('start"}\n'));
    expect(lines).toHaveLength(1);
  });

  it("handles \\r\\n line endings", () => {
    const lines: unknown[] = [];
    const stream = new JsonlStream(
      (p) => lines.push(p),
      () => {},
    );
    stream.feed(Buffer.from('{"type":"agent_start"}\r\n'));
    expect(lines).toHaveLength(1);
  });

  it("handles \\r\\n split across chunks", () => {
    const lines: unknown[] = [];
    const stream = new JsonlStream(
      (p) => lines.push(p),
      () => {},
    );
    stream.feed(Buffer.from('{"type":"agent_start"}\r'));
    stream.feed(Buffer.from("\n"));
    expect(lines).toHaveLength(1);
  });

  it("parses a ~1 MiB line fed in tiny chunks", () => {
    const lines: unknown[] = [];
    const stream = new JsonlStream(
      (p) => lines.push(p),
      () => {},
    );
    const json = `${JSON.stringify({ type: "agent_start", text: "x".repeat(1024 * 1024) })}\n`;
    const buf = Buffer.from(json);
    for (let i = 0; i < buf.length; i += 7) stream.feed(buf.subarray(i, i + 7));
    expect(lines).toHaveLength(1);
  });

  it("does NOT split on U+2028 inside a JSON string", () => {
    const lines: unknown[] = [];
    const stream = new JsonlStream(
      (p) => lines.push(p),
      () => {},
    );
    // U+2028 is a Unicode line separator — should NOT be treated as a line end
    const jsonWithU2028 = '{"type":"message_update","text":"line\\u2028break"}\n';
    stream.feed(Buffer.from(jsonWithU2028, "utf8"));
    expect(lines).toHaveLength(1);
  });

  it("handles multiple lines in one chunk", () => {
    const lines: unknown[] = [];
    const stream = new JsonlStream(
      (p) => lines.push(p),
      () => {},
    );
    stream.feed(Buffer.from('{"type":"agent_start"}\n{"type":"agent_end"}\n'));
    expect(lines).toHaveLength(2);
  });

  it("recognizes pi 0.80.4 agent_settled as a known event", () => {
    const lines: Array<{ kind: string; data?: { type?: string; __unknown?: boolean } }> = [];
    const stream = new JsonlStream(
      (p) => lines.push(p as (typeof lines)[number]),
      () => {},
    );
    stream.feed(Buffer.from('{"type":"agent_settled"}\n'));
    expect(lines).toEqual([{ kind: "event", data: { type: "agent_settled" } }]);
  });

  it("classifies response messages", () => {
    const lines: Array<{ kind: string }> = [];
    const stream = new JsonlStream(
      (p) => lines.push(p as { kind: string }),
      () => {},
    );
    stream.feed(Buffer.from('{"type":"response","command":"prompt","success":true}\n'));
    expect(lines[0]?.kind).toBe("response");
  });

  it("classifies extension_ui_request", () => {
    const lines: Array<{ kind: string }> = [];
    const stream = new JsonlStream(
      (p) => lines.push(p as { kind: string }),
      () => {},
    );
    stream.feed(
      Buffer.from(
        '{"type":"extension_ui_request","id":"1","method":"select","title":"Pick","options":["A","B"]}\n',
      ),
    );
    expect(lines[0]?.kind).toBe("extension_ui_request");
  });

  it("calls onError for invalid JSON and continues", () => {
    const lines: unknown[] = [];
    const errors: unknown[] = [];
    const stream = new JsonlStream(
      (p) => lines.push(p),
      (e) => errors.push(e),
    );
    stream.feed(Buffer.from('not-json\n{"type":"agent_end"}\n'));
    expect(errors).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  it("drops the buffer and reports an error when a line exceeds the cap", () => {
    const lines: unknown[] = [];
    const errors: Error[] = [];
    const stream = new JsonlStream(
      (p) => lines.push(p),
      (e) => errors.push(e),
    );
    // One chunk over the 64 MiB cap with no newline → the partial buffer
    // must be dropped rather than grown unbounded.
    const huge = Buffer.alloc(64 * 1024 * 1024 + 1, 0x41); // 'A' repeated, no '\n'
    stream.feed(huge);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/exceeded/);
    expect(lines).toHaveLength(0);

    // After the reset, a normal line still parses (no leftover garbage prefix).
    stream.feed(Buffer.from('{"type":"agent_start"}\n'));
    expect(lines).toHaveLength(1);
    expect((lines[0] as { kind: string }).kind).toBe("event");
  });

  it("handles chunk split mid-codepoint (UTF-8 multi-byte)", () => {
    const lines: unknown[] = [];
    const stream = new JsonlStream(
      (p) => lines.push(p),
      () => {},
    );
    // "café" → 'caf\xc3\xa9'
    const json = `${JSON.stringify({ type: "agent_start", name: "café" })}\n`;
    const buf = Buffer.from(json, "utf8");
    // Split at a multi-byte boundary
    stream.feed(buf.slice(0, buf.length - 3));
    stream.feed(buf.slice(buf.length - 3));
    expect(lines).toHaveLength(1);
  });
});

// Parse every line of every capture fixture and assert none produce kind === "unknown".
// This guards against field-name drift between docs-written schemas and real wire output.
describe("fixture captures — no unknown lines", () => {
  const capturesDir = join(__dirname, "../../../tests/fixtures/captures");

  if (!existsSync(capturesDir)) {
    it.skip("captures dir not found, skipping fixture tests", () => {});
  } else {
    const files = readdirSync(capturesDir).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      it(`${file} — all lines parse as known kind`, () => {
        const content = readFileSync(join(capturesDir, file), "utf8");
        const lines = content.split("\n").filter((l) => l.trim());

        const results: PiOutbound[] = [];
        const errors: Error[] = [];
        const stream = new JsonlStream(
          (p) => results.push(p),
          (e) => errors.push(e),
        );
        stream.feed(Buffer.from(content, "utf8"));

        expect(errors, `parse errors in ${file}`).toHaveLength(0);
        expect(results.length, `${file} produced no results`).toBeGreaterThan(0);
        expect(results.length).toBe(lines.length);

        const unknown = results.filter((r) => r.kind === "unknown");
        expect(
          unknown,
          `${file} has ${unknown.length} unknown line(s): ${JSON.stringify(unknown.map((u) => (u as { raw: unknown }).raw))}`,
        ).toHaveLength(0);
      });
    }
  }
});
