/**
 * 输入校验。
 *
 * 文档 JSON 根仅允许 text 与 patterns 两个键：
 *  - text：字符串，UTF-16 代码单元数 <= 2,000,000，
 *    每个代码单元为 U+000A 或 U+0020..U+007E；
 *  - patterns：1..50,000 个互不重复字符串，每项长度 1..200 个
 *    UTF-16 代码单元，字符仅限 U+0020..U+007E，总长 <= 300,000。
 */

import { isAllowedPatternCode, isAllowedTextCode } from "./redact";

export const MAX_TEXT_UNITS = 2_000_000;
export const MAX_PATTERNS = 50_000;
export const MAX_PATTERN_UNITS = 200;
export const MAX_PATTERN_TOTAL_UNITS = 300_000;

export interface LoadedDocument {
  text: string;
  patterns: string[];
}

/** 校验单条模式文本（增改短语时使用）。合法返回 null，否则返回错误码。 */
export function checkPattern(value: string): "INVALID_PATTERN" | null {
  if (value.length < 1 || value.length > MAX_PATTERN_UNITS) return "INVALID_PATTERN";
  for (let i = 0; i < value.length; i++) {
    if (!isAllowedPatternCode(value.charCodeAt(i))) return "INVALID_PATTERN";
  }
  return null;
}

/** 解析并校验上传的文档文件内容。 */
export function parseDocument(raw: string): LoadedDocument | "INVALID_INPUT" {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return "INVALID_INPUT";
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return "INVALID_INPUT";
  }
  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 2 || !("text" in obj) || !("patterns" in obj)) {
    return "INVALID_INPUT";
  }
  const { text, patterns } = obj;
  if (typeof text !== "string" || typeof patterns !== "object" || patterns === null || !Array.isArray(patterns)) {
    return "INVALID_INPUT";
  }
  if (text.length > MAX_TEXT_UNITS) return "INVALID_INPUT";
  for (let i = 0; i < text.length; i++) {
    if (!isAllowedTextCode(text.charCodeAt(i))) return "INVALID_INPUT";
  }
  if (patterns.length < 1 || patterns.length > MAX_PATTERNS) return "INVALID_INPUT";

  let total = 0;
  const seen = new Set<string>();
  for (const p of patterns) {
    if (typeof p !== "string") return "INVALID_INPUT";
    if (p.length < 1 || p.length > MAX_PATTERN_UNITS) return "INVALID_INPUT";
    total += p.length;
    if (total > MAX_PATTERN_TOTAL_UNITS) return "INVALID_INPUT";
    if (seen.has(p)) return "INVALID_INPUT";
    for (let i = 0; i < p.length; i++) {
      if (!isAllowedPatternCode(p.charCodeAt(i))) return "INVALID_INPUT";
    }
    seen.add(p);
  }
  return { text, patterns: patterns as string[] };
}
