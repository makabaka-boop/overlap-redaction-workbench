import { describe, expect, it } from "vitest";
import { redact } from "../src/lib/redact";

/**
 * 朴素预言机：对每条模式用 indexOf 枚举全部出现位置（含重叠），
 * 在布尔数组上取覆盖并集。模式只含可打印 ASCII，indexOf 天然不跨换行。
 * 复杂度 O(模式数 × 文本长度 × 模式长度)，仅用于小规模随机对照。
 */
function oracle(text: string, patterns: ReadonlyArray<string>): string {
  const covered = new Uint8Array(text.length);
  for (const p of patterns) {
    if (p.length === 0) continue;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(p, from);
      if (idx === -1) break;
      for (let i = idx; i < idx + p.length; i++) covered[i] = 1;
      from = idx + 1; // 允许重叠
    }
  }
  let out = "";
  for (let i = 0; i < text.length; i++) {
    // 预言机不允许覆盖换行（模式不含换行，indexOf 也不可能命中含换行的串）。
    out += covered[i] && text.charCodeAt(i) !== 0x0a ? "#" : text[i];
  }
  return out;
}

/** 确定性 LCG 伪随机，保证测试可复现（不固定遮蔽结果，只固定生成器种子）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(rng: () => number, alphabet: string, maxLen: number): string {
  const len = 1 + Math.floor(rng() * maxLen);
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
  return s;
}

describe("redact — 朴素预言机对照（随机）", () => {
  it("200 组小规模随机文本/模式与预言机逐字符一致", () => {
    const rng = mulberry32(20260918);
    const alphabet = "ab\n "; // 含换行与空格，覆盖不跨换行逻辑
    for (let trial = 0; trial < 200; trial++) {
      const text = randomString(rng, alphabet, 60);
      const n = 1 + Math.floor(rng() * 12);
      const patternSet = new Set<string>();
      while (patternSet.size < n) {
        const p = randomString(rng, "ab", 6); // 模式不含换行
        patternSet.add(p);
      }
      const patterns = [...patternSet];
      const expected = oracle(text, patterns);
      const { output } = redact(text, patterns);
      expect(output.length).toBe(text.length);
      expect(output).toBe(expected);
    }
  });
});

describe("redact — 边界与语义", () => {
  it("区分大小写", () => {
    expect(redact("Foo FOO foo", ["foo"]).output).toBe("Foo FOO ###");
  });

  it("重叠命中取覆盖并集", () => {
    // "ab" 与 "bc" 在 "abc" 上覆盖 [0,2) 与 [1,3)
    expect(redact("abc", ["ab", "bc"]).output).toBe("###");
  });

  it("匹配不跨换行，换行永不替换", () => {
    expect(redact("ab\nab", ["ab"]).output).toBe("##\n##");
    expect(redact("a\na", ["a"]).output).toBe("#\n#");
    // 模式不可能跨换行：拆成两段后各自命中，中间换行保留
    const r = redact("xy\nxy", ["xy"]);
    expect(r.output).toBe("##\n##");
    expect(r.coveredUnits).toBe(4);
  });

  it("嵌套模式以最长覆盖为准", () => {
    expect(redact("abcdef", ["abc", "abcdef", "bcd"]).output).toBe("######");
  });

  it("未命中的字符原位保留（含空格与全部可打印 ASCII）", () => {
    const text = "hello, world! 0123456789 ~`!@#$%^&*()_+-={}[]|\\:;\"'<>,.?/";
    expect(redact(text, ["zzz"]).output).toBe(text);
  });

  it("空文本与空模式列表原样返回", () => {
    expect(redact("", ["a"]).output).toBe("");
    expect(redact("abc", []).output).toBe("abc");
  });

  it("同字符重叠：单字符模式与长模式", () => {
    expect(redact("aaaa", ["a", "aa", "aaa", "aaaa"]).output).toBe("####");
  });

  it("相邻但不重叠的命中都被替换", () => {
    expect(redact("abab", ["ab"]).output).toBe("####");
  });

  it("UTF-16 代理项按代码单元语义由校验层排除；此处保证长度语义不被破坏", () => {
    // 核心算法以 charCodeAt 处理；代理项不会出现在合法输入中。
    const text = "ab";
    const r = redact(text, ["a"]);
    expect(r.output.length).toBe(2);
    expect(r.output).toBe("#b");
  });

  it("输出长度恒等于输入长度", () => {
    const rng = mulberry32(42);
    const text = randomString(rng, "abc\n ", 500);
    const patterns = new Set<string>();
    for (let i = 0; i < 20; i++) patterns.add(randomString(rng, "abc", 5));
    const r = redact(text, [...patterns]);
    expect(r.output.length).toBe(text.length);
  });

  it("coveredUnits 等于 # 的数量", () => {
    const r = redact("aa\naa\naa", ["aa"]);
    expect(r.coveredUnits).toBe(6);
    expect((r.output.match(/#/g) ?? []).length).toBe(6);
  });
});

describe("redact — 高重叠长文本（性能与正确性）", () => {
  it("A. 深度嵌套：200 条 a^k 命中 2,000,000 个 a，3 秒内全部遮蔽", () => {
    const n = 2_000_000;
    const text = "a".repeat(n);
    const patterns: string[] = [];
    for (let k = 1; k <= 200; k++) patterns.push("a".repeat(k));
    const start = Date.now();
    const r = redact(text, patterns);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(3000);
    expect(r.buildMs + r.scanMs).toBeLessThan(3000);
    expect(r.output.length).toBe(n);
    // 采样断言，避免构造百万级字符串断言
    expect(r.output[0]).toBe("#");
    expect(r.output[n - 1]).toBe("#");
    expect(r.output[Math.floor(n / 2)]).toBe("#");
    expect(r.coveredUnits).toBe(n);
    expect(r.output.includes("a")).toBe(false);
  });

  it("B. 50,000 条互不重复模式 + 2,000,000 文本：不按命中数展开且 3 秒内完成", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    const patterns = new Set<string>();
    // 长度 1..5 可提供 26 + 676 + 17576 + 456976 ... 足够 5 万个唯一项；
    // 总长必须 <= 300,000：取 40,000 条长度 4（160k）+ 10,000 条长度 5（50k）≈ 210k。
    const rng = mulberry32(7);
    const randWord = (len: number) => {
      let s = "";
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
      return s;
    };
    let guard = 0;
    while (patterns.size < 40_000 && guard < 2_000_000) {
      patterns.add(randWord(4));
      guard++;
    }
    guard = 0;
    while (patterns.size < 50_000 && guard < 2_000_000) {
      patterns.add(randWord(5));
      guard++;
    }
    expect(patterns.size).toBe(50_000);

    // 文本：大量 "aaaa" 保证海量重叠命中，夹杂随机词。
    const rng2 = mulberry32(99);
    let text = "";
    while (text.length < 2_000_000) {
      text += rng2() < 0.5 ? "aaaa" : randWord(4);
    }
    text = text.slice(0, 2_000_000);

    const start = Date.now();
    const r = redact(text, [...patterns]);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(3000);
    expect(r.buildMs + r.scanMs).toBeLessThan(3000);
    expect(r.output.length).toBe(2_000_000);
    expect((r.output.match(/#/g) ?? []).length).toBe(r.coveredUnits);
  });

  it("C. 缩尺高重叠场景与朴素预言机全量逐字符一致", () => {
    const alphabet = "abc";
    const patterns = new Set<string>();
    const rng = mulberry32(123);
    const randWord = (maxLen: number) => {
      const len = 1 + Math.floor(rng() * maxLen);
      let s = "";
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
      return s;
    };
    while (patterns.size < 300) patterns.add(randWord(6));
    let text = "";
    const rng2 = mulberry32(456);
    while (text.length < 20_000) text += randWord(8) + (rng2() < 0.2 ? "\n" : "");
    text = text.slice(0, 20_000);
    const pats = [...patterns];
    expect(redact(text, pats).output).toBe(oracle(text, pats));
  });

  it("D. 2,000 条模式 / 100,000 文本与朴素预言机全量逐字符一致", () => {
    const alphabet = "abcde";
    const patterns = new Set<string>();
    const rng = mulberry32(2026);
    const randWord = (maxLen: number) => {
      const len = 1 + Math.floor(rng() * maxLen);
      let s = "";
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
      return s;
    };
    let guard = 0;
    while (patterns.size < 2000 && guard < 1_000_000) {
      patterns.add(randWord(8));
      guard++;
    }
    expect(patterns.size).toBe(2000);
    let text = "";
    const rng2 = mulberry32(777);
    while (text.length < 100_000) {
      text += randWord(10);
      if (rng2() < 0.2) text += "\n";
    }
    text = text.slice(0, 100_000);
    const pats = [...patterns];
    const expected = oracle(text, pats);
    const r = redact(text, pats);
    expect(r.output).toBe(expected);
    expect(r.coveredUnits).toBe((expected.match(/#/g) ?? []).length);
  });
});
