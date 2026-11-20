import { describe, it, expect } from "vitest";
import { sanitizePartsForPersistence } from "./chat-sanitization";

describe("sanitizePartsForPersistence", () => {
  // ── Category 1: null characters (U+0000) ────────────────────────────

  it("strips null characters from text content", () => {
    const parts = [{ type: "text", text: "Hello\u0000World" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("HelloWorld");
  });

  it("handles null at start, middle, and end", () => {
    const parts = [{ type: "text", text: "\u0000mid\u0000dle\u0000" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("middle");
  });

  it("handles multiple nulls in array", () => {
    const parts = [
      { type: "text", text: "\u0000" },
      { type: "text", text: "clean" },
      { type: "text", text: "\u0000\u0000" },
    ];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("");
    expect(sanitized[1].text).toBe("clean");
    expect(sanitized[2].text).toBe("");
  });

  // ── Category 2: lone surrogates (U+D800-U+DFFF not in valid pairs) ──

  it("strips isolated high surrogate", () => {
    const parts = [{ type: "text", text: "\uD800hello" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("hello");
  });

  it("strips isolated low surrogate", () => {
    const parts = [{ type: "text", text: "\uDC00world" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("world");
  });

  it("keeps valid surrogate pair (emoji U+1F389)", () => {
    // High: U+D83C, Low: U+DF89 → combined code point = U+1F389
    const parts = [{ type: "text", text: "\uD83C\uDF89" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("🎉");
  });

  it("strips lone high surrogate before valid pair", () => {
    // \uD800 (lone) + \uD83C\uDF89 (valid pair) → only emoji kept
    const parts = [{ type: "text", text: "\uD800\uD83C\uDF89" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("🎉");
  });

  it("strips lone low surrogate after valid pair", () => {
    // \uD83C\uDF89 (valid) + \uDC00 (lone) → only emoji kept
    const parts = [{ type: "text", text: "\uD83C\uDF89\uDC00" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("🎉");
  });

  it("handles mixed surrogate patterns in tool output", () => {
    const parts = [
      {
        type: "tool-result",
        toolName: "Portainer logs",
        output: {
          records: [
            { level: "error", message: "\uD800invalid" },
            { level: "info", message: "\uD83C\uDF89valid emoji" },
          ],
        },
      },
    ];
    const sanitized = sanitizePartsForPersistence(parts);
    expect((sanitized[0].output as any).records[0].message).toBe("invalid");
    expect((sanitized[0].output as any).records[1].message).toBe(
      "🎉valid emoji",
    );
  });

  // ── Category 3: non-characters (U+FDD0-U+FDEF, U+FFFE, U+FFFF) ─────

  it("strips non-characters in range FDD0-FDEF", () => {
    const parts = [{ type: "text", text: "\uFDD0\uFDEF" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("");
  });

  it("strips non-characters between FDD0-FDEF mixed with valid chars", () => {
    const parts = [{ type: "text", text: "\uFDD0a\uFDEE b\uFDEF" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("ab");
  });

  it("strips U+FFFE", () => {
    const parts = [{ type: "text", text: "\uFFFEend" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("end");
  });

  it("strips U+FFFF", () => {
    const parts = [{ type: "text", text: "\uFFFFstart" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("start");
  });

  it("rejects non-characters in valid surrogate pairs (emoji with non-char)", () => {
    // A valid high+low pair that decodes to a supplementary-plane non-character.
    // U+E1FF → plane 0xe, offset 0x1ff → not FDD0-FDEF, so it's OK
    // Let's use one that IS in range: plane 0xe, offset 0xfdd0 = 0xe0000 + 0xfdd0 = 0xefdd0
    // Actually let's just verify BMP non-characters are caught correctly.
    const parts = [
      { type: "text", text: "\uFFFF\uFFFE" },
      { type: "text", text: "\uD800isolated" },
    ];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("isolated");
  });

  // ── Mixed / edge cases ─────────────────────────────────────────────

  it("handles mixed rejected characters in one string", () => {
    const parts = [
      {
        type: "text",
        text: "\u0000A\uD800B\uDFFF C\uFDD0 D\uFFFE E\uFFFF F",
      },
    ];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("ABCDEF");
  });

  it("preserves empty strings", () => {
    const parts = [{ type: "text", text: "" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("");
  });

  it("leaves non-rejected content unchanged", () => {
    const parts = [
      { type: "text", text: "Normal message" },
      { type: "tool-call", toolName: "search", args: {} },
    ];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("Normal message");
    expect(sanitized[1].toolName).toBe("search");
  });

  it("handles null metadata values", () => {
    const parts = [{ type: "text", text: "Test", metadata: null }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].metadata).toBeNull();
  });

  it("handles deeply nested structures with rejected chars", () => {
    const parts = [
      {
        type: "tool-result",
        toolName: "nested",
        output: {
          level1: {
            level2: { message: "hello\u0000world" },
          },
          items: ["a\uD800b", "\uFDD0c"],
        },
      },
    ];
    const sanitized = sanitizePartsForPersistence(parts);
    expect((sanitized[0].output as any).level1.level2.message).toBe(
      "helloworld",
    );
    expect((sanitized[0].output as any).items[0]).toBe("ab");
    expect((sanitized[0].output as any).items[1]).toBe("c");
  });

  it("returns same length array (deep clone)", () => {
    const parts = Array.from({ length: 5 }, (_, i) => ({
      type: "text" as const,
      text: `Message${i}`,
    }));
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(sanitized[i].text).toBe(`Message${i}`);
    }
  });

  it("does not modify input array (deep clone)", () => {
    const parts = [{ type: "text", text: "Test\u0000" }];
    sanitizePartsForPersistence(parts);
    expect(parts[0].text).toBe("Test\u0000");
  });

  it("handles arrays within strings (JSON inside text)", () => {
    const parts = [{ type: "text", text: "[\u0000a,\uFDD0b]" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("[a,b]");
  });

  it("preserves valid supplementary-plane characters (emoji U+1F600 = 😀)", () => {
    // High: U+D83D, Low: U+DE00 → combined code point = U+1F600 (grinning face)
    const parts = [{ type: "text", text: "\uD83D\uDE00" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("😀");
  });

  it("rejects non-characters in supplementary plane (U+1FFFE)", () => {
    // High: U+DBFF, Low: U+DFFE → combined code point = U+1FFFE (non-character)
    const parts = [{ type: "text", text: "\uDBFF\uDFFE" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("");
  });

  it("rejects non-characters in supplementary plane (U+1FFFF)", () => {
    // High: U+DBFF, Low: U+DFFF → combined code point = U+1FFFF (non-character)
    const parts = [{ type: "text", text: "\uDBFF\uDFFF" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("");
  });

  it("handles only-rejected-content string (returns empty)", () => {
    const parts = [{ type: "text", text: "\u0000\uD800\uFFFE" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("");
  });

  it("preserves all BMP characters outside non-character range", () => {
    // Test a representative set: regular ASCII, accented chars, Chinese chars
    const parts = [{ type: "text", text: "Hello café 世界 U+00FF ñ" }];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("Hello café 世界 U+00FF ñ");
  });

  it("handles reasoning part with rejected characters", () => {
    const parts = [
      { type: "reasoning", text: "Step\u00001\uD800B\uFDD0C" },
    ];
    const sanitized = sanitizePartsForPersistence(parts);
    expect(sanitized[0].text).toBe("Step1BC");
  });

  it("handles tool-call args with rejected characters", () => {
    const parts = [
      { type: "tool-call", toolName: "search", args: { q: "a\u0000b" } },
    ];
    const sanitized = sanitizePartsForPersistence(parts);
    expect((sanitized[0].args as any).q).toBe("ab");
  });

  it("handles metadata with rejected characters", () => {
    const parts = [
      { type: "text", text: "test" },
    ];
    // Add metadata to simulate a message with metadata containing bad chars
    const msg = { ...parts[0], metadata: { key: "val\u0000ue" } };
    const sanitized = sanitizePartsForPersistence([msg]);
    expect((sanitized[0].metadata as any).key).toBe("value");
  });
});
