/**
 * 敏感短语遮蔽核心算法。
 *
 * 代码单元语义（务必先阅读 README「代码单元语义」一节）：
 * - 合法 text 仅含 U+000A（换行）与 U+0020..U+007E（可打印 ASCII）。
 * - 这些字符在 UTF-16 中全部以单个代码单元编码，因此索引、长度、字符
 *   三者在合法输入上完全一致；代理项（surrogate）等会被判为非法输入。
 * - 匹配区分大小写；匹配不跨越换行（扫描到换行时状态回到根）。
 * - 任意短语的任一完整匹配所覆盖的代码单元全部替换为 '#'，
 *   多个匹配交叠时取覆盖位置的并集，其余代码单元原位保留。
 *
 * 性能：Aho-Corasick 自动机 + 线性两遍扫描，复杂度 O(|text| + 总长(patterns)
 * + trie 边数)，不为每个命中展开任何对象，因此命中数再多（乃至每个位置
 * 都有数十上百个嵌套命中）也不会按命中数放大内存或耗时。
 */

export const LIMITS = {
  /** text 最多二百万个 UTF-16 代码单元 */
  maxTextCodeUnits: 2_000_000,
  /** patterns 最少 1 项、最多 50000 项 */
  minPatterns: 1,
  maxPatterns: 50_000,
  /** 每个短语长 1..200 */
  minPatternLength: 1,
  maxPatternLength: 200,
  /** 全部短语长度总和不超过三十万 */
  maxTotalPatternLength: 300_000,
} as const

export const INVALID_INPUT = 'INVALID_INPUT'
export const INVALID_PATTERN = 'INVALID_PATTERN'

export class MaskError extends Error {
  readonly code: typeof INVALID_INPUT | typeof INVALID_PATTERN
  constructor(code: typeof INVALID_INPUT | typeof INVALID_PATTERN) {
    super(code)
    this.name = 'MaskError'
    this.code = code
  }
}

/** U+000A 换行；其余只允许 U+0020..U+007E。代理项等一律非法。 */
export function isAllowedTextCode(code: number): boolean {
  return code === 0x0a || (code >= 0x20 && code <= 0x7e)
}

/** 短语只能含 U+0020..U+007E（不允许换行）。 */
export function isAllowedPatternCode(code: number): boolean {
  return code >= 0x20 && code <= 0x7e
}

export interface RawInput {
  text: string
  patterns: string[]
}

/**
 * 解析并校验 JSON 输入。根对象必须且仅含 text 与 patterns 两个键。
 * 任何结构、类型、长度、字符集或重复违规都抛 INVALID_INPUT。
 */
export function parseInput(jsonText: string): RawInput {
  let data: unknown
  try {
    data = JSON.parse(jsonText)
  } catch {
    throw new MaskError(INVALID_INPUT)
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new MaskError(INVALID_INPUT)
  }
  const root = data as Record<string, unknown>
  const keys = Object.keys(root)
  if (keys.length !== 2 || !('text' in root) || !('patterns' in root)) {
    throw new MaskError(INVALID_INPUT)
  }

  const { text, patterns } = root

  if (typeof text !== 'string' || text.length > LIMITS.maxTextCodeUnits) {
    throw new MaskError(INVALID_INPUT)
  }
  for (let i = 0; i < text.length; i++) {
    if (!isAllowedTextCode(text.charCodeAt(i))) {
      throw new MaskError(INVALID_INPUT)
    }
  }

  if (!Array.isArray(patterns)) {
    throw new MaskError(INVALID_INPUT)
  }
  if (patterns.length < LIMITS.minPatterns || patterns.length > LIMITS.maxPatterns) {
    throw new MaskError(INVALID_INPUT)
  }

  let total = 0
  const seen = new Set<string>()
  for (const p of patterns) {
    if (typeof p !== 'string') {
      throw new MaskError(INVALID_INPUT)
    }
    if (p.length < LIMITS.minPatternLength || p.length > LIMITS.maxPatternLength) {
      throw new MaskError(INVALID_INPUT)
    }
    for (let i = 0; i < p.length; i++) {
      if (!isAllowedPatternCode(p.charCodeAt(i))) {
        throw new MaskError(INVALID_INPUT)
      }
    }
    total += p.length
    if (total > LIMITS.maxTotalPatternLength) {
      throw new MaskError(INVALID_INPUT)
    }
    // 短语必须互不重复（区分大小写）
    if (seen.has(p)) {
      throw new MaskError(INVALID_INPUT)
    }
    seen.add(p)
  }

  return { text, patterns: patterns as string[] }
}

/** 校验单条短语值；空串、越界长度、非法字符均判 INVALID_PATTERN。 */
export function checkPatternValue(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new MaskError(INVALID_PATTERN)
  }
  if (value.length < LIMITS.minPatternLength || value.length > LIMITS.maxPatternLength) {
    throw new MaskError(INVALID_PATTERN)
  }
  for (let i = 0; i < value.length; i++) {
    if (!isAllowedPatternCode(value.charCodeAt(i))) {
      throw new MaskError(INVALID_PATTERN)
    }
  }
}

export interface PatternEntry {
  value: string
  enabled: boolean
}

/**
 * Aho-Corasick 自动机（记忆化完成转移 / completed-goto 变体）。
 *
 * edgeMap 是 goto 表：trie 构建期只放真实边，BFS 与扫描期按需补写
 * “完成转移”（缺失边直接指向失败链结果），因此：
 *   - 键为 (state << 7) | char：字符码 ≤ 0x7e < 2^7，复合键不冲突，
 *     最大键 ((300000 << 7) | 0x7e) ≈ 3.84e7 < 2^32，安全；
 *   - 任何 (state,char) 的失败链行走至多发生一次，构建与扫描都是线性
 *     摊销（短语长 ≤ 200，递归深度也以此为界）；
 *   - 补写条目数量有界（真实边 ≤ 300001，扫描期每字符至多补写一条）。
 * 子边邻接表（head/eChar/eTo/eNext）只用于构建期按“真实出边”做 BFS，
 * 完成转移混在 edgeMap 中不影响子边枚举。节点总数 ≤ 总长(patterns)+1。
 */
interface Automaton {
  go: (state: number, charCode: number) => number
  /** 该状态沿失败链可达的最长字典词长度，0 表示无匹配（≤ 200） */
  outLen: Uint16Array
}

export function buildAutomaton(patterns: readonly string[]): Automaton {
  const maxNodes = patterns.reduce((s, p) => s + p.length, 0) + 1
  const edgeSlots = Math.max(1, maxNodes - 1)
  const head = new Int32Array(maxNodes).fill(-1)
  const eChar = new Uint16Array(edgeSlots)
  const eTo = new Int32Array(edgeSlots)
  const eNext = new Int32Array(edgeSlots).fill(-1)
  const edgeMap = new Map<number, number>()
  /** 终止于某节点的字典词长度（互不重复的模式至多一个值，保留防御） */
  const ownLen = new Uint16Array(maxNodes)
  const fail = new Int32Array(maxNodes)

  let nodeCount = 1
  let edgeCount = 0

  // ---- 构建 trie（仅真实边写入 edgeMap） ----
  for (const p of patterns) {
    let u = 0
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i)
      const key = (u << 7) | c
      let v = edgeMap.get(key)
      if (v === undefined) {
        v = nodeCount++
        edgeMap.set(key, v)
        const e = edgeCount++
        eChar[e] = c
        eTo[e] = v
        eNext[e] = head[u]
        head[u] = e
      }
      u = v
    }
    if (p.length > ownLen[u]) ownLen[u] = p.length
  }

  // ---- 记忆化完成转移：缺失边等价于沿失败链转移，只算一次 ----
  const go = (u: number, c: number): number => {
    const key = (u << 7) | c
    const cached = edgeMap.get(key)
    if (cached !== undefined) return cached
    if (u === 0) {
      edgeMap.set(key, 0)
      return 0
    }
    const r = go(fail[u], c)
    edgeMap.set(key, r)
    return r
  }

  // ---- BFS 构建失败链；outLen[u] = 本状态及其失败链上最长字典词 ----
  const outLen = new Uint16Array(nodeCount)
  const queue = new Int32Array(nodeCount)
  let qh = 0
  let qt = 0

  for (let e = head[0]; e !== -1; e = eNext[e]) {
    fail[eTo[e]] = 0
    queue[qt++] = eTo[e]
  }

  while (qh < qt) {
    const u = queue[qh++]
    outLen[u] = Math.max(ownLen[u], outLen[fail[u]])
    for (let e = head[u]; e !== -1; e = eNext[e]) {
      const v = eTo[e]
      fail[v] = go(fail[u], eChar[e])
      queue[qt++] = v
    }
  }

  return { go, outLen }
}

export interface MaskResult {
  masked: string
  /** 被遮蔽的代码单元数（覆盖并集大小，不是命中次数） */
  coveredCount: number
  /** 至少有一个短语在此代码单元处结束的位置数（诊断用，不参与遮蔽） */
  endingCount: number
}

const HASH = '#'.charCodeAt(0)
const NL = 0x0a
/** fromCharCode 分块大小，远低于各引擎参数个数上限 */
const CHUNK = 0x8000

/**
 * 从原文与当前启用的短语重算遮蔽结果。
 *
 * 线性两遍法（额外内存 O(|text|)，且不按命中数展开）：
 *   第一遍正向扫描 AC 自动机，在每个代码单元末尾记录“覆盖该位置的
 *   最长匹配长度” mark[i]（Uint16Array，短语 ≤ 200）；换行处状态回根，
 *   从语义上保证不跨换行。
 *   第二遍自右向左，把“到此结束的最长匹配”归并为覆盖并集。活跃的右侧
 *   覆盖段记为 [reach, R]（reach 为其左沿，R > i 是某个已处理位置）：
 *     - 无活跃段（reach === -1）或本段与其之间有缺口（i < reach）：
 *       另开新段，仅覆盖 [start, i]；
 *     - 相交（i ≥ reach）且向左延伸（start < reach）：补覆盖
 *       [start, reach-1]，左沿前移；
 *     - 被包含：什么也不做。
 *   每个位置至多被写入一次，整段仍是 O(n)。
 */
export function maskText(text: string, enabledPatterns: readonly string[]): MaskResult {
  const n = text.length

  if (enabledPatterns.length === 0 || n === 0) {
    return { masked: text, coveredCount: 0, endingCount: 0 }
  }

  const { go, outLen } = buildAutomaton(enabledPatterns)
  const mark = new Uint16Array(n)

  let state = 0
  let endingCount = 0
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i)
    if (c === NL) {
      state = 0
      continue
    }
    state = go(state, c)
    const len = outLen[state]
    mark[i] = len
    if (len !== 0) endingCount++
  }

  // ---- 第二遍：覆盖并集 ----
  const cover = new Uint8Array(n)
  let coveredCount = 0
  let reach = -1
  for (let i = n - 1; i >= 0; i--) {
    const len = mark[i]
    if (len === 0) continue
    const start = i - len + 1
    if (reach === -1 || i < reach) {
      for (let j = start; j <= i; j++) cover[j] = 1
      coveredCount += len
      reach = start
    } else if (start < reach) {
      for (let j = start; j < reach; j++) cover[j] = 1
      coveredCount += reach - start
      reach = start
    }
  }

  // ---- 生成结果：以 Uint16 分块 fromCharCode 避免巨型参数列表 ----
  const codes = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    codes[i] = cover[i] === 1 ? HASH : text.charCodeAt(i)
  }
  const parts: string[] = []
  for (let i = 0; i < n; i += CHUNK) {
    const slice = codes.subarray(i, Math.min(i + CHUNK, n))
    parts.push(String.fromCharCode.apply(null, slice as unknown as number[]))
  }

  return { masked: parts.join(''), coveredCount, endingCount }
}

// ---------------------------------------------------------------------------
// 短语编辑：所有变更从原文重算由调用方（页面）负责；这里只做不可变更新与
// 校验。任何违规抛 INVALID_PATTERN，且函数式语义保证调用方状态不会被部分
// 修改——“不覆盖已采纳稿”由页面在捕获异常后不提交状态实现。
// ---------------------------------------------------------------------------

function assertIndex(entries: readonly PatternEntry[], index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new MaskError(INVALID_PATTERN)
  }
}

function assertNotDuplicate(entries: readonly PatternEntry[], value: string, except?: number): void {
  // Set 查重：短语规模可达 5 万，避免连续增改时的 O(n^2)
  const values = new Set<string>()
  for (let i = 0; i < entries.length; i++) {
    if (i !== except) values.add(entries[i].value)
  }
  if (values.has(value)) throw new MaskError(INVALID_PATTERN)
}

/** 新增短语：空串/非法字符/超长/重复 → INVALID_PATTERN。 */
export function addEntry(entries: readonly PatternEntry[], value: string): PatternEntry[] {
  checkPatternValue(value)
  assertNotDuplicate(entries, value)
  return [...entries, { value, enabled: true }]
}

/** 修改短语：空串/非法字符/超长/重复/下标越界 → INVALID_PATTERN。 */
export function updateEntry(
  entries: readonly PatternEntry[],
  index: number,
  value: string,
): PatternEntry[] {
  assertIndex(entries, index)
  checkPatternValue(value)
  assertNotDuplicate(entries, value, index)
  return entries.map((e, i) => (i === index ? { ...e, value } : e))
}

/** 启用/停用单条；下标越界 → INVALID_PATTERN。 */
export function toggleEntry(
  entries: readonly PatternEntry[],
  index: number,
  enabled: boolean,
): PatternEntry[] {
  assertIndex(entries, index)
  return entries.map((e, i) => (i === index ? { ...e, enabled } : e))
}

/** 删除单条；下标越界 → INVALID_PATTERN。 */
export function removeEntry(entries: readonly PatternEntry[], index: number): PatternEntry[] {
  assertIndex(entries, index)
  return entries.filter((_, i) => i !== index)
}
