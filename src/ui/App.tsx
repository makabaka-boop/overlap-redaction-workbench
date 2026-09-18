import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  activePatterns,
  initialSession,
  sessionReducer,
  type PatternRow,
} from "../lib/session";
import { parseDocument } from "../lib/validate";
import { redact, type RedactResult } from "../lib/redact";

const ROW_HEIGHT = 30;
const WINDOW_PAD = 8;

/** 直接以 textContent 渲染大文本，避免 React 对两百万字符做协调。 */
function RawText({ text, label }: { text: string; label: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.textContent = text;
  }, [text]);
  return <pre ref={ref} aria-label={label} className="raw-text" />;
}

function PatternList({
  rows,
  onUpdate,
  onToggle,
  onRemove,
}: {
  rows: PatternRow[];
  onUpdate: (id: number, value: string) => void;
  onToggle: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftValue, setDraftValue] = useState("");

  const viewportH = 360;
  const totalH = rows.length * ROW_HEIGHT;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - WINDOW_PAD);
  const visible = Math.ceil(viewportH / ROW_HEIGHT) + WINDOW_PAD * 2;
  const end = Math.min(rows.length, start + visible);

  const beginEdit = (r: PatternRow) => {
    setEditingId(r.id);
    setDraftValue(r.value);
  };
  const commit = () => {
    if (editingId !== null) onUpdate(editingId, draftValue);
    setEditingId(null);
  };

  return (
    <div
      ref={scrollRef}
      className="pattern-scroll"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{ height: viewportH }}
    >
      <div style={{ height: totalH, position: "relative" }}>
        {rows.slice(start, end).map((r, i) => {
          const idx = start + i;
          const editing = editingId === r.id;
          return (
            <div
              key={r.id}
              className={"pattern-row" + (r.enabled ? "" : " disabled")}
              style={{ top: idx * ROW_HEIGHT, height: ROW_HEIGHT }}
            >
              <input
                type="checkbox"
                checked={r.enabled}
                onChange={() => onToggle(r.id)}
                aria-label="启用/停用"
                title={r.enabled ? "停用" : "启用"}
              />
              {editing ? (
                <input
                  key={"edit-" + r.id}
                  className="row-edit"
                  value={draftValue}
                  autoFocus
                  maxLength={200}
                  onChange={(e) => setDraftValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onBlur={commit}
                />
              ) : (
                <button className="row-value" title="点击编辑" onClick={() => beginEdit(r)}>
                  {r.value}
                </button>
              )}
              <button className="row-del" title="删除" onClick={() => onRemove(r.id)}>
                删除
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function App() {
  const [state, dispatch] = useReducer(sessionReducer, initialSession);
  const [fileName, setFileName] = useState<string>("");
  const [newPattern, setNewPattern] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ready = state.phase === "ready";

  // 每次增改/启停都从原文重算预览。
  const result: RedactResult | null = useMemo(
    () => (ready ? redact(state.text, activePatterns(state.rows)) : null),
    [ready, state.text, state.rows],
  );

  const enabledTotal = useMemo(
    () => state.rows.reduce((s, r) => s + (r.enabled ? r.value.length : 0), 0),
    [state.rows],
  );

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    const raw = await file.text();
    const doc = parseDocument(raw);
    if (doc === "INVALID_INPUT") {
      dispatch({ type: "loadInvalid" });
    } else {
      dispatch({ type: "load", doc });
    }
    // 允许再次选择同名文件重新加载。
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const addPattern = () => {
    dispatch({ type: "add", value: newPattern });
    setNewPattern("");
  };

  const download = () => {
    if (!state.draft) return;
    // 下载内容就是采纳稿字符串本身，与屏幕预览逐字符一致。
    const blob = new Blob([state.draft.output], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "redacted.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app">
      <header>
        <h1>事故录音转写 · 敏感短语遮蔽</h1>
        <div className="loader">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          {fileName && <span className="filename">已选择：{fileName}</span>}
        </div>
      </header>

      {state.fileError && (
        <div className="banner banner-error" role="alert">
          INVALID_INPUT
          <button onClick={() => dispatch({ type: "dismissFileError" })}>关闭</button>
        </div>
      )}
      {state.editError && (
        <div className="banner banner-warn" role="alert">
          INVALID_PATTERN（空串、重复或越界编辑；已采纳稿未改动）
          <button onClick={() => dispatch({ type: "dismissEditError" })}>关闭</button>
        </div>
      )}

      {!ready && !state.fileError && (
        <p className="hint">请加载符合规约的 JSON 文件（根仅含 text 与 patterns）。</p>
      )}

      {ready && result && (
        <main>
          <section className="panel panel-patterns">
            <h2>
              短语（{state.rows.length} 条，启用 {state.rows.filter((r) => r.enabled).length}{" "}
              条 / 启用总长 {enabledTotal} UTF-16 代码单元）
            </h2>
            <div className="add-row">
              <input
                value={newPattern}
                maxLength={200}
                placeholder="新增敏感短语，回车添加（1–200 个可打印 ASCII 字符）"
                onChange={(e) => setNewPattern(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPattern();
                }}
              />
              <button onClick={addPattern}>添加</button>
            </div>
            <PatternList
              rows={state.rows}
              onUpdate={(id, value) => dispatch({ type: "update", id, value })}
              onToggle={(id) => dispatch({ type: "toggle", id })}
              onRemove={(id) => dispatch({ type: "remove", id })}
            />
            <div className="actions">
              <button
                onClick={() =>
                  dispatch({ type: "adopt", output: result.output, coveredUnits: result.coveredUnits })
                }
              >
                采纳为下载稿
              </button>
              <button
                onClick={() => dispatch({ type: "discard" })}
                disabled={!state.draft}
                title="放弃采纳后的调整，短语恢复到采纳稿快照"
              >
                放弃调整
              </button>
              <button onClick={download} disabled={!state.draft}>
                下载（UTF-8 .txt）
              </button>
              {state.draft && (
                <span className="draft-meta">
                  已采纳稿：{state.draft.output.length} 个代码单元，遮蔽 {state.draft.coveredUnits} 个
                </span>
              )}
            </div>
          </section>

          <section className="metrics">
            原文 {state.text.length} UTF-16 代码单元 · 遮蔽 {result.coveredUnits} 个 ·
            自动机构建 {result.buildMs.toFixed(1)} ms · 扫描与输出 {result.scanMs.toFixed(1)} ms
          </section>

          <section className="panel">
            <h2>实时预览（每次从原文重算）</h2>
            <div className="text-box">
              <RawText text={result.output} label="实时预览" />
            </div>
          </section>

          {state.draft && (
            <section className="panel">
              <h2>已采纳下载稿（屏幕内容即下载内容）</h2>
              <div className="text-box">
                <RawText text={state.draft.output} label="已采纳稿" />
              </div>
            </section>
          )}
        </main>
      )}
    </div>
  );
}
