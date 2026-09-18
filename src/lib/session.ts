/**
 * 会话状态模型（纯函数 reducer，框架无关，便于单测）。
 *
 * 两层状态：
 *  - 工作层（rows / text）：当前正在调整的短语集与实时预览来源；
 *  - 采纳稿（draft）：用户“采纳”后定格的下载稿，及其短语快照。
 *
 * 非法文件：显示 INVALID_INPUT 并清除整个会话（回到未加载态）。
 * 非法编辑（空串、与启用项重复、越过数量/总长上界、字符越界）：
 * 显示 INVALID_PATTERN，不修改工作层，也不触碰已采纳稿。
 */

import {
  MAX_PATTERNS,
  MAX_PATTERN_TOTAL_UNITS,
  type LoadedDocument,
  checkPattern,
} from "./validate";

export interface PatternRow {
  id: number;
  value: string;
  enabled: boolean;
}

export interface Draft {
  /** 采纳时定格的遮蔽结果，逐字符即为下载内容。 */
  output: string;
  coveredUnits: number;
  /** 采纳时的工作层短语快照（用于“放弃”恢复）。 */
  rows: PatternRow[];
}

export interface SessionState {
  phase: "empty" | "ready";
  text: string;
  rows: PatternRow[];
  draft: Draft | null;
  /** 顶部横幅错误码，null 表示无横幅。 */
  fileError: "INVALID_INPUT" | null;
  /** 编辑区行内错误码，null 表示无。 */
  editError: "INVALID_PATTERN" | null;
  nextId: number;
}

export const initialSession: SessionState = {
  phase: "empty",
  text: "",
  rows: [],
  draft: null,
  fileError: null,
  editError: null,
  nextId: 1,
};

export type SessionAction =
  | { type: "load"; doc: LoadedDocument }
  | { type: "loadInvalid" }
  | { type: "dismissFileError" }
  | { type: "dismissEditError" }
  | { type: "add"; value: string }
  | { type: "update"; id: number; value: string }
  | { type: "toggle"; id: number }
  | { type: "remove"; id: number }
  | { type: "adopt"; output: string; coveredUnits: number }
  | { type: "discard" };

function cloneRows(rows: ReadonlyArray<PatternRow>): PatternRow[] {
  return rows.map((r) => ({ ...r }));
}

/**
 * 校验增改后的工作层集合。
 * editingId 为 null 表示新增；否则表示替换该行。
 * 唯一性是短语表不变量：对全部行（含停用）判重；数量与总长只计启用项。
 */
function validateWorkingSet(
  rows: ReadonlyArray<PatternRow>,
  editingId: number | null,
  value: string,
): boolean {
  if (checkPattern(value) !== null) return false;
  let count = 0;
  let total = 0;
  for (const r of rows) {
    if (editingId !== null && r.id === editingId) continue;
    if (r.value === value) return false; // 与任何行重复（含停用行）
    if (r.enabled) {
      count++;
      total += r.value.length;
    }
  }
  if (editingId === null || !rows.find((r) => r.id === editingId)?.enabled) {
    count++; // 新增行或把停用行改成新值时，该值都处于启用态
    total += value.length;
  }
  return count <= MAX_PATTERNS && total <= MAX_PATTERN_TOTAL_UNITS;
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "load": {
      const rows: PatternRow[] = action.doc.patterns.map((value, i) => ({
        id: i + 1,
        value,
        enabled: true,
      }));
      return {
        phase: "ready",
        text: action.doc.text,
        rows,
        draft: null,
        fileError: null,
        editError: null,
        nextId: rows.length + 1,
      };
    }
    case "loadInvalid":
      // 清除会话，仅保留错误横幅。
      return { ...initialSession, fileError: "INVALID_INPUT" };
    case "dismissFileError":
      return state.fileError ? { ...state, fileError: null } : state;
    case "dismissEditError":
      return state.editError ? { ...state, editError: null } : state;
    case "add": {
      if (state.phase !== "ready") return state;
      if (!validateWorkingSet(state.rows, null, action.value)) {
        return state.editError === "INVALID_PATTERN"
          ? state
          : { ...state, editError: "INVALID_PATTERN" };
      }
      const row: PatternRow = { id: state.nextId, value: action.value, enabled: true };
      return {
        ...state,
        rows: [...state.rows, row],
        nextId: state.nextId + 1,
        editError: null,
      };
    }
    case "update": {
      if (state.phase !== "ready") return state;
      if (!validateWorkingSet(state.rows, action.id, action.value)) {
        return state.editError === "INVALID_PATTERN"
          ? state
          : { ...state, editError: "INVALID_PATTERN" };
      }
      return {
        ...state,
        rows: state.rows.map((r) => (r.id === action.id ? { ...r, value: action.value } : r)),
        editError: null,
      };
    }
    case "toggle": {
      if (state.phase !== "ready") return state;
      const target = state.rows.find((r) => r.id === action.id);
      if (!target) return state;
      if (!target.enabled) {
        // 停用 -> 启用：检查启用项数量与总长上界。
        let count = 0;
        let total = 0;
        for (const r of state.rows) {
          if (r.enabled) {
            count++;
            total += r.value.length;
          }
        }
        if (count + 1 > MAX_PATTERNS || total + target.value.length > MAX_PATTERN_TOTAL_UNITS) {
          return state.editError === "INVALID_PATTERN"
            ? state
            : { ...state, editError: "INVALID_PATTERN" };
        }
      }
      return {
        ...state,
        rows: state.rows.map((r) => (r.id === action.id ? { ...r, enabled: !r.enabled } : r)),
        editError: null,
      };
    }
    case "remove":
      if (state.phase !== "ready") return state;
      return { ...state, rows: state.rows.filter((r) => r.id !== action.id), editError: null };
    case "adopt":
      if (state.phase !== "ready") return state;
      return {
        ...state,
        draft: { output: action.output, coveredUnits: action.coveredUnits, rows: cloneRows(state.rows) },
      };
    case "discard":
      if (state.phase !== "ready" || !state.draft) return state;
      // 放弃当前调整：工作层恢复到采纳稿快照；采纳稿本身保留，可继续调整后再次采纳。
      return { ...state, rows: cloneRows(state.draft.rows), editError: null };
    default:
      return state;
  }
}

/** 当前启用的模式（保持列表顺序，互不重复由 reducer 保证）。 */
export function activePatterns(rows: ReadonlyArray<PatternRow>): string[] {
  const out: string[] = [];
  for (const r of rows) if (r.enabled) out.push(r.value);
  return out;
}
