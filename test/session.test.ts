import { describe, expect, it } from "vitest";
import {
  activePatterns,
  initialSession,
  sessionReducer,
  type PatternRow,
} from "../src/lib/session";
import type { LoadedDocument } from "../src/lib/validate";

const doc: LoadedDocument = { text: "abc abc", patterns: ["abc", "bc"] };

function loaded() {
  return sessionReducer(initialSession, { type: "load", doc });
}

describe("session reducer", () => {
  it("load 建立全部启用的工作行并清空采纳稿", () => {
    const s = loaded();
    expect(s.phase).toBe("ready");
    expect(s.rows).toHaveLength(2);
    expect(s.rows.every((r) => r.enabled)).toBe(true);
    expect(s.draft).toBeNull();
  });

  it("非法文件显示 INVALID_INPUT 并清除整个会话", () => {
    const withDraft = sessionReducer(loaded(), {
      type: "adopt",
      output: "### ###",
      coveredUnits: 6,
    });
    expect(withDraft.draft).not.toBeNull();
    const s = sessionReducer(withDraft, { type: "loadInvalid" });
    expect(s.phase).toBe("empty");
    expect(s.rows).toEqual([]);
    expect(s.text).toBe("");
    expect(s.draft).toBeNull();
    expect(s.fileError).toBe("INVALID_INPUT");
  });

  it("空串、重复、非法字符、超长的新增显示 INVALID_PATTERN 且状态不变", () => {
    let s = loaded();
    // 空串、重复（abc / bc）、制表符、超长、换行均为 INVALID_PATTERN
    for (const bad of ["", "abc", "a\tb", "a".repeat(201), "a\nb", "bc"]) {
      const next = sessionReducer(s, { type: "add", value: bad });
      expect(next.editError).toBe("INVALID_PATTERN");
      expect(next.rows).toEqual(s.rows);
      expect(next.draft).toBe(s.draft);
      s = next; // 已设置错误后，重复非法操作应保持同一引用
      const again = sessionReducer(s, { type: "add", value: bad });
      expect(again).toBe(s);
    }
  });

  it("非法编辑不覆盖已采纳稿", () => {
    let s = sessionReducer(loaded(), { type: "adopt", output: "### ###", coveredUnits: 6 });
    const draftBefore = s.draft;
    s = sessionReducer(s, { type: "add", value: "" });
    expect(s.draft).toBe(draftBefore);
    s = sessionReducer(s, { type: "add", value: "abc" });
    expect(s.draft).toBe(draftBefore);
  });

  it("合法新增与启停；停用项仍占用唯一性，可删除后再添加同名", () => {
    let s = loaded();
    s = sessionReducer(s, { type: "add", value: "xyz" });
    expect(s.rows).toHaveLength(3);
    expect(s.editError).toBeNull();
    s = sessionReducer(s, { type: "toggle", id: 1 });
    expect(s.rows[0].enabled).toBe(false);
    expect(activePatterns(s.rows)).toEqual(["bc", "xyz"]);
    // 唯一性对停用行同样成立：停用 "abc" 后仍不能新增 "abc"
    const rejected = sessionReducer(s, { type: "add", value: "abc" });
    expect(rejected.editError).toBe("INVALID_PATTERN");
    expect(rejected.rows).toHaveLength(3);
    // 删除停用的 "abc" 后可以重新添加
    s = sessionReducer(s, { type: "remove", id: 1 });
    s = sessionReducer(s, { type: "add", value: "abc" });
    expect(s.editError).toBeNull();
    expect(s.rows).toHaveLength(3);
  });

  it("编辑为空串/与他项重复/非法字符时报 INVALID_PATTERN 且保留原值", () => {
    const s = loaded();
    const before = s.rows;
    let next = sessionReducer(s, { type: "update", id: 1, value: "" });
    expect(next.editError).toBe("INVALID_PATTERN");
    expect(next.rows).toBe(before);
    next = sessionReducer(s, { type: "update", id: 1, value: "bc" });
    expect(next.editError).toBe("INVALID_PATTERN");
    expect(next.rows[0].value).toBe("abc");
  });

  it("编辑为唯一合法值成功；允许改成与自身相同的值", () => {
    let s = loaded();
    s = sessionReducer(s, { type: "update", id: 1, value: "abc" });
    expect(s.editError).toBeNull();
    s = sessionReducer(s, { type: "update", id: 1, value: "abx" });
    expect(s.rows[0].value).toBe("abx");
  });

  it("删除行", () => {
    let s = loaded();
    s = sessionReducer(s, { type: "remove", id: 1 });
    expect(s.rows.map((r) => r.value)).toEqual(["bc"]);
  });

  it("采纳后继续调整；放弃把工作行恢复到采纳稿快照，采纳稿保留", () => {
    let s = loaded();
    s = sessionReducer(s, { type: "adopt", output: "### ###", coveredUnits: 6 });
    const draft = s.draft;
    s = sessionReducer(s, { type: "add", value: "new" });
    expect(s.rows).toHaveLength(3);
    s = sessionReducer(s, { type: "discard" });
    expect(s.rows.map((r) => r.value)).toEqual(["abc", "bc"]);
    expect(s.draft).toBe(draft);
  });

  it("无采纳稿时放弃无效", () => {
    const s = loaded();
    expect(sessionReducer(s, { type: "discard" })).toBe(s);
  });

  it("启用项数量与启用总长受 50,000 / 300,000 上界约束", () => {
    // 精确构造 50,000 条长度 6 的唯一模式（总长恰好 300,000，双上界同时打满）。
    const values: string[] = [];
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    const enc = (n: number) => {
      let s = "";
      for (let k = 0; k < 5; k++) {
        s = alphabet[n % alphabet.length] + s;
        n = Math.floor(n / alphabet.length);
      }
      return s;
    };
    for (let i = 0; i < 50000; i++) values.push("p" + enc(i));
    const rows: PatternRow[] = values.map((value, idx) => ({
      id: idx + 1,
      value,
      enabled: true,
    }));
    let state = { ...loaded(), rows, nextId: rows.length + 1 };
    // 再加任何启用模式都应越界（数量与总长同时超限）。
    state = sessionReducer(state, { type: "add", value: "z" });
    expect(state.editError).toBe("INVALID_PATTERN");
    // 停用一条后数量 49,999、总长 299,994；加入新唯一名（长度 6）合法。
    state = sessionReducer(state, { type: "toggle", id: 1 });
    state = sessionReducer(state, { type: "add", value: "zzzzzz" });
    expect(state.editError).toBeNull();
    expect(state.rows).toHaveLength(50001);
    // 重新启用被停用的那条会使启用数量回到 50,001，拒绝。
    state = sessionReducer(state, { type: "toggle", id: 1 });
    expect(state.editError).toBe("INVALID_PATTERN");
    expect(state.rows.find((r) => r.id === 1)?.enabled).toBe(false);
  });
});
