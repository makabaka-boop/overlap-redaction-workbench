import { describe, expect, it } from "vitest";
import {
  MAX_PATTERN_TOTAL_UNITS,
  MAX_PATTERNS,
  MAX_PATTERN_UNITS,
  MAX_TEXT_UNITS,
  checkPattern,
  parseDocument,
} from "../src/lib/validate";

const validDoc = (text: string, patterns: string[]) =>
  JSON.stringify({ text, patterns });

describe("parseDocument", () => {
  it("接受合法文档", () => {
    const r = parseDocument(validDoc("abc\nabc", ["abc"]));
    expect(r).toEqual({ text: "abc\nabc", patterns: ["abc"] });
  });

  it("拒绝 JSON 语法错误", () => {
    expect(parseDocument("{not json")).toBe("INVALID_INPUT");
  });

  it("拒绝非对象根、数组、null", () => {
    expect(parseDocument("null")).toBe("INVALID_INPUT");
    expect(parseDocument("[]")).toBe("INVALID_INPUT");
    expect(parseDocument('"str"')).toBe("INVALID_INPUT");
    expect(parseDocument("42")).toBe("INVALID_INPUT");
  });

  it("拒绝缺失/多余键", () => {
    expect(parseDocument(JSON.stringify({ text: "a" }))).toBe("INVALID_INPUT");
    expect(parseDocument(JSON.stringify({ patterns: [] }))).toBe("INVALID_INPUT");
    expect(
      parseDocument(JSON.stringify({ text: "a", patterns: ["a"], extra: 1 })),
    ).toBe("INVALID_INPUT");
  });

  it("拒绝类型错误", () => {
    expect(parseDocument(JSON.stringify({ text: 1, patterns: ["a"] }))).toBe("INVALID_INPUT");
    expect(parseDocument(JSON.stringify({ text: "a", patterns: "a" }))).toBe("INVALID_INPUT");
    expect(parseDocument(JSON.stringify({ text: "a", patterns: [1] }))).toBe("INVALID_INPUT");
  });

  it("拒绝空 patterns 与超过 50,000 条", () => {
    expect(parseDocument(validDoc("a", []))).toBe("INVALID_INPUT");
    const many = new Set<string>();
    let i = 0;
    while (many.size < MAX_PATTERNS + 1) many.add("p" + i++);
    expect(parseDocument(validDoc("a", [...many]))).toBe("INVALID_INPUT");
  });

  it("拒绝重复模式", () => {
    expect(parseDocument(validDoc("aaa", ["aa", "aa"]))).toBe("INVALID_INPUT");
  });

  it("拒绝空串、超长模式、非法字符", () => {
    expect(parseDocument(validDoc("a", [""]))).toBe("INVALID_INPUT");
    expect(parseDocument(validDoc("a", ["a".repeat(MAX_PATTERN_UNITS + 1)]))).toBe(
      "INVALID_INPUT",
    );
    expect(parseDocument(validDoc("a", ["\t"]))).toBe("INVALID_INPUT");
    expect(parseDocument(validDoc("a", ["é"]))).toBe("INVALID_INPUT"); // 多字节 UTF-16
    expect(parseDocument(validDoc("a", ["a\nb"]))).toBe("INVALID_INPUT");
  });

  it("拒绝模式总长超过 300,000", () => {
    // 2000 条长度 200 的唯一模式，总长 400,000（条数仍在上界内）。
    // 前 8 位放唯一序号，其余补 'q'。
    const patterns = Array.from({ length: 2000 }, (_, i) =>
      i.toString().padStart(8, "0") + "q".repeat(192),
    );
    expect(patterns[0].length).toBe(200);
    expect(new Set(patterns).size).toBe(patterns.length);
    expect(patterns.reduce((s, p) => s + p.length, 0)).toBeGreaterThan(
      MAX_PATTERN_TOTAL_UNITS,
    );
    expect(parseDocument(validDoc("a", patterns))).toBe("INVALID_INPUT");
  });

  it("拒绝 text 越界字符与超长 text", () => {
    expect(parseDocument(validDoc("a\tb", ["a"]))).toBe("INVALID_INPUT");
    expect(parseDocument(validDoc("aéb", ["a"]))).toBe("INVALID_INPUT");
    expect(parseDocument(validDoc("a".repeat(MAX_TEXT_UNITS + 1), ["a"]))).toBe(
      "INVALID_INPUT",
    );
  });

  it("接受 text 恰好 2,000,000、模式在上界内", () => {
    const text = "a".repeat(MAX_TEXT_UNITS);
    // 1500 条长度 200 = 300,000，恰好达到总长上界。
    const patterns = Array.from({ length: 1500 }, (_, i) =>
      (i.toString(36) + "k").padEnd(200, "_"),
    );
    const total = patterns.reduce((s, p) => s + p.length, 0);
    expect(total).toBe(MAX_PATTERN_TOTAL_UNITS);
    expect(new Set(patterns).size).toBe(patterns.length);
    const r = parseDocument(validDoc(text, patterns));
    expect(r).not.toBe("INVALID_INPUT");
  });
});

describe("checkPattern", () => {
  it("合法/非法判定", () => {
    expect(checkPattern("a")).toBeNull();
    expect(checkPattern("printable only ~!@#")).toBeNull();
    expect(checkPattern("")).toBe("INVALID_PATTERN");
    expect(checkPattern("a".repeat(201))).toBe("INVALID_PATTERN");
    expect(checkPattern("a b\nc")).toBe("INVALID_PATTERN");
    expect(checkPattern("汉字")).toBe("INVALID_PATTERN");
  });
});
