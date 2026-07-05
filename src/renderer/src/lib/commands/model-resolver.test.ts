import { describe, expect, it } from "vitest";
import { type ModelCandidate, findExactModelReferenceMatch } from "./model-resolver.js";

const MODELS: ModelCandidate[] = [
  { id: "claude-sonnet-4-20250514", provider: "anthropic", name: "Claude Sonnet 4" },
  { id: "claude-haiku-4-5-20251001", provider: "anthropic", name: "Claude Haiku 4.5" },
  { id: "deepseek-v3", provider: "deepseek", name: "DeepSeek V3" },
];

describe("findExactModelReferenceMatch", () => {
  it("returns undefined on empty input", () => {
    expect(findExactModelReferenceMatch("", MODELS)).toBeUndefined();
    expect(findExactModelReferenceMatch("   ", MODELS)).toBeUndefined();
  });

  it("matches canonical provider/id (case-insensitive)", () => {
    expect(findExactModelReferenceMatch("Anthropic/Claude-Sonnet-4-20250514", MODELS)).toEqual(
      MODELS[0],
    );
  });

  it("matches bare id (case-insensitive) when unique", () => {
    expect(findExactModelReferenceMatch("DEEPSEEK-V3", MODELS)).toEqual(MODELS[2]);
  });

  it("matches a providerless model by unique bare id", () => {
    const providerless: ModelCandidate[] = [{ id: "local-model", name: "Local Model" }];
    expect(findExactModelReferenceMatch("LOCAL-MODEL", providerless)).toEqual(providerless[0]);
  });

  it("rejects ambiguous bare id (multiple models share prefix)", () => {
    // "claude" matches both claude-sonnet and claude-haiku — ambiguous.
    expect(findExactModelReferenceMatch("claude", MODELS)).toBeUndefined();
  });

  it("rejects a canonical match that's ambiguous across providers", () => {
    const dup: ModelCandidate[] = [
      { id: "shared", provider: "a" },
      { id: "shared", provider: "b" },
    ];
    expect(findExactModelReferenceMatch("a/shared", dup)).toEqual(dup[0]);
    // Same id, two providers, no slash in the search term → ambiguous bare
    // id match, rejected.
    expect(findExactModelReferenceMatch("shared", dup)).toBeUndefined();
  });

  it("matches a provider/id where the search term has a slash but different case for provider", () => {
    expect(findExactModelReferenceMatch("Anthropic/claude-haiku-4-5-20251001", MODELS)).toEqual(
      MODELS[1],
    );
  });

  it("returns undefined when no model matches", () => {
    expect(findExactModelReferenceMatch("gpt-4", MODELS)).toBeUndefined();
  });
});
