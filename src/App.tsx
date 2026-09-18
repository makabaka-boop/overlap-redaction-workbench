import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  INVALID_INPUT,
  LIMITS,
  MaskError,
  addEntry,
  maskText,
  parseInput,
  removeEntry,
  toggleEntry,
  updateEntry,
  type PatternEntry,
} from './core/masker'

interface Draft {
  masked: string
  entries: PatternEntry[]
}

interface Session {
  text: string
  initial: PatternEntry[]
}

const ROW_HEIGHT = 34
const VIEW_HEIGHT = 360
const BUFFER = 8

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [entries, setEntries] = useState<PatternEntry[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState<number>(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 当前工作集相对已采纳稿（无采纳稿时相对文件载入态）是否有未决改动
  const basis = draft?.entries ?? session?.initial ?? []
  const dirty = useMemo(() => {
    if (session === null) return false
    if (entries.length !== basis.length) return true
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].value !== basis[i].value || entries[i].enabled !== basis[i].enabled) return true
    }
    return false
  }, [entries, basis, session])

  // 每次短语增改、启停、删除都从原文完整重算（不做增量、不复用旧遮蔽）
  const preview = useMemo(() => {
    if (!session) return null
    const enabled = entries.filter((e) => e.enabled).map((e) => e.value)
    const t0 = performance.now()
    const result = maskText(session.text, enabled)
    return { result, ms: performance.now() - t0 }
  }, [session, entries])

  useEffect(() => {
    if (preview) setElapsed(preview.ms)
  }, [preview])

  const handleFile = useCallback(async (file: File) => {
    let raw: string
    try {
      raw = await file.text()
    } catch {
      setNotice(INVALID_INPUT)
      return
    }
    try {
      const parsed = parseInput(raw)
      const initial = parsed.patterns.map((value) => ({ value, enabled: true }))
      setSession({ text: parsed.text, initial })
      setEntries(initial)
      setDraft(null)
      setNotice(null)
    } catch (err) {
      // 非法文件：显示 INVALID_INPUT 并清除整个会话
      setSession(null)
      setEntries([])
      setDraft(null)
      setElapsed(0)
      setNotice(err instanceof MaskError ? err.code : INVALID_INPUT)
    }
  }, [])

  /**
   * 对当前短语列表做一次合法变更。返回是否提交成功；
   * 失败时显示 INVALID_PATTERN，工作集与已采纳稿均保持原样。
   */
  const commit = useCallback(
    (updater: (prev: PatternEntry[]) => PatternEntry[]): boolean => {
      try {
        const next = updater(entries)
        setEntries(next)
        setNotice(null)
        return true
      } catch (err) {
        setNotice(err instanceof MaskError ? err.code : 'INVALID_PATTERN')
        return false
      }
    },
    [entries],
  )

  const handleAdopt = useCallback(() => {
    if (!preview) return
    setDraft({ masked: preview.result.masked, entries: entries.map((e) => ({ ...e })) })
    setNotice(null)
  }, [preview, entries])

  const handleDiscard = useCallback(() => {
    setEntries(basis.map((e) => ({ ...e })))
    setNotice(null)
  }, [basis])

  const handleDownload = useCallback(() => {
    if (!draft) return
    // Blob 直接由屏幕所显示的同一字符串构造，下载内容与屏幕逐字符一致
    const blob = new Blob([draft.masked], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'redacted.txt'
    a.click()
    URL.revokeObjectURL(url)
  }, [draft])

  return (
    <main className="page">
      <h1>事故录音转写 · 敏感短语遮蔽</h1>

      <section className="card">
        <h2>1. 载入输入文件</h2>
        <p className="hint">
          JSON 根仅含 <code>text</code> 与 <code>patterns</code>；text ≤{' '}
          {LIMITS.maxTextCodeUnits.toLocaleString()} 个 UTF-16 代码单元（仅换行 U+000A 与 U+0020..U+007E），
          patterns {LIMITS.minPatterns}..{LIMITS.maxPatterns.toLocaleString()} 条互不重复，
          每条长 {LIMITS.minPatternLength}..{LIMITS.maxPatternLength}，总长 ≤{' '}
          {LIMITS.maxTotalPatternLength.toLocaleString()}。非法文件显示 {INVALID_INPUT} 并清除会话。
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleFile(f)
            e.target.value = ''
          }}
        />
        {notice && <div className="notice" role="alert">{notice}</div>}
      </section>

      {session && preview && (
        <>
          <section className="card">
            <h2>2. 短语管理（增改 / 启停 / 删除）</h2>
            <AddRow onAdd={(v) => commit((prev) => addEntry(prev, v))} />
            <PatternList
              entries={entries}
              onUpdate={(i, v) => commit((prev) => updateEntry(prev, i, v))}
              onToggle={(i, en) => commit((prev) => toggleEntry(prev, i, en))}
              onRemove={(i) => commit((prev) => removeEntry(prev, i))}
            />
          </section>

          <section className="card">
            <h2>3. 预览（每次改动均从原文重算）</h2>
            <p className="stats">
              原文 {session.text.length.toLocaleString()} 代码单元 · 启用{' '}
              {entries.filter((e) => e.enabled).length.toLocaleString()} /{' '}
              {entries.length.toLocaleString()} 条 · 遮蔽{' '}
              {preview.result.coveredCount.toLocaleString()} 代码单元（覆盖并集，非命中次数） ·
              重算耗时 {elapsed.toFixed(1)} ms
            </p>
            <pre className="text-view" aria-label="遮蔽预览">{preview.result.masked}</pre>
            <div className="actions">
              <button type="button" onClick={handleAdopt}>采纳为下载稿</button>
              <button type="button" onClick={handleDiscard} disabled={!dirty}>
                放弃改动
              </button>
              <span className="hint">{dirty ? '存在未采纳改动' : '工作集与下载稿一致'}</span>
            </div>
          </section>

          <section className="card">
            <h2>4. 已采纳的下载稿</h2>
            {draft ? (
              <>
                <p className="stats">
                  {draft.masked.length.toLocaleString()} 代码单元；下方屏幕内容即下载文件内容
                  （UTF-8 无 BOM，逐字符一致）。采纳后继续调整不会改变本稿，再次采纳才更新。
                </p>
                <pre className="text-view" aria-label="已采纳下载稿">{draft.masked}</pre>
                <div className="actions">
                  <button type="button" onClick={handleDownload}>下载 redacted.txt</button>
                </div>
              </>
            ) : (
              <p className="hint">尚未采纳。采纳后可继续调整短语；后续编辑不会覆盖本稿。</p>
            )}
          </section>
        </>
      )}
    </main>
  )
}

function AddRow({ onAdd }: { onAdd: (value: string) => boolean }) {
  const [value, setValue] = useState('')
  const submit = () => {
    if (value === '') return
    // 成功才清空；非法（空串、重复、越界、换行等）时保留输入并由外层提示
    if (onAdd(value)) setValue('')
  }
  return (
    <div className="add-row">
      <input
        type="text"
        value={value}
        maxLength={LIMITS.maxPatternLength}
        placeholder="新增敏感短语（回车添加）"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button type="button" onClick={submit}>添加</button>
    </div>
  )
}

interface FlatEntry {
  entry: PatternEntry
  index: number
}

function PatternList({
  entries,
  onUpdate,
  onToggle,
  onRemove,
}: {
  entries: PatternEntry[]
  onUpdate: (index: number, value: string) => boolean
  onToggle: (index: number, enabled: boolean) => void
  onRemove: (index: number) => void
}) {
  const [filter, setFilter] = useState('')
  const [scrollTop, setScrollTop] = useState(0)

  const filtered = useMemo<FlatEntry[]>(() => {
    if (!filter) return entries.map((entry, index) => ({ entry, index }))
    const result: FlatEntry[] = []
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].value.includes(filter)) result.push({ entry: entries[i], index: i })
    }
    return result
  }, [entries, filter])

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER)
  const visibleCount = Math.ceil(VIEW_HEIGHT / ROW_HEIGHT) + 2 * BUFFER

  return (
    <div className="pattern-list">
      <input
        type="text"
        className="filter"
        placeholder="筛选短语（区分大小写）"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value)
          setScrollTop(0)
        }}
      />
      <p className="stats">
        显示 {filtered.length.toLocaleString()} / {entries.length.toLocaleString()} 条（窗口化渲染）
      </p>
      <div
        className="scroll"
        style={{ height: VIEW_HEIGHT }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: filtered.length * ROW_HEIGHT, position: 'relative' }}>
          {filtered.slice(first, first + visibleCount).map(({ entry, index }, k) => (
            <PatternRow
              key={index}
              entry={entry}
              top={(first + k) * ROW_HEIGHT}
              onUpdate={(v) => onUpdate(index, v)}
              onToggle={(en) => onToggle(index, en)}
              onRemove={() => onRemove(index)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function PatternRow({
  entry,
  top,
  onUpdate,
  onToggle,
  onRemove,
}: {
  entry: PatternEntry
  top: number
  onUpdate: (value: string) => boolean
  onToggle: (enabled: boolean) => void
  onRemove: () => void
}) {
  const [draftValue, setDraftValue] = useState(entry.value)
  const [editing, setEditing] = useState(false)

  const commit = () => {
    // 非法时外层不提交；保持编辑态和原值，便于继续修改
    if (draftValue !== entry.value && !onUpdate(draftValue)) {
      return
    }
    setEditing(false)
  }

  return (
    <div className="pattern-row" style={{ transform: `translateY(${top}px)` }}>
      <input
        type="checkbox"
        checked={entry.enabled}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label="启用"
      />
      <input
        type="text"
        className={`value ${entry.enabled ? '' : 'off'}`}
        value={editing ? draftValue : entry.value}
        maxLength={LIMITS.maxPatternLength}
        onFocus={() => {
          setDraftValue(entry.value)
          setEditing(true)
        }}
        onChange={(e) => setDraftValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraftValue(entry.value)
            setEditing(false)
          }
        }}
      />
      <button type="button" onClick={onRemove}>删除</button>
    </div>
  )
}
